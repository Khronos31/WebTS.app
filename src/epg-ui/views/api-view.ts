// `#/api/...` で叩ける操作口。
//
// **画面を持たない操作をここへ集める。**走査のような、設定画面にボタンを
// 置かずに済ませたいものを URL から実行できるようにする。サーバーは無いので
// HTTP のエンドポイントではなく、ハッシュで選ぶ操作である。
//
// 出力は JSON をそのまま流す。整形はしない。読むのは人か、開発中の道具。
//
//   #/api/                       使える操作の一覧
//   #/api/channels               保存済みの局
//   #/api/programs               保存済みの番組
//   #/api/status                 いま受信機を使っているか
//   #/api/scan?wave=GR|BS|CS     その波を走査して保存する
//   #/api/epg/refresh            既知の中継器から番組情報を取り直す
//   #/api/lnb                    LNB 給電の許可を読む
//   #/api/lnb?allow=1|0          LNB 給電の許可を書く

import { channelsSync, primeChannels, programCoverage } from '../channel-source';
import { readChannels, readPrograms } from '../channel-store';
import {
  fetchSchedule, isRefreshing, refreshPrograms, scanWave, stopUserScan,
} from '../epg-refresh';
import { allowLnb15v, setAllowLnb15v } from '../lnb-setting';
import { ChannelScan, type ScanProgress } from '../channel-scan';
import { LiveSession } from '../live-session';
import type { WaveType } from '../tuning';

const ROUTES = [
  '#/api/channels',
  '#/api/programs',
  '#/api/status',
  '#/api/scan?wave=GR|BS|CS',
  '#/api/epg/refresh',
  '#/api/epg/schedule?wave=GR|BS|CS&dwell=<ms>',
  '#/api/epg/coverage',
  '#/api/lnb',
  '#/api/lnb?allow=1|0',
];

function isWave(value: string): value is WaveType {
  return value === 'GR' || value === 'BS' || value === 'CS';
}

export class ApiView {
  public readonly element: HTMLElement;
  readonly #output: HTMLPreElement;

  constructor(hash: string) {
    this.element = document.createElement('div');
    this.element.style.padding = '16px';

    this.#output = document.createElement('pre');
    this.#output.style.cssText = [
      'margin:0',
      'white-space:pre-wrap',
      'word-break:break-all',
      'font-size:0.8125rem',
      'line-height:1.5',
    ].join(';');
    this.element.append(this.#output);

    void this.#run(hash);
  }

  #write(value: unknown): void {
    this.#output.textContent = JSON.stringify(value, null, 2);
  }

  /** 走査中の経過。終わるまで何も出ないと、止まったのか分からない。 */
  #progress(lines: string[], line: string): void {
    lines.push(line);
    this.#output.textContent = lines.join('\n');
  }

  async #run(hash: string): Promise<void> {
    const clean = hash.replace(/^#\/?/, '');
    const [path = '', query = ''] = clean.split('?', 2);
    const params = new URLSearchParams(query);
    try {
      this.#write(await this.#dispatch(path, params));
    } catch (error) {
      this.#write({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #dispatch(path: string, params: URLSearchParams): Promise<unknown> {
    switch (path) {
      case 'api':
      case 'api/':
        return { ok: true, routes: ROUTES };

      case 'api/channels': {
        const stored = await readChannels();
        return {
          ok: true,
          scannedAt: stored?.scannedAt ?? 0,
          count: stored?.channels.length ?? 0,
          channels: stored?.channels ?? [],
        };
      }

      case 'api/programs': {
        const programs = await readPrograms();
        return { ok: true, count: programs.length, programs };
      }

      case 'api/status':
        return {
          ok: true,
          // 受信機は1本しか開けない。いま誰が握っているかを出す。
          watching: LiveSession.isActive(),
          scanning: ChannelScan.isActive(),
          refreshing: isRefreshing(),
          lnb15v: allowLnb15v(),
          channels: channelsSync(false).length,
          // **局で絞らない。**`programsSync(0)` と書いてしまい、存在しない
          // チャンネル 0 の番組を数えて常に 0 になっていた。
          programs: (await readPrograms()).length,
        };

      case 'api/lnb': {
        const allow = params.get('allow');
        if (allow !== null) setAllowLnb15v(allow === '1' || allow === 'true');
        return { ok: true, lnb15v: allowLnb15v() };
      }

      case 'api/scan': {
        const wave = params.get('wave') ?? '';
        if (!isWave(wave)) {
          return { ok: false, error: 'wave は GR / BS / CS のいずれか', routes: ROUTES };
        }
        const lines: string[] = [`${wave} を走査しています…`];
        this.#output.textContent = lines[0] ?? '';
        const result = await scanWave(wave, (progress: ScanProgress) => {
          if (progress.locked !== true) return;
          this.#progress(lines, `✔ ${progress.label}`
            + `${progress.tsid === null ? '' : ` tsid=0x${progress.tsid.toString(16)}`}`
            + ` 累計 ${progress.found} 局`);
        });
        await primeChannels();
        return { ok: true, wave, ...result };
      }

      case 'api/epg/coverage': {
        const coverage = await programCoverage();
        return {
          ok: true,
          ...(coverage === null ? { coverage: null } : {
            from: new Date(coverage.from).toISOString(),
            to: new Date(coverage.to).toISOString(),
            hours: Math.round((coverage.to - coverage.from) / 3_600_000),
          }),
        };
      }

      case 'api/epg/schedule': {
        const wave = params.get('wave') ?? '';
        const dwell = Number(params.get('dwell') ?? '');
        const lines: string[] = ['番組表を取得しています…（揃った中継器から次へ進みます）'];
        this.#output.textContent = lines[0] ?? '';
        const result = await fetchSchedule({
          ...(isWave(wave) ? { wave } : {}),
          ...(Number.isFinite(dwell) && dwell > 0 ? { dwellMs: dwell } : {}),
          onProgress: (progress: ScanProgress) => {
            this.#progress(lines, `${progress.locked === true ? '✔' : '-'} ${progress.label}`
              + ` (${progress.index + 1}/${progress.total})`);
          },
        });
        return { ok: true, ...result };
      }

      case 'api/epg/refresh': {
        const lines: string[] = ['番組情報を取り直しています…'];
        this.#output.textContent = lines[0] ?? '';
        const programs = await refreshPrograms((progress: ScanProgress) => {
          this.#progress(lines, `${progress.locked === true ? '✔' : '-'} ${progress.label}`);
        });
        return { ok: true, programs };
      }

      default:
        return { ok: false, error: `不明な操作: ${path}`, routes: ROUTES };
    }
  }

  public destroy(): void {
    // **ここから始めた走査は、離れたら止める。**画面が消えても走り続けると、
    // 受信機を握ったまま誰も結果を受け取らない状態になる。裏の取得は止めない。
    stopUserScan();
  }
}
