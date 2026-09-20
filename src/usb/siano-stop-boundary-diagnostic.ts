/**
 * Fixed ABI for the Siano release-first stop policy fixture.
 *
 * The generated module is deliberately not a device API: the fixture has no
 * libusb/WebUSB handle and only exercises ordering and cleanup decisions with
 * synthetic state.  A future real adapter must preserve this fixed-code
 * boundary and separately prove that the browser backend settles transfers.
 */
export interface SianoStopBoundaryModule {
  ccall(
    name: 'webts_siano_release_first_stop_mock',
    returnType: 'number',
    argTypes: readonly ['number'],
    args: readonly [number],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export type SianoStopBoundaryDiagnostic =
  | 'OK'
  | 'RELEASE_FAILED'
  | 'PENDING_NOT_SETTLED'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

export interface SianoStopBoundaryReport {
  readonly diagnostic: SianoStopBoundaryDiagnostic;
}

const DIAGNOSTICS: readonly SianoStopBoundaryDiagnostic[] = [
  'OK',
  'RELEASE_FAILED',
  'PENDING_NOT_SETTLED',
  'INVALID_ARGUMENT',
  'INTERNAL',
];

/**
 * Runs one offline stop-policy scenario through Emscripten's Asyncify ccall.
 * Invalid scenarios are rejected before module loading/calling.  Exceptions
 * and unknown native codes are intentionally reduced to INTERNAL.
 */
export async function runSianoStopBoundaryMock(
  moduleFactory: () => SianoStopBoundaryModule | Promise<SianoStopBoundaryModule>,
  scenario: number,
): Promise<SianoStopBoundaryReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 3) {
    return Object.freeze({ diagnostic: 'INVALID_ARGUMENT' });
  }

  let module: SianoStopBoundaryModule;
  try {
    module = await moduleFactory();
  } catch {
    return fixedFailure();
  }
  if (!module || typeof module.ccall !== 'function') return fixedFailure();

  try {
    const raw = await module.ccall(
      'webts_siano_release_first_stop_mock',
      'number',
      ['number'],
      [scenario],
      { async: true },
    );
    if (!Number.isSafeInteger(raw) || raw < 0 || raw >= DIAGNOSTICS.length) {
      return fixedFailure();
    }
    return Object.freeze({ diagnostic: DIAGNOSTICS[raw] });
  } catch {
    return fixedFailure();
  }
}

function fixedFailure(): SianoStopBoundaryReport {
  return Object.freeze({ diagnostic: 'INTERNAL' });
}
