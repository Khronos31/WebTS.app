/**
 * Offline PX4 identity/grouping seam. The generated module calls vendored
 * group_q3u4_devices() with synthetic observations; it never touches USB.
 */

export interface Px4GroupingModule {
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export type Px4GroupingDiagnostic =
  | 'OK'
  | 'INVALID_ARGUMENT'
  | 'VERSION_MISMATCH'
  | 'NOT_FOUND'
  | 'BUSY'
  | 'NOT_READY'
  | 'TIMEOUT'
  | 'USB_IO'
  | 'DISCONNECTED'
  | 'PROTOCOL_ERROR'
  | 'FIRMWARE_REJECTED'
  | 'UNSUPPORTED'
  | 'NO_CARD'
  | 'CARD_REMOVED'
  | 'BUFFER_TOO_SMALL'
  | 'SLOW_CONSUMER'
  | 'INTERNAL'
  | 'UNKNOWN';

export interface Px4GroupingReport {
  readonly diagnostic: Px4GroupingDiagnostic;
  readonly candidateCount: number;
  readonly readyGroupCount: number;
  readonly incompleteGroupCount: number;
}

const diagnostics: readonly Px4GroupingDiagnostic[] = [
  'OK', 'INVALID_ARGUMENT', 'VERSION_MISMATCH', 'NOT_FOUND', 'BUSY',
  'NOT_READY', 'TIMEOUT', 'USB_IO', 'DISCONNECTED', 'PROTOCOL_ERROR',
  'FIRMWARE_REJECTED', 'UNSUPPORTED', 'NO_CARD', 'CARD_REMOVED',
  'BUFFER_TOO_SMALL', 'SLOW_CONSUMER',
];

/** Runs one of the fixed synthetic identity scenarios through upstream C++. */
export async function runPx4GroupingMockScenario(
  moduleFactory: () => Px4GroupingModule | Promise<Px4GroupingModule>,
  scenario: number,
): Promise<Px4GroupingReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 3) {
    return Object.freeze({
      diagnostic: 'INVALID_ARGUMENT',
      candidateCount: 0,
      readyGroupCount: 0,
      incompleteGroupCount: 0,
    });
  }
  let module: Px4GroupingModule;
  try {
    module = await moduleFactory();
  } catch {
    return fixedFailure('INTERNAL');
  }
  if (!module || typeof module.ccall !== 'function') return fixedFailure('INTERNAL');

  let packed: number;
  try {
    packed = await module.ccall(
      'webts_px4_grouping_mock_summary',
      'number',
      ['number'],
      [scenario],
      { async: true },
    );
  } catch {
    return fixedFailure('INTERNAL');
  }
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0xffffffff) {
    return fixedFailure('INTERNAL');
  }
  return Object.freeze({
    diagnostic: (packed & 0xff) === 0xff
      ? 'INTERNAL'
      : (diagnostics[packed & 0xff] ?? 'UNKNOWN'),
    candidateCount: (packed >>> 8) & 0xff,
    readyGroupCount: (packed >>> 16) & 0xff,
    incompleteGroupCount: (packed >>> 24) & 0xff,
  });
}

function fixedFailure(diagnostic: Px4GroupingDiagnostic): Px4GroupingReport {
  return Object.freeze({ diagnostic, candidateCount: 0, readyGroupCount: 0, incompleteGroupCount: 0 });
}
