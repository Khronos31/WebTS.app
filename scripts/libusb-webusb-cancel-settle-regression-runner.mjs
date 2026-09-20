import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('module path is required');
const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();

function decode(packed, mode) {
  const unsigned = packed >>> 0;
  if ((unsigned & 0xff000000) === 0xff000000) {
    throw new Error(`settle harness failed for ${mode} with fixed code 0x${unsigned.toString(16)}`);
  }
  const callbacks = unsigned & 0xff;
  const status = (unsigned >>> 8) & 0xff;
  const eventResult = ((unsigned >>> 16) & 0xff) - 16;
  const cancelReturn = ((unsigned >>> 24) & 0xff) - 16;
  const report = {
    mode,
    diagnostic: callbacks === 1 && status === 3 && eventResult === 0 && cancelReturn === 0
      ? 'OBSERVED' : 'FAILED',
    callbackCount: callbacks,
    callbackStatus: status,
    eventResult,
    backendCancelReturn: cancelReturn,
    physicalAbortProven: false,
  };
  if (report.diagnostic !== 'OBSERVED') throw new Error(JSON.stringify(report));
  return report;
}

const resolved = await module.ccall(
  'webts_libusb_webusb_cancel_settle_regression', 'number', [], [], { async: true });
console.log(JSON.stringify({ diagnostic: 'OBSERVED', resolved: decode(resolved, 'resolve') }));
