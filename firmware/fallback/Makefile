# Builds the DSO203 GCC Community Edition APP (pmos69/dso203_gcc) for a chosen slot.
# Used as the standalone fallback scope in APP3 (hold button 3 at power-on).
#
#   make fetch            # clone the pinned upstream source into ref/dso203_gcc
#   make                  # build build/APP_G251_3.hex (slot 3)
#   make SLOT=1           # build for slot 1 (restore image)

UPSTREAM  := https://github.com/pmos69/dso203_gcc.git
PIN       := c78c0dc5c1abf9648c31c2e145fbec6ade8c5f03
SRC       ?= ../../ref/dso203_gcc
SLOT      ?= 3
BUILD     := build/slot$(SLOT)
TARGET    := $(BUILD)/APP_G251_$(SLOT)

CROSS     := arm-none-eabi-
CC        := $(CROSS)gcc
OBJCOPY   := $(CROSS)objcopy
SIZE      := $(CROSS)size

CFLAGS    := -Os -fno-common -mcpu=cortex-m3 -mthumb -msoft-float -fomit-frame-pointer \
             -std=gnu89 -w \
             -I$(SRC)/FWLib/inc -I$(SRC)/App/inc -I$(SRC)/App/src
AFLAGS    := -mcpu=cortex-m3 -mthumb
LDFLAGS   := -nostartfiles -mcpu=cortex-m3 -mthumb -msoft-float

APP_SRCS  := Calibrat Draw Files Function Interrupt Main Menu Process startup
OBJS      := $(addprefix $(BUILD)/,$(addsuffix .o,$(APP_SRCS)) stm32f10x_nvic.o cortexm3_macro.o BIOS.o)

all: $(TARGET).hex

fetch:
	@test -d $(SRC) || git clone -q $(UPSTREAM) $(SRC)
	cd $(SRC) && git fetch -q --depth 1 origin $(PIN) && git checkout -q $(PIN)

$(BUILD):
	mkdir -p $@

$(BUILD)/%.o: $(SRC)/App/src/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/stm32f10x_nvic.o: $(SRC)/FWLib/src/stm32f10x_nvic.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

# Modern binutils needs Thumb function labels marked explicitly (old CodeSourcery didn't).
$(BUILD)/cortexm3_macro.o: $(SRC)/FWLib/asm/cortexm3_macro.s | $(BUILD)
	tr -d '\r' < $< | sed -E 's/^(__[A-Za-z_]+:)/.thumb_func\n\1/' > $(BUILD)/cortexm3_macro.s
	$(CC) $(AFLAGS) -c $(BUILD)/cortexm3_macro.s -o $@

$(BUILD)/BIOS.o: $(SRC)/App/asm/BIOS.S | $(BUILD)
	$(CC) $(AFLAGS) -c $< -o $@

# Upstream scripts assume a case-insensitive filesystem; fix the INCLUDE path.
$(BUILD)/app.lds: $(SRC)/App/lds/app$(SLOT).lds $(SRC)/App/lds/main.lds | $(BUILD)
	sed 's|INCLUDE .*main.lds|INCLUDE main.lds|' $< | tr -d '\r' > $@
	tr -d '\r' < $(SRC)/App/lds/main.lds > $(BUILD)/main.lds

$(TARGET).elf: $(OBJS) $(BUILD)/app.lds
	cd $(BUILD) && $(CC) -o $(notdir $@) $(LDFLAGS) -Wl,-Map=$(notdir $(TARGET)).map -T app.lds $(notdir $(OBJS))
	$(SIZE) $@

$(TARGET).hex: $(TARGET).elf
	$(OBJCOPY) -O ihex $< $@
	../../tools/hexrange.py $@

clean:
	rm -rf build

.PHONY: all fetch clean
