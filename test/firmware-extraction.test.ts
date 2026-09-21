import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIRMWARE_SOURCE, extractFirmware } from '../src/usb/firmware';
import { readZipEntry } from '../src/usb/zip';
import type { IdentityModule } from '../src/usb/px4-identity';

// 実際のベンダードライバに対する検証。アーカイブはリポジトリに入れないので、
// WEBTS_DRIVER_ZIP が指されているときだけ走る。CI では自動的に飛ばされる。
//
// 合成入力ではない。実配布物からファームウェアを取り出せることを確かめる。

const archivePath = process.env.WEBTS_DRIVER_ZIP;
const modulePath = 'build/px4-identity/px4-identity.mjs';
const runnable = Boolean(archivePath) && existsSync(archivePath!) && existsSync(modulePath);

describe.skipIf(!runnable)('firmware extraction from the real vendor driver', () => {
  async function loadModule(): Promise<IdentityModule> {
    const factory = (await import(pathToFileURL(modulePath).href)).default;
    return factory() as Promise<IdentityModule>;
  }

  it('extracts and has upstream accept the firmware', async () => {
    const module = await loadModule();
    const archive = new Uint8Array(readFileSync(archivePath!));
    const stages: string[] = [];
    const result = await extractFirmware(archive, (stage) => stages.push(stage), module);

    expect(result.bytes.length).toBe(2169);
    expect(result.archiveMatchedPin).toBe(true);
    expect(result.sysMatchedPin).toBe(true);
    expect(result.source).toBe(FIRMWARE_SOURCE.sysEntry);
    expect(result.offset).toBe(FIRMWARE_SOURCE.firmwareOffsetHint);
    expect(result.usedHint).toBe(true);
    expect(stages).toContain('firmware-accepted');
  }, 60_000);

  it('finds the firmware by hash even without a usable offset hint', async () => {
    // ヒントは近道でしかない。正しさはハッシュ一致が保証するので、ヒントを
    // 外しても同じオフセットに行き着かなければならない。
    const module = await loadModule();
    const archive = new Uint8Array(readFileSync(archivePath!));
    const sys = await readZipEntry(archive, FIRMWARE_SOURCE.sysEntry);

    const pointer = module._malloc(sys.length);
    try {
      module.HEAPU8.set(sys, pointer);
      const call = (hint: number) => module.ccall(
        'webts_px4_firmware_find', 'number',
        ['number', 'number', 'number'], [pointer, sys.length, hint],
      );
      expect(call(FIRMWARE_SOURCE.firmwareOffsetHint)).toBe(FIRMWARE_SOURCE.firmwareOffsetHint);
      expect(call(-1)).toBe(FIRMWARE_SOURCE.firmwareOffsetHint);
      expect(call(0)).toBe(FIRMWARE_SOURCE.firmwareOffsetHint);
    } finally {
      module.HEAPU8.fill(0, pointer, pointer + sys.length);
      module._free(pointer);
    }
  }, 180_000);
});
