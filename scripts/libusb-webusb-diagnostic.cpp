/* Build-only diagnostic shim around the unmodified libusb public API.
 * It enumerates already-authorized WebUSB devices and returns VID/PID pairs.
 * It does not issue writes, claims, bulk/stream transfers, logs, or retain
 * device data itself. The official libusb WebUSB backend may temporarily open
 * devices and issue standard descriptor control-IN requests while servicing
 * libusb_get_device_list().
 */
#include <libusb.h>
#include <emscripten.h>

#include <cstdint>
#include <cstring>

namespace {

enum WebTsLibusbDiagnostic : int {
	WEBTS_DIAGNOSTIC_NONE = 0,
	WEBTS_DIAGNOSTIC_IO = 1,
	WEBTS_DIAGNOSTIC_INVALID_PARAM = 2,
	WEBTS_DIAGNOSTIC_ACCESS = 3,
	WEBTS_DIAGNOSTIC_NO_DEVICE = 4,
	WEBTS_DIAGNOSTIC_NOT_FOUND = 5,
	WEBTS_DIAGNOSTIC_BUSY = 6,
	WEBTS_DIAGNOSTIC_TIMEOUT = 7,
	WEBTS_DIAGNOSTIC_OVERFLOW = 8,
	WEBTS_DIAGNOSTIC_PIPE = 9,
	WEBTS_DIAGNOSTIC_INTERRUPTED = 10,
	WEBTS_DIAGNOSTIC_NO_MEM = 11,
	WEBTS_DIAGNOSTIC_NOT_SUPPORTED = 12,
	WEBTS_DIAGNOSTIC_OTHER = 13,
	WEBTS_DIAGNOSTIC_UNKNOWN = 255,
};

static int last_diagnostic = WEBTS_DIAGNOSTIC_NONE;

static void capture_libusb_log(
	libusb_context *, enum libusb_log_level, const char *message)
{
	// libusb formats the message before this callback. Classify only its fixed
	// public error token; never forward or retain the raw text.
	if (message == nullptr) {
		last_diagnostic = WEBTS_DIAGNOSTIC_UNKNOWN;
		return;
	}
	struct ErrorToken {
		const char *name;
		int code;
	};
	static constexpr ErrorToken tokens[] = {
		{"LIBUSB_ERROR_INVALID_PARAM", WEBTS_DIAGNOSTIC_INVALID_PARAM},
		{"LIBUSB_ERROR_ACCESS", WEBTS_DIAGNOSTIC_ACCESS},
		{"LIBUSB_ERROR_NO_DEVICE", WEBTS_DIAGNOSTIC_NO_DEVICE},
		{"LIBUSB_ERROR_NOT_FOUND", WEBTS_DIAGNOSTIC_NOT_FOUND},
		{"LIBUSB_ERROR_BUSY", WEBTS_DIAGNOSTIC_BUSY},
		{"LIBUSB_ERROR_TIMEOUT", WEBTS_DIAGNOSTIC_TIMEOUT},
		{"LIBUSB_ERROR_OVERFLOW", WEBTS_DIAGNOSTIC_OVERFLOW},
		{"LIBUSB_ERROR_PIPE", WEBTS_DIAGNOSTIC_PIPE},
		{"LIBUSB_ERROR_INTERRUPTED", WEBTS_DIAGNOSTIC_INTERRUPTED},
		{"LIBUSB_ERROR_NO_MEM", WEBTS_DIAGNOSTIC_NO_MEM},
		{"LIBUSB_ERROR_NOT_SUPPORTED", WEBTS_DIAGNOSTIC_NOT_SUPPORTED},
		{"LIBUSB_ERROR_IO", WEBTS_DIAGNOSTIC_IO},
		{"LIBUSB_ERROR_OTHER", WEBTS_DIAGNOSTIC_OTHER},
	};
	for (const auto &token : tokens) {
		if (std::strstr(message, token.name) != nullptr) {
			last_diagnostic = token.code;
			return;
		}
	}
	last_diagnostic = WEBTS_DIAGNOSTIC_UNKNOWN;
}

} // namespace

// This probes only the WebUSB permission list. getDevices() itself does not
// open a device; descriptor reads remain exclusively in libusb enumeration.
EM_ASYNC_JS(int, webts_libusb_get_webusb_device_count, (), {
	if (typeof navigator === 'undefined' || !navigator.usb ||
		typeof navigator.usb.getDevices !== 'function') {
		return -2;
	}
	try {
		const devices = await navigator.usb.getDevices();
		return Array.isArray(devices) ? devices.length : -3;
	} catch (_) {
		return -1;
	}
});

EM_JS(int, webts_libusb_get_execution_context, (), {
	if (typeof window !== 'undefined' && typeof document !== 'undefined') return 1;
	if (typeof DedicatedWorkerGlobalScope !== 'undefined' &&
		self instanceof DedicatedWorkerGlobalScope) return 2;
	if (typeof WorkerGlobalScope !== 'undefined' &&
		self instanceof WorkerGlobalScope) return 3;
	if (typeof navigator === 'undefined') return 4;
	return 0;
});

extern "C" int webts_libusb_probe_webusb_device_count()
{
	return webts_libusb_get_webusb_device_count();
}

extern "C" int webts_libusb_probe_execution_context()
{
	return webts_libusb_get_execution_context();
}

extern "C" int webts_libusb_enumerate(std::uint32_t *output, int capacity)
{
	last_diagnostic = WEBTS_DIAGNOSTIC_NONE;
	if (output == nullptr || capacity < 0)
		return -2;

	// Install the global sink before init so even initialization diagnostics are
	// classified without reaching stderr. The callback retains no raw text.
	libusb_set_log_cb(nullptr, capture_libusb_log, LIBUSB_LOG_CB_GLOBAL);
	libusb_context *context = nullptr;
	if (libusb_init(&context) != 0) {
		last_diagnostic = WEBTS_DIAGNOSTIC_UNKNOWN;
		return -1;
	}
	// Enable only error-level callbacks; the callback itself emits no text.
	libusb_set_option(context, LIBUSB_OPTION_LOG_LEVEL, LIBUSB_LOG_LEVEL_ERROR);

	libusb_device **devices = nullptr;
	const ssize_t count = libusb_get_device_list(context, &devices);
	if (count < 0) {
		last_diagnostic = WEBTS_DIAGNOSTIC_UNKNOWN;
		libusb_exit(context);
		return -1;
	}

	int written = 0;
	for (ssize_t index = 0; index < count && written < capacity; ++index) {
		libusb_device_descriptor descriptor{};
		if (libusb_get_device_descriptor(devices[index], &descriptor) == 0) {
			output[written++] = (static_cast<std::uint32_t>(descriptor.idVendor) << 16U) |
				static_cast<std::uint32_t>(descriptor.idProduct);
		}
	}

	libusb_free_device_list(devices, 1);
	libusb_exit(context);
	return written;
}

extern "C" int webts_libusb_get_last_diagnostic()
{
	return last_diagnostic;
}
