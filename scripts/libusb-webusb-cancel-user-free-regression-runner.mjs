import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('module path is required');
const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();
const packed = (await module.ccall(
  'webts_libusb_webusb_cancel_user_free_regression', 'number', [], [], { async: true },
)) >>> 0;
if ((packed & 0xff000000) === 0xff000000) {
  throw new Error(`user-free harness failed with fixed code 0x${packed.toString(16)}`);
}
const callbacks = packed & 0xff;
const status = (packed >>> 8) & 0xff;
const eventResult = ((packed >>> 16) & 0xff) - 16;
const cancelByte = (packed >>> 24) & 0xff;
const backendCancelReturn = (cancelByte & 0x7f) - 16;
const freedInCallback = (cancelByte & 0x80) !== 0;
const report = {
  diagnostic: callbacks === 1 && status === 3 && eventResult === 0 &&
    backendCancelReturn === 0 && freedInCallback ? 'OBSERVED' : 'FAILED',
  callbackCount: callbacks,
  callbackStatus: status,
  eventResult,
  backendCancelReturn,
  freedInCallback,
  physicalAbortProven: false,
};
if (report.diagnostic !== 'OBSERVED') throw new Error(JSON.stringify(report));
console.log(JSON.stringify(report));
