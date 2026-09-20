/*
 * Build-only smoke entry point for the unmodified libusb Emscripten backend.
 * It performs no device enumeration or WebUSB operation.
 */
#include <libusb.h>

int main(void)
{
	libusb_context *context = NULL;
	const int status = libusb_init(&context);
	if (context != NULL)
		libusb_exit(context);
	return status == 0 ? 0 : 1;
}
