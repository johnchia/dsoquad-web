# DSO Quad web-control firmware (APP1).
#   make            build build/dsoq_app1.hex
#   make flash      flash it (DSO must be in DFU mode: hold >|| at power-on)

TARGET  := build/dsoq_app1
LIB     := ../lib
TUSB    := $(LIB)/tinyusb/src

CROSS   := arm-none-eabi-
CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy
SIZE    := $(CROSS)size

SRCS := src/startup.c src/escape.c src/main.c src/usb_descriptors.c src/proto.c src/scope.c \
        $(TUSB)/tusb.c $(TUSB)/common/tusb_fifo.c \
        $(TUSB)/device/usbd.c \
        $(TUSB)/class/cdc/cdc_device.c \
        $(TUSB)/portable/st/stm32_fsdev/dcd_stm32_fsdev.c \
        $(TUSB)/portable/st/stm32_fsdev/fsdev_common.c
ASRCS := sys/BIOS.S

ARCH    := -mcpu=cortex-m3 -mthumb -msoft-float
CFLAGS  := $(ARCH) -Os -g -std=gnu11 -Wall -Wextra -Wno-unused-parameter \
           -ffunction-sections -fdata-sections -fno-common \
           -DSTM32F103xE \
           -Isrc -Isys -I$(TUSB) \
           -I$(LIB)/cmsis-device-f1/Include -I$(LIB)/CMSIS_5/CMSIS/Core/Include
LDFLAGS := $(ARCH) -nostartfiles -T app1.ld -Wl,--gc-sections -Wl,-Map=$(TARGET).map \
           --specs=nano.specs --specs=nosys.specs

OBJS := $(patsubst %.c,build/obj/%.o,$(notdir $(SRCS))) build/obj/BIOS.o
vpath %.c $(sort $(dir $(SRCS)))

all: $(TARGET).hex

build/obj:
	mkdir -p $@

build/obj/%.o: %.c | build/obj
	$(CC) $(CFLAGS) -MMD -c $< -o $@

build/obj/BIOS.o: sys/BIOS.S | build/obj
	$(CC) $(ARCH) -c $< -o $@

$(TARGET).elf: $(OBJS) app1.ld
	$(CC) $(LDFLAGS) -o $@ $(OBJS)
	$(SIZE) $@

$(TARGET).hex: $(TARGET).elf
	$(OBJCOPY) -O ihex --remove-section=.bios $< $@
	../../tools/hexrange.py $@

flash: $(TARGET).hex
	../../tools/dfu-flash.sh $<

clean:
	rm -rf build

-include build/obj/*.d
.PHONY: all flash clean
