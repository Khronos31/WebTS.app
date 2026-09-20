import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('module path is required');
const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();
const packed = (await module.ccall(
  'webts_libusb_webusb_pending_close_regression', 'number', [], [], { async: true },
)) >>> 0;
if ((packed & 0xff000000) === 0xff000000) {
  throw new Error(`pending-close harness failed with fixed code 0x${packed.toString(16)}`);
}
const callbacks = packed & 0xff;
const status = (packed >>> 8) & 0xff;
const closeReturned = ((packed >>> 16) & 0xff) === 1;
const fakeTransferInCalls = (packed >>> 24) & 0xff;
const report = {
  diagnostic: callbacks === 0 && status === 255 && closeReturned && fakeTransferInCalls === 1
    ? 'OBSERVED' : 'FAILED',
  callbacks,
  status,
  closeReturned,
  fakeTransferInCalls,
  promiseSettlementObserved: false,
  physicalAbortProven: false,
};
if (report.diagnostic !== 'OBSERVED') throw new Error(JSON.stringify(report));
console.log(JSON.stringify(report));
