import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('module path is required');
const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();
const packed = await module.ccall('webts_libusb_webusb_cancel_regression', 'number', [], [], {
  async: true,
});
const unsigned = packed >>> 0;
if ((unsigned & 0xff000000) === 0xff000000) {
  throw new Error(`harness failed with fixed code 0x${unsigned.toString(16)}`);
}
const callbacksBeforeSettle = unsigned & 0xff;
const callbacksAfterSettle = (unsigned >>> 8) & 0xff;
const finalStatus = (unsigned >>> 16) & 0xff;
const cancelReturn = ((unsigned >>> 24) & 0xff) - 16;
const report = {
  diagnostic: callbacksBeforeSettle === 0 && callbacksAfterSettle === 0 &&
      finalStatus === 255 && cancelReturn === 0 ? 'OBSERVED' : 'FAILED',
  backendCancelReturn: cancelReturn,
  callbacksBeforePromiseSettlement: callbacksBeforeSettle,
  callbacksAfterTaskTurnWithoutPromiseSettlement: callbacksAfterSettle,
  transferStatusWhilePromisePending: finalStatus,
  fakeTransferInCalls: 1,
  cancelDidNotSettleWithinTaskTurn: true,
  fakePromiseStillPending: true,
  physicalAbortProven: false,
};
if (report.diagnostic !== 'OBSERVED') {
  throw new Error(JSON.stringify(report));
}
console.log(JSON.stringify(report));
process.exit(0);
