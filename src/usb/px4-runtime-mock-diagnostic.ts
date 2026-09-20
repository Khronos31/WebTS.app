import type { Px4GroupingDiagnostic } from './px4-grouping-diagnostic';

/**
 * Contract for the build-only upstream PX4 runtime fixture. The native seam
 * drives RuntimeTestAccess with two synthetic LibusbApi devices and returns a
 * fixed Error code; it is never a real-device or serial-data API.
 */
export interface Px4RuntimeMockModule {
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
    opts: { readonly async: true },
  ): number | Promise<number>;
}

export interface Px4RuntimeMockReport {
  readonly diagnostic: Px4GroupingDiagnostic;
}

/** Runs the upstream Q3U4Runtime open/destructor cleanup fixture. */
export async function runPx4RuntimeMockOpenClose(
  moduleFactory: () => Px4RuntimeMockModule | Promise<Px4RuntimeMockModule>,
): Promise<Px4RuntimeMockReport> {
  let module: Px4RuntimeMockModule;
  try {
    module = await moduleFactory();
  } catch {
    return fixedFailure();
  }
  if (!module || typeof module.ccall !== 'function') return fixedFailure();

  try {
    const packed = await module.ccall(
      'webts_px4_runtime_mock_open_close',
      'number',
      [],
      [],
      { async: true },
    );
    if (packed !== 0) return fixedFailure();
    return Object.freeze({ diagnostic: 'OK' });
  } catch {
    return fixedFailure();
  }
}

function fixedFailure(): Px4RuntimeMockReport {
  return Object.freeze({ diagnostic: 'INTERNAL' });
}
