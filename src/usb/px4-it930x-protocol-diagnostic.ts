/**
 * Contract for the source-backed PX4 IT930x scatter-image fixture. The
 * framing/length rules remain in upstream C++; TypeScript only decodes codes.
 */
export interface Px4It930xProtocolModule {
  ccall(
    name: 'webts_px4_it930x_protocol_mock',
    returnType: 'number',
    argTypes: readonly ['number'],
    args: readonly [number],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export type Px4It930xProtocolDiagnostic =
  | 'OK'
  | 'REJECTED'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL';

export interface Px4It930xProtocolReport {
  readonly diagnostic: Px4It930xProtocolDiagnostic;
}

const diagnostics: readonly Px4It930xProtocolDiagnostic[] = [
  'OK',
  'REJECTED',
  'INVALID_ARGUMENT',
];

/** Runs a synthetic parser case; no USB, firmware, command, or TS input. */
export async function runPx4It930xProtocolMock(
  moduleFactory: () => Px4It930xProtocolModule | Promise<Px4It930xProtocolModule>,
  scenario: number,
): Promise<Px4It930xProtocolReport> {
  if (!Number.isSafeInteger(scenario) || scenario < 0 || scenario > 6) {
    return Object.freeze({ diagnostic: 'INVALID_ARGUMENT' });
  }
  let module: Px4It930xProtocolModule;
  try {
    module = await moduleFactory();
  } catch {
    return fixedFailure();
  }
  if (!module || typeof module.ccall !== 'function') return fixedFailure();
  try {
    const raw = await module.ccall(
      'webts_px4_it930x_protocol_mock',
      'number',
      ['number'],
      [scenario],
      { async: true },
    );
    if (!Number.isSafeInteger(raw) || raw === 255 || raw < 0 || raw >= diagnostics.length) {
      return fixedFailure();
    }
    return Object.freeze({ diagnostic: diagnostics[raw] });
  } catch {
    return fixedFailure();
  }
}

function fixedFailure(): Px4It930xProtocolReport {
  return Object.freeze({ diagnostic: 'INTERNAL' });
}
