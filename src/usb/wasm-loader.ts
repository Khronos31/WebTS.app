/** Loader for the explicitly generated libusb WebUSB Emscripten module. */
import type {
  LibusbEnumerationModule,
  SianoFirmwareValidationModule,
  SianoRioEnumerationModule,
} from './wasm-enumeration-diagnostic';
import type { Px4GroupingModule } from './px4-grouping-diagnostic';
import type { Px4RuntimeMockModule } from './px4-runtime-mock-diagnostic';
import type { Px4It930xProtocolModule } from './px4-it930x-protocol-diagnostic';
import type { Px4TaggedTsDemuxModule } from './px4-tagged-ts-demux-diagnostic';
import type { B25CoreSmokeModule } from './b25-core-diagnostic';
import type { SianoTsQueueModule } from './siano-ts-queue-diagnostic';
import type { SianoLiveStatsModule } from './siano-live-stats-diagnostic';

export const DEFAULT_LIBUSB_WASM_MODULE_URL = '/build/libusb-webusb/libusb-webusb-browser.js';
export const NON_PTHREAD_LIBUSB_WASM_MODULE_URL = '/build/libusb-webusb-nopthread/libusb-webusb-browser.js';
export const SIANO_RIO_WASM_MODULE_URL = '/build/upstream-wasm/siano-rio-enumeration-browser.js';
export const PX4_GROUPING_WASM_MODULE_URL = '/build/upstream-wasm/px4-transport-smoke-browser.js';
export const B25_CORE_WASM_MODULE_URL = '/build/upstream-wasm/libaribb25-smoke-browser.js';

export type EmscriptenLibusbFactory = () =>
  LibusbEnumerationModule | Promise<LibusbEnumerationModule>;
export type EmscriptenSianoRioFactory = (moduleArg?: {
  readonly print?: () => void;
  readonly printErr?: () => void;
}) =>
  SianoRioEnumerationModule | Promise<SianoRioEnumerationModule>;

/**
 * Loads only an explicitly generated browser-served module copy. Vite does
 * not bundle this URL; the build script must be run separately and its
 * ignored build output served.
 */
export async function loadGeneratedLibusbModule(
  moduleUrl = DEFAULT_LIBUSB_WASM_MODULE_URL,
): Promise<LibusbEnumerationModule> {
  let imported: unknown;
  try {
    imported = await import(/* @vite-ignore */ moduleUrl);
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }

  const candidate = imported as { readonly default?: unknown };
  const factory = candidate.default ?? imported;
  if (typeof factory !== 'function') throw new Error('WASM_UNAVAILABLE');

  try {
    return await (factory as EmscriptenLibusbFactory)();
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
}

/** Loads the explicitly generated Siano Rio identity/enumeration module. */
export async function loadGeneratedSianoRioModule(
  moduleUrl = SIANO_RIO_WASM_MODULE_URL,
): Promise<SianoRioEnumerationModule> {
  let imported: unknown;
  try {
    imported = await import(/* @vite-ignore */ moduleUrl);
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }

  const candidate = imported as { readonly default?: unknown };
  const factory = candidate.default ?? imported;
  if (typeof factory !== 'function') throw new Error('WASM_UNAVAILABLE');

  try {
    return await (factory as EmscriptenSianoRioFactory)({
      print: () => undefined,
      printErr: () => undefined,
    });
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
}

/** Loads the same Siano module with the firmware staging ABI contract. */
export async function loadGeneratedSianoFirmwareModule(
  moduleUrl = SIANO_RIO_WASM_MODULE_URL,
): Promise<SianoFirmwareValidationModule> {
  const module = await loadGeneratedSianoRioModule(moduleUrl);
  return module as SianoFirmwareValidationModule;
}

/** Loads the offline PX4 identity/grouping overlay; it is not wired to UI. */
export async function loadGeneratedPx4GroupingModule(
  moduleUrl = PX4_GROUPING_WASM_MODULE_URL,
): Promise<Px4GroupingModule> {
  let imported: unknown;
  try {
    imported = await import(/* @vite-ignore */ moduleUrl);
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
  const candidate = imported as { readonly default?: unknown };
  const factory = candidate.default ?? imported;
  if (typeof factory !== 'function') throw new Error('WASM_UNAVAILABLE');
  try {
    return await (factory as () => Px4GroupingModule)();
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
}

/** Loads the same generated PX4 module for the offline runtime fixture. */
export async function loadGeneratedPx4RuntimeMockModule(
  moduleUrl = PX4_GROUPING_WASM_MODULE_URL,
): Promise<Px4RuntimeMockModule> {
  return loadGeneratedPx4GroupingModule(moduleUrl) as Promise<Px4RuntimeMockModule>;
}

/** Loads the same generated PX4 module for the offline IT930x parser fixture. */
export async function loadGeneratedPx4It930xProtocolModule(
  moduleUrl = PX4_GROUPING_WASM_MODULE_URL,
): Promise<Px4It930xProtocolModule> {
  return loadGeneratedPx4GroupingModule(moduleUrl) as Promise<Px4It930xProtocolModule>;
}

/** Loads the same generated PX4 module for the offline tagged-TS demux fixture. */
export async function loadGeneratedPx4TaggedTsDemuxModule(
  moduleUrl = PX4_GROUPING_WASM_MODULE_URL,
): Promise<Px4TaggedTsDemuxModule> {
  return loadGeneratedPx4GroupingModule(moduleUrl) as Promise<Px4TaggedTsDemuxModule>;
}

/** Loads the explicitly generated, UI-disconnected B25 core smoke module. */
export async function loadGeneratedB25CoreModule(
  moduleUrl = B25_CORE_WASM_MODULE_URL,
): Promise<B25CoreSmokeModule> {
  let imported: unknown;
  try {
    imported = await import(/* @vite-ignore */ moduleUrl);
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
  const candidate = imported as { readonly default?: unknown };
  const factory = candidate.default ?? imported;
  if (typeof factory !== 'function') throw new Error('WASM_UNAVAILABLE');
  try {
    return await (factory as () => B25CoreSmokeModule)();
  } catch {
    throw new Error('WASM_UNAVAILABLE');
  }
}

/** Loads the Siano source-backed queue fixture from the generated module. */
export async function loadGeneratedSianoTsQueueModule(
  moduleUrl = SIANO_RIO_WASM_MODULE_URL,
): Promise<SianoTsQueueModule> {
  return loadGeneratedSianoRioModule(moduleUrl) as Promise<SianoTsQueueModule>;
}

/** Loads the Siano live-statistics ABI from the generated module. */
export async function loadGeneratedSianoLiveStatsModule(
  moduleUrl = SIANO_RIO_WASM_MODULE_URL,
): Promise<SianoLiveStatsModule> {
  return loadGeneratedSianoRioModule(moduleUrl) as Promise<SianoLiveStatsModule>;
}
