// Isolated single-scenario runner for the libusb transfer-ownership
// regression. One child process per scenario: an unmet expectation parks
// libusb state on purpose, so the module instance must not be reused.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv[2];
const scenario = Number.parseInt(process.argv[3] ?? '', 10);
if (!modulePath) throw new Error('module path is required');
if (!Number.isInteger(scenario) || scenario < 0) throw new Error('scenario index is required');

const WORDS = 20;
const DIAGNOSTICS = ['OK', 'DIVERGED', 'UNKNOWN_SCENARIO', 'INVALID_OUTPUT',
  'SETUP_FAILED', 'HARNESS_FAILED'];
const FIELDS = ['scenario', 'stage', 'callbackCount', 'callbackStatus',
  'cancelReturn', 'secondCancelReturn', 'eventResult', 'privConstructed',
  'privDestroyed', 'logicalSignals', 'lateAfterDetach', 'lateAfterSettle',
  'freedInCallback', 'secondHandleClosed', 'callbackCountB', 'callbackStatusB',
  'transferredBytes', 'suppressedConsoleErrors', 'fakeTransferInCalls',
  'physicalAbortProven'];

const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();
const pointer = module._malloc(WORDS * 4);
if (!Number.isSafeInteger(pointer) || pointer <= 0) throw new Error('allocation failed');
let report;
try {
  const diagnostic = await module.ccall(
    'webts_libusb_ownership_regression', 'number', ['number', 'number', 'number'],
    [scenario, pointer, WORDS], { async: true });
  const view = new DataView(module.HEAPU8.buffer, module.HEAPU8.byteOffset + pointer, WORDS * 4);
  report = { diagnostic: DIAGNOSTICS[diagnostic] ?? `UNEXPECTED_${diagnostic}` };
  for (let index = 0; index < WORDS; index += 1) {
    report[FIELDS[index]] = view.getInt32(index * 4, true);
  }
  report.physicalAbortProven = false;
} finally {
  module.HEAPU8.fill(0, pointer, pointer + WORDS * 4);
  module._free(pointer);
}
console.log(JSON.stringify(report));
