import process from 'node:process';
import {pathToFileURL} from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('missing module path');
const { default: createModule } = await import(pathToFileURL(modulePath).href);
const module = await createModule();
const words = 10;
const pointer = module._malloc(words * 4);
if (!Number.isSafeInteger(pointer) || pointer <= 0) throw new Error('allocation failed');
try {
  const diagnostic = module.ccall(
    'webts_px4_stream_lifecycle_mock', 'number', ['number', 'number'],
    [pointer, words],
  );
  const view = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset + pointer, words * 4);
  const values = Array.from({length: words}, (_, index) => view.getUint32(index * 4, true));
  if (diagnostic !== 0 || values[0] !== 0 || values[1] !== 1 || values[2] !== 188 ||
      values[3] === 0 || values[4] === 0 || values[6] !== 1 || values[7] !== 1 ||
      values[8] !== 1) throw new Error(`fixture returned an invalid fixed result: ${JSON.stringify(values)}`);
  console.log(JSON.stringify({diagnostic: 'OK', attached: true, readBytes: values[2],
    packets: values[3], bytes: values[4], finalTerminal: values[5],
    detached: true, released: true, shutdown: true}));
} finally {
  module.HEAPU8.fill(0, pointer, pointer + words * 4);
  module._free(pointer);
}
