// Wave generator: square wave from TIM4 (through SYS) or an arbitrary waveform from the DAC.
// The host computes the waveform (sine, triangle, ...) and uploads it as a table; the DAC plays
// it via DMA2 channel 4, paced by TIM7 update events. We program TIM7/DMA/DAC directly: stock
// SYS 1.52 can't set TIM7's prescaler (only Marco Sinatti's modified SYS has ANALOG_PSC).
#include "gen.h"
#include "scope.h"
#include "stm32f1xx.h"
#include "sys.h"

#define TIMER_HZ 72000000u

static uint16_t wave[GEN_WAVE_MAX];
static uint16_t wave_len;
static uint32_t square_arr = 0xFFFF;  // TIM4 ARR last programmed
// PB6 (TIM4_CH1, the square output) and the DAC drive the same wave-out node. PB6 idles as a
// push-pull output that holds the node down, so in analog mode it's made an input (measured:
// the DAC's full swing is 0.07-2.70 V that way, but only ~0.25 V with PB6 driving).
static uint32_t pb6_cfg = 0xFFFFFFFF;  // SYS's PB6 CRL nibble, saved on first use
uint16_t gen_psc, gen_arr;

// Largest psc/arr pair for `hz` updates per second (rounded to nearest).
static void timer_div(uint32_t hz, uint32_t *psc, uint32_t *arr)
{
  uint32_t p = (TIMER_HZ / 65536) / hz;
  uint32_t a = (TIMER_HZ / (p + 1) + hz / 2) / hz;
  if (a < 2) a = 2;
  if (a > 65536) a = 65536;
  *psc = p;
  *arr = a - 1;
}

static void pb6_float(int on)
{
  uint32_t crl = GPIOB->CRL;
  if (pb6_cfg == 0xFFFFFFFF) pb6_cfg = (crl >> 24) & 0xF;
  GPIOB->CRL = (crl & ~(0xFu << 24)) | ((on ? 0x4u : pb6_cfg) << 24);  // 0x4: floating input
}

static void analog_stop(void)
{
  DMA2_Channel4->CCR &= ~DMA_CCR_EN;
  TIM7->CR1 &= ~TIM_CR1_CEN;
  DAC->DHR12R1 = 0;  // DAC channel 1 holds 0 V
}

static void square_idle(void)
{
  // The output is inverted: CCR = ARR+1 holds it idle (as the stock app does for "off").
  __Set(SYS_DIGTAL_CCR, square_arr + 1);
}

static void analog_start(uint32_t psc, uint32_t arr)
{
  RCC->AHBENR |= RCC_AHBENR_DMA2EN;
  RCC->APB1ENR |= RCC_APB1ENR_TIM7EN | RCC_APB1ENR_DACEN;
  RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;
  GPIOA->CRL &= ~(0xFu << 16);  // PA4 analog mode (DAC_OUT1)
  DAC->CR |= DAC_CR_EN1;        // no trigger: DHR goes straight to the output

  DMA2_Channel4->CCR &= ~DMA_CCR_EN;
  DMA2_Channel4->CPAR = (uint32_t)&DAC->DHR12R1;
  DMA2_Channel4->CMAR = (uint32_t)wave;
  DMA2_Channel4->CNDTR = wave_len;
  // Memory -> peripheral, circular, memory increment, 16-bit both sides, very high priority.
  DMA2_Channel4->CCR = DMA_CCR_DIR | DMA_CCR_CIRC | DMA_CCR_MINC | DMA_CCR_PSIZE_0 | DMA_CCR_MSIZE_0 | DMA_CCR_PL;
  DMA2_Channel4->CCR |= DMA_CCR_EN;

  TIM7->CR1 = 0;
  TIM7->PSC = psc;
  TIM7->ARR = arr;
  TIM7->DIER = TIM_DIER_UDE;  // update event -> DMA2 channel 4 request
  TIM7->EGR = TIM_EGR_UG;     // load PSC now
  TIM7->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
}

int gen_set_wave(const uint8_t *b, size_t n)
{
  if (n % 2 || n / 2 < 2 || n / 2 > GEN_WAVE_MAX) return -1;
  for (size_t i = 0; i < n; i += 2) if ((b[i] | b[i + 1] << 8) > 4095) return -1;
  // Stop the DMA while the table changes; gen_set() restarts it with the new length.
  int was_running = scope.gen_mode == GEN_ANALOG;
  if (was_running) DMA2_Channel4->CCR &= ~DMA_CCR_EN;
  wave_len = (uint16_t)(n / 2);
  for (size_t i = 0; i < wave_len; i++) wave[i] = (uint16_t)(b[2 * i] | b[2 * i + 1] << 8);
  if (was_running) return gen_set(GEN_ANALOG, scope.gen_freq, scope.gen_duty);
  return 0;
}

uint16_t gen_wave_len(void) { return wave_len; }

int gen_set(uint8_t mode, uint32_t freq_hz, uint8_t duty)
{
  if (mode > GEN_ANALOG || duty > 100) return -1;
  if (freq_hz == 0) freq_hz = 1000;
  uint32_t psc, arr;
  if (mode == GEN_ANALOG) {
    if (wave_len < 2 || freq_hz > GEN_DAC_MAX_RATE / wave_len) return -1;
    timer_div(freq_hz * wave_len, &psc, &arr);
  } else {
    if (mode == GEN_SQUARE && freq_hz > 8000000) return -1;
    psc = (TIMER_HZ / 65536) / freq_hz;
    arr = (TIMER_HZ / (psc + 1) + freq_hz / 2) / freq_hz - 1;
    if (arr < 1) arr = 1;
  }
  scope.gen_mode = mode;
  scope.gen_freq = freq_hz;
  scope.gen_duty = duty;

  if (mode == GEN_ANALOG) {
    square_idle();
    pb6_float(1);
    analog_start(psc, arr);
  } else {
    analog_stop();
    pb6_float(0);
    __Set(SYS_DIGTAL_PSC, psc);
    __Set(SYS_DIGTAL_ARR, arr);
    square_arr = arr;
    __Set(SYS_DIGTAL_CCR, mode == GEN_OFF ? arr + 1 : ((arr + 1) * (100u - duty)) / 100u);
  }
  gen_psc = (uint16_t)psc;
  gen_arr = (uint16_t)arr;
  return 0;
}
