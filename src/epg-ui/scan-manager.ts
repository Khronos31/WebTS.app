// 全帯域チャンネルスキャンの進行状態を保持するシングルトンマネージャー。
//
// 画面（SettingsView）が破棄・再生成されてもスキャンは裏で継続し、
// 設定画面に戻った際に最新の進捗・ログ・検出数をそのまま復元できるようにする。

import { grTunings, bsTunings, csTunings, satelliteScanTunings } from './tuning';
import { scanAllWaves, stopUserScan, type FullScanResult } from './epg-refresh';
import { saveChannels } from './channel-store';
import { notifyChannelsChanged } from './channel-source';
import { defaultEnabledChannelIds, saveEnabledChannelIds } from './enabled-channels';
import type { ScanProgress } from './channel-scan';
import { LiveBlocksScanError } from './receiver-gate';

export interface ScanLaneState {
  barWidth: string;
  countText: string;
  foundText: string;
  wavePill: 'none' | 'BS' | 'CS';
  done: number;
  found: number;
}

export interface ScanState {
  isScanning: boolean;
  status: string;
  percent: number;
  overallCountText: string;
  totalTunings: number;
  totalGR: number;
  totalSat: number;
  gr: ScanLaneState;
  sat: ScanLaneState;
  logs: string[];
  completed: boolean;
  error: string | null;
  result: FullScanResult | null;
}

const totalGR = grTunings().length;
const totalSat = satelliteScanTunings(bsTunings()).length + satelliteScanTunings(csTunings()).length;
const totalTunings = totalGR + totalSat;

const MAX_LOGS = 500;

const state: ScanState = {
  isScanning: false,
  status: 'スキャン待機中...',
  percent: 0,
  overallCountText: `0 / ${totalTunings}`,
  totalTunings,
  totalGR,
  totalSat,
  gr: {
    barWidth: '0%',
    countText: `0 / ${totalGR}`,
    foundText: '検出: 0 局',
    wavePill: 'none',
    done: 0,
    found: 0,
  },
  sat: {
    barWidth: '0%',
    countText: `0 / ${totalSat}`,
    foundText: '検出: 0 局',
    wavePill: 'none',
    done: 0,
    found: 0,
  },
  logs: [],
  completed: false,
  error: null,
  result: null,
};

type ScanListener = (state: Readonly<ScanState>, newLog?: string) => void;
const listeners = new Set<ScanListener>();

function notify(newLog?: string): void {
  for (const listener of listeners) {
    try {
      listener(state, newLog);
    } catch (e) {
      console.error(e);
    }
  }
}

function appendLog(line: string): void {
  state.logs.push(line);
  if (state.logs.length > MAX_LOGS) {
    state.logs.shift();
  }
  notify(line);
}

export function subscribeScan(listener: ScanListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getScanState(): Readonly<ScanState> {
  return state;
}

export function isScanActive(): boolean {
  return state.isScanning;
}

export function stopScan(): void {
  if (!state.isScanning) return;
  appendLog('[FULL-SCAN] スキャンの中止を要求しました…');
  stopUserScan();
  notify();
}

export async function startFullScan(): Promise<void> {
  if (state.isScanning) return;

  state.isScanning = true;
  state.completed = false;
  state.error = null;
  state.result = null;
  state.status = '全帯域スキャン準備中...';
  state.percent = 0;
  state.overallCountText = `0 / ${totalTunings}`;

  state.gr = {
    barWidth: '0%',
    countText: `0 / ${totalGR}`,
    foundText: '検出: 0 局',
    wavePill: 'none',
    done: 0,
    found: 0,
  };

  state.sat = {
    barWidth: '0%',
    countText: `0 / ${totalSat}`,
    foundText: '検出: 0 局',
    wavePill: 'none',
    done: 0,
    found: 0,
  };

  state.logs = [];
  notify();

  appendLog(`[FULL-SCAN] 全帯域並列フルスキャンを開始します（地上波 ${totalGR}ch / 衛星 ${totalSat}中継器）...`);

  let previousFound = 0;
  let doneGR = 0;
  let doneSat = 0;
  let foundGR = 0;
  let foundSat = 0;

  try {
    const result = await scanAllWaves(
      (wave) => {
        if (wave === 'GR') {
          appendLog(`[FULL-SCAN] 地上波 (GR 13ch〜${13 + totalGR - 1}ch) の並列走査を開始します`);
        } else if (wave === 'BS') {
          state.sat.wavePill = 'BS';
          appendLog('[FULL-SCAN] 衛星 (BS/CS) の並列走査を開始します');
          notify();
        } else if (wave === 'CS') {
          state.sat.wavePill = 'CS';
          appendLog('[FULL-SCAN] 衛星 CS の走査を開始します');
          notify();
        }
      },
      (progress: ScanProgress) => {
        const wave = progress.tuning.wave;
        const gained = Math.max(0, progress.found - previousFound);
        previousFound = progress.found;

        // 全体進捗
        const pct = Math.round(((progress.index + 1) / progress.total) * 100);
        state.percent = pct;
        state.overallCountText = `${progress.index + 1} / ${progress.total}`;
        state.status = `スキャン中... (検出済み: ${progress.found} 局)`;

        // 各レーン更新
        if (wave === 'GR') {
          doneGR = Math.min(totalGR, doneGR + 1);
          foundGR += gained;
          const grPct = Math.round((doneGR / totalGR) * 100);
          state.gr.done = doneGR;
          state.gr.found = foundGR;
          state.gr.barWidth = `${grPct}%`;
          state.gr.countText = `${doneGR} / ${totalGR}`;
          state.gr.foundText = `検出: ${foundGR} 局`;
          const chLabel = progress.label.endsWith('ch') ? progress.label : `${progress.label}ch`;
          if (progress.locked === true) {
            appendLog(`✔ [GR] ${chLabel} ロック成功 検出: ${gained} サービス`);
          } else {
            appendLog(`- [GR] ${chLabel}: 信号なし`);
          }
        } else {
          // BS or CS
          doneSat = Math.min(totalSat, doneSat + 1);
          foundSat += gained;
          const satPct = Math.round((doneSat / totalSat) * 100);
          state.sat.done = doneSat;
          state.sat.found = foundSat;
          state.sat.barWidth = `${satPct}%`;
          state.sat.countText = `${doneSat} / ${totalSat}`;
          state.sat.foundText = `検出: ${foundSat} 局`;
          if (progress.locked === true) {
            appendLog(`✔ [${wave}] ${progress.label} ロック成功 検出: ${gained} サービス`);
          } else {
            appendLog(`- [${wave}] ${progress.label}: 信号なし`);
          }
        }
      },
      (label, _stage, elapsedMs) => {
        if (doneGR === 0 && doneSat === 0) {
          state.status = `${label}…`;
        }
        appendLog(`[FULL-SCAN] ${label}（${(elapsedMs / 1000).toFixed(1)} 秒）`);
      },
    );

    if (result.unsupported.length > 0) {
      const unsupportedText = result.unsupported.join('・');
      appendLog(`[FULL-SCAN] このチューナーは ${unsupportedText} を受信できないため飛ばしました`);
      if (result.unsupported.includes('BS') || result.unsupported.includes('CS')) {
        state.sat.foundText = '受信非対応';
        state.sat.countText = '対象外';
      }
    }

    for (const failure of result.failures) {
      appendLog(`[FULL-SCAN] ${failure.wave} は失敗しました: ${failure.error}`);
    }

    await saveChannels(result.channels, result.programs);
    await notifyChannelsChanged();
    const enabledIds = defaultEnabledChannelIds(result.channels);
    saveEnabledChannelIds(enabledIds);

    state.isScanning = false;
    state.completed = true;
    state.result = result;
    state.percent = 100;
    state.overallCountText = `${totalTunings} / ${totalTunings}`;
    state.status = result.unsupported.length > 0
      ? `フルスキャン完了（${result.unsupported.join('・')} は非対応のためスキップ）`
      : 'フルスキャン完了！';

    state.gr.barWidth = '100%';
    state.gr.countText = `${totalGR} / ${totalGR}`;

    state.sat.wavePill = 'none';
    state.sat.barWidth = '100%';
    state.sat.countText = `${totalSat} / ${totalSat}`;

    appendLog(
      `[FULL-SCAN] 全帯域スキャンが完了しました。検出: 地上波 ${foundGR} 局 / 衛星(BS/CS) ${foundSat} 局 (合計 ${result.channels.length} 局)`,
    );
    notify();
  } catch (error: unknown) {
    state.isScanning = false;
    state.sat.wavePill = 'none';
    if (error instanceof LiveBlocksScanError) {
      state.error = error.message;
      state.status = 'ライブ視聴中は更新できません';
      appendLog('[FULL-SCAN] ライブ視聴中は更新できません。');
    } else {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = 'エラーが発生しました';
      appendLog(`[FULL-SCAN] 失敗: ${state.error}`);
    }
    notify();
  } finally {
    state.isScanning = false;
    notify();
  }
}
