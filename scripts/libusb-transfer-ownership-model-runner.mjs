import process from 'node:process';
import {pathToFileURL} from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('missing module path');
const {default: createModule} = await import(pathToFileURL(modulePath).href);
const module = await createModule();
const words = 13;
const bytes = words * 4;
const pointer = module._malloc(bytes);
if (!Number.isSafeInteger(pointer) || pointer <= 0) throw new Error('allocation failed');
try {
  const diagnostic = module.ccall('webts_libusb_transfer_ownership_model', 'number',
    ['number', 'number'], [pointer, words]);
  const view = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset + pointer, bytes);
  const values = Array.from({length: words}, (_, index) => view.getUint32(index * 4, true));
  if (diagnostic !== 0 || values[0] !== 0 || values[1] !== 7 || values[2] !== 3 ||
      values[3] !== 5 || values[4] !== 1 || values[5] !== 1 || values[6] !== 5 ||
      values[7] !== 1 || values[8] !== 1 || values[9] !== 1 || values[10] !== 1 ||
      values[11] !== 0 || values[12] !== 1) throw new Error(`unexpected model report: ${JSON.stringify(values)}`);
  console.log(JSON.stringify({diagnostic: 'OK', scenarios: values[1], callbacksExactlyOnce: true,
    lateEventsAfterTokenFreeObserved: true, duplicateCancelHandled: true, multiplePendingHandles: true,
    naiveDoubleCallbackRegressionObserved: true, physicalWebUsbAbortProven: false}));
} finally {
  module.HEAPU8.fill(0, pointer, pointer + bytes);
  module._free(pointer);
}
