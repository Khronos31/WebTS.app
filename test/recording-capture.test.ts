import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingCapture, RECORDING_MS } from '../src/epg-ui/recording-capture';
import { parseRecording, type RecordingInfo, type RecordingSink } from '../src/epg-ui/recording-store';

const source = { title: '番組', channelName: '局', serviceId: 101, wave: 'GR' as const };
function packetBytes(count = 4): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(count * 188);
  for (let i = 0; i < count; i++) bytes[i * 188] = 0x47;
  return bytes;
}
function sink() {
  const chunks: Uint8Array[] = [];
  const result: RecordingSink = {
    write: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => { chunks.push(bytes.slice()); }),
    commit: vi.fn(async () => {}), abort: vi.fn(async () => {}),
  };
  return { result, chunks };
}
afterEach(() => { vi.useRealTimers(); });

describe('30秒録画', () => {
  it('再生側へのtransfer後も順序と188バイト境界を保って保存する', async () => {
    const { result, chunks } = sink();
    const done = vi.fn();
    const capture = new RecordingCapture('one', source, result, done);
    const bytes = packetBytes();
    capture.push(bytes.slice(0, 250));
    const rest = bytes.slice(250);
    capture.push(rest);
    structuredClone(rest.buffer, { transfer: [rest.buffer] });
    const saved = await capture.finish('手動終了');
    expect(saved.info?.bytes).toBe(bytes.length);
    // 理由を渡して終えたら途中終了。報告の語は既定で手動停止。
    expect(saved.issue).toBe('record-stopped');
    expect(Array.from(chunks.flatMap((c) => Array.from(c)))).toEqual(Array.from(bytes));
    expect(result.commit).toHaveBeenCalledOnce();
    expect(result.abort).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  it('理由を付けずに早めに終える（停止ボタン）と、30秒に届かなくても完了', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { result } = sink();
    const capture = new RecordingCapture('stop', source, result, vi.fn());
    capture.push(packetBytes());
    await vi.advanceTimersByTimeAsync(1000);
    capture.push(packetBytes());
    const saved = await capture.finish();
    expect(saved.info?.incompleteReason).toBe('');
    expect(saved.issue).toBeNull();
    expect(saved.info?.durationMs).toBe(1000);
  });

  it('30秒で自動確定し、その後の入力と停止の重複を無視する', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { result } = sink();
    const done = vi.fn();
    const capture = new RecordingCapture('two', source, result, done);
    for (let second = 0; second < 30; second++) {
      capture.push(packetBytes());
      await vi.advanceTimersByTimeAsync(1000);
    }
    capture.push(packetBytes());
    const saved = await capture.finish();
    expect(saved.info?.durationMs).toBe(RECORDING_MS);
    expect(saved.info?.incompleteReason).toBe('');
    expect(saved.issue).toBeNull();
    expect(result.write).toHaveBeenCalledTimes(30);
    expect(result.commit).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
  });

  it('未受信、write失敗、commit失敗では成功した録画として公開しない', async () => {
    const words = { empty: 'record-no-data', write: 'record-write', commit: 'record-commit' } as const;
    for (const failure of ['empty', 'write', 'commit'] as const) {
      const { result } = sink();
      if (failure === 'write') result.write = vi.fn(async () => { throw new Error('disk full'); });
      if (failure === 'commit') result.commit = vi.fn(async () => { throw new Error('close failed'); });
      const capture = new RecordingCapture(failure, source, result, vi.fn());
      if (failure !== 'empty') capture.push(packetBytes());
      const saved = await capture.finish();
      expect(saved.error).toBeInstanceOf(Error);
      expect(saved.failure).toBe(words[failure]);
      expect(result.abort).toHaveBeenCalledOnce();
      if (failure !== 'commit') expect(result.commit).not.toHaveBeenCalled();
    }
  });

  it('容量不足は、書き込みでも確定でも同じ語にする', async () => {
    const quota = () => new DOMException('full', 'QuotaExceededError');
    for (const step of ['write', 'commit'] as const) {
      const { result } = sink();
      if (step === 'write') result.write = vi.fn(async () => { throw quota(); });
      else result.commit = vi.fn(async () => { throw quota(); });
      const capture = new RecordingCapture(step, source, result, vi.fn());
      capture.push(packetBytes());
      expect((await capture.finish()).failure).toBe('record-quota');
    }
  });

  it('遅い保存キューを無制限に溜めず、受理済みデータを途中終了として確定する', async () => {
    let release: (() => void) | undefined;
    const { result } = sink();
    result.write = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const capture = new RecordingCapture('slow', source, result, vi.fn());
    capture.push(packetBytes());
    await Promise.resolve();
    capture.push(packetBytes(Math.ceil(8 * 1024 * 1024 / 188)));
    expect(capture.closing).toBe(true);
    release?.();
    const saved = await capture.finish();
    expect(saved.info?.bytes).toBe(4 * 188);
    expect(saved.info?.incompleteReason).toContain('追いつかない');
    expect(saved.issue).toBe('record-slow-storage');
  });

  it('受信が途切れた録画を30秒成功とは扱わない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { result } = sink();
    const capture = new RecordingCapture('gap', source, result, vi.fn());
    capture.push(packetBytes());
    await vi.advanceTimersByTimeAsync(1000);
    capture.push(packetBytes());
    await vi.advanceTimersByTimeAsync(RECORDING_MS);
    const saved = await capture.finish();
    expect(saved.info?.incompleteReason).toContain('途切れ');
    expect(saved.issue).toBe('record-gap');
    expect(saved.info?.durationMs).toBe(1000);
  });

  it('最初の受信が遅れた場合も30秒の成功とは表示しない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { result } = sink();
    const capture = new RecordingCapture('late', source, result, vi.fn());
    await vi.advanceTimersByTimeAsync(29000);
    capture.push(packetBytes());
    await vi.advanceTimersByTimeAsync(1000);
    const saved = await capture.finish();
    expect(saved.info?.incompleteReason).toContain('遅れ');
    expect(saved.issue).toBe('record-late-start');
    expect(saved.info?.durationMs).toBe(0);
  });
});

describe('録画台帳', () => {
  it('破損した台帳や別ID、サイズ不正を受け付けない', () => {
    const info: RecordingInfo = {
      version: 1, id: 'one', ...source, createdAt: 1, durationMs: 30000, bytes: 188, incompleteReason: '',
    };
    expect(parseRecording(info, 'one')).toEqual(info);
    expect(parseRecording(info, 'other')).toBeNull();
    expect(parseRecording({ ...info, bytes: -1 }, 'one')).toBeNull();
    expect(parseRecording({ ...info, serviceId: null }, 'one')).toBeNull();
    expect(parseRecording({ ...info, wave: 'SKY' }, 'one')).toBeNull();
    // 0.4.0 より前の録画には波が無い。それでも一覧には出す。
    const { wave: _wave, ...older } = info;
    expect(parseRecording(older, 'one')).toEqual(older);
    expect(parseRecording({}, 'one')).toBeNull();
  });
});
