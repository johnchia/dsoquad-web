#include <string.h>
#include "tusb.h"
#include "sys.h"

#define USB_VID 0x1209  // pid.codes
#define USB_PID 0x0001  // pid.codes test PID (kept by the owner: personal-use project)
#define USB_BCD 0x0200

static const tusb_desc_device_t desc_device = {
  .bLength            = sizeof(tusb_desc_device_t),
  .bDescriptorType    = TUSB_DESC_DEVICE,
  .bcdUSB             = USB_BCD,
  // IAD so Windows binds usbser.sys to the CDC pair.
  .bDeviceClass       = TUSB_CLASS_MISC,
  .bDeviceSubClass    = MISC_SUBCLASS_COMMON,
  .bDeviceProtocol    = MISC_PROTOCOL_IAD,
  .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,
  .idVendor           = USB_VID,
  .idProduct          = USB_PID,
  .bcdDevice          = 0x0001,
  .iManufacturer      = 1,
  .iProduct           = 2,
  .iSerialNumber      = 3,
  .bNumConfigurations = 1,
};

uint8_t const *tud_descriptor_device_cb(void)
{
  return (uint8_t const *)&desc_device;
}

enum { ITF_NUM_CDC = 0, ITF_NUM_CDC_DATA, ITF_NUM_TOTAL };

#define EPNUM_CDC_NOTIF 0x81
#define EPNUM_CDC_OUT   0x02
#define EPNUM_CDC_IN    0x82
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN)

static const uint8_t desc_configuration[] = {
  TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
  TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8, EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
};

uint8_t const *tud_descriptor_configuration_cb(uint8_t index)
{
  (void)index;
  return desc_configuration;
}

static const char *const string_desc[] = {
  NULL,  // 0: language, handled below
  "DSO Quad community",
  "DSO Quad Web Control",
  NULL,  // 3: serial, from the device serial number
  "DSO Quad Control Port",
};

static uint16_t desc_str[33];

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
  (void)langid;
  char buf[9];
  const char *str;
  size_t n;

  if (index == 0) {
    desc_str[1] = 0x0409;
    n = 1;
  } else {
    if (index == 3) {
      static const char hex[] = "0123456789ABCDEF";
      uint32_t sn = __GetDev_SN();
      for (int i = 0; i < 8; i++) buf[i] = hex[(sn >> (28 - 4 * i)) & 0xF];
      buf[8] = 0;
      str = buf;
    } else if (index < sizeof(string_desc) / sizeof(string_desc[0])) {
      str = string_desc[index];
    } else {
      return NULL;
    }
    n = strlen(str);
    if (n > 32) n = 32;
    for (size_t i = 0; i < n; i++) desc_str[1 + i] = (uint8_t)str[i];
  }
  desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * n + 2));
  return desc_str;
}
