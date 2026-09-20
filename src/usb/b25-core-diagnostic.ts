export interface B25CoreSmokeModule {
  ccall(
    name: string,
    returnType: 'number',
    argTypes: readonly string[],
    args: readonly number[],
  ): number;
}

export type B25CoreDiagnostic = 'OK' | 'INTERNAL';

/** Runs the upstream facade create/configure/release smoke with no card/TS. */
export function runB25FacadeNoCardSmoke(
  moduleFactory: () => B25CoreSmokeModule | Promise<B25CoreSmokeModule>,
): Promise<{ readonly diagnostic: B25CoreDiagnostic }> {
  return Promise.resolve().then(async () => {
    try {
      const module = await moduleFactory();
      if (!module || typeof module.ccall !== 'function') return fixedFailure();
      const result = module.ccall('webts_b25_facade_no_card_smoke', 'number', [], []);
      return result === 0 ? Object.freeze({ diagnostic: 'OK' as const }) : fixedFailure();
    } catch {
      return fixedFailure();
    }
  });
}

/**
 * Runs the source-backed no-card/no-TS smoke contract. This is not a
 * descrambler API and accepts no card response, key, or TS payload.
 */
export function runB25CoreNoCardSmoke(
  moduleFactory: () => B25CoreSmokeModule | Promise<B25CoreSmokeModule>,
): Promise<{ readonly diagnostic: B25CoreDiagnostic }> {
  return Promise.resolve().then(async () => {
    try {
      const module = await moduleFactory();
      if (!module || typeof module.ccall !== 'function') return fixedFailure();
      const result = module.ccall('webts_b25_core_no_card_smoke', 'number', [], []);
      return result === 0 ? Object.freeze({ diagnostic: 'OK' as const }) : fixedFailure();
    } catch {
      return fixedFailure();
    }
  });
}

function fixedFailure(): { readonly diagnostic: 'INTERNAL' } {
  return Object.freeze({ diagnostic: 'INTERNAL' });
}
