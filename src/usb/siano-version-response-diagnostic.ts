/**
 * Fixed-code contract for the offline Siano version-response fixture.
 * Frame decoding is performed by upstream sms_frame_message() in the native
 * overlay; this TypeScript layer does not duplicate the wire protocol.
 */
export interface SianoVersionResponseModule {
  ccall(
    name: 'webts_siano_version_response_mock',
    returnType: 'number',
    argTypes: readonly ['number'],
    args: readonly [number],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export type SianoVersionResponseDiagnostic =
  | 'OK'
  | 'SPLIT_OK'
  | 'INVALID_FRAME'
  | 'TIMEOUT'
  | 'RETRY_SUPPRESSED'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

export interface SianoVersionResponseReport {
  readonly diagnostic: SianoVersionResponseDiagnostic;
}

const DIAGNOSTICS: readonly SianoVersionResponseDiagnostic[] = [
  'OK',
  'SPLIT_OK',
  'INVALID_FRAME',
  'TIMEOUT',
  'RETRY_SUPPRESSED',
  'INVALID_ARGUMENT',
  'INTERNAL',
];

/** Runs one USB-free native fixture scenario using Asyncify ccall. */
export async function runSianoVersionResponseMock(
  moduleFactory: () => SianoVersionResponseModule | Promise<SianoVersionResponseModule>,
  scenario: number,
): Promise<SianoVersionResponseReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 4) {
    return Object.freeze({ diagnostic: 'INVALID_ARGUMENT' });
  }

  let module: SianoVersionResponseModule;
  try {
    module = await moduleFactory();
  } catch {
    return fixedFailure();
  }
  if (!module || typeof module.ccall !== 'function') return fixedFailure();

  try {
    const raw = await module.ccall(
      'webts_siano_version_response_mock',
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

function fixedFailure(): SianoVersionResponseReport {
  return Object.freeze({ diagnostic: 'INTERNAL' });
}
