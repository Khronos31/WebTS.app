import { loadGeneratedLibusbModule } from './wasm-loader';
import { loadGeneratedSianoLiveStatsModule, loadGeneratedSianoTsQueueModule } from './wasm-loader';
import {
  getWorkerWebUsbSource,
  runWorkerEnumeration,
  type WorkerEnumerationRequest,
  type WorkerEnumerationResponse,
} from './webusb-worker-diagnostic';
import { runSianoLiveStatsMock } from './siano-live-stats-diagnostic';
import { runSianoTsQueueMock } from './siano-ts-queue-diagnostic';
import {
  fixedReport,
  type SianoWorkerRequest,
  type SianoWorkerResponse,
} from './siano-worker-diagnostic';

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerEnumerationRequest | SianoWorkerRequest>) => void) | null;
  postMessage(message: WorkerEnumerationResponse | SianoWorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onmessage = async (event) => {
  if (!event.data || event.data.type !== 'enumerate-authorized') return;
  const report = await runWorkerEnumeration(
    getWorkerWebUsbSource(),
    () => loadGeneratedLibusbModule(event.data.moduleUrl),
  );
  scope.postMessage({ type: 'enumeration-result', report });
};

const previousHandler = scope.onmessage;
scope.onmessage = async (event) => {
  if (event.data?.type !== 'siano-fixture') {
    await previousHandler?.(event as MessageEvent<WorkerEnumerationRequest>);
    return;
  }
  const { kind, scenario, moduleUrl } = event.data;
  if (kind === 'QUEUE') {
    const queue = await runSianoTsQueueMock(
      () => loadGeneratedSianoTsQueueModule(moduleUrl), scenario,
    );
    scope.postMessage({
      type: 'siano-fixture-result',
      report: { ...fixedReport(mapFixtureDiagnostic(queue.diagnostic), kind, scenario),
        diagnostic: mapFixtureDiagnostic(queue.diagnostic), queue },
    });
    return;
  }
  if (kind === 'LIVE_STATS') {
    const liveStats = await runSianoLiveStatsMock(
      () => loadGeneratedSianoLiveStatsModule(moduleUrl), scenario,
    );
    scope.postMessage({
      type: 'siano-fixture-result',
      report: { ...fixedReport(mapFixtureDiagnostic(liveStats.diagnostic), kind, scenario),
        diagnostic: mapFixtureDiagnostic(liveStats.diagnostic), liveStats },
    });
    return;
  }
  scope.postMessage({ type: 'siano-fixture-result', report: fixedReport('INVALID_ARGUMENT', 'QUEUE', scenario) });
};

function mapFixtureDiagnostic(value: string): 'OK' | 'INVALID_ARGUMENT' | 'INTERNAL' {
  if (value === 'OK') return 'OK';
  if (value === 'INVALID_ARGUMENT') return 'INVALID_ARGUMENT';
  return 'INTERNAL';
}
