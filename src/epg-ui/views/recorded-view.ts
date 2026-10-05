import { VideoPlayer } from '../components/video-player';
import { RecordedSession, reportPlayback } from '../recorded-session';
import { ScreenWakeLock } from '../screen-wake-lock';
import {
  deleteRecording, listRecordings, recordingError, recordingFile, recordingStorageSupported,
  RECORDINGS_CHANGED, type RecordingInfo,
} from '../recording-store';

export class RecordedView {
  readonly element = document.createElement('section');
  readonly #list = document.createElement('div');
  readonly #playback = document.createElement('section');
  readonly #notice = document.createElement('p');
  #player: VideoPlayer | null = null;
  #session: RecordedSession | null = null;
  /** 再生中は画面を点けたままにする（screen-wake-lock.ts）。 */
  readonly #wakeLock = new ScreenWakeLock();
  #playingId: string | null = null;
  #playGeneration = 0;
  #loadGeneration = 0;
  #destroyed = false;

  constructor() {
    this.element.className = 'recorded-view';
    const heading = document.createElement('h1');
    heading.textContent = '録画済み';
    heading.className = 'recorded-heading';
    const note = document.createElement('p');
    note.className = 'recording-storage-note';
    note.textContent = '30秒録画デモ · この端末に保存した放送です。サイトデータの削除などで消える場合があります。';
    this.#notice.setAttribute('role', 'status');
    this.#notice.className = 'recorded-notice';
    this.#list.className = 'recorded-grid';
    this.#playback.className = 'recorded-playback';
    this.#playback.hidden = true;
    this.element.append(heading, note, this.#notice, this.#playback, this.#list);
    window.addEventListener(RECORDINGS_CHANGED, this.#reload);
    void this.#load();
  }

  readonly #reload = (): void => { void this.#load(); };

  async #load(): Promise<void> {
    const generation = ++this.#loadGeneration;
    this.#notice.textContent = '録画を読み込んでいます…';
    if (!recordingStorageSupported()) {
      this.#notice.textContent = 'このブラウザでは録画の保存を利用できません。';
      return;
    }
    try {
      const recordings = await listRecordings();
      if (this.#destroyed || generation !== this.#loadGeneration) return;
      this.#list.replaceChildren();
      this.#notice.textContent = recordings.length ? `${recordings.length}件の録画` : '';
      if (recordings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'recorded-empty';
        const title = document.createElement('h2');
        title.textContent = '録画された番組はありません';
        const explanation = document.createElement('p');
        explanation.textContent = 'ライブ視聴画面の「録画」から、30秒間の放送を保存できます。';
        const link = document.createElement('a');
        link.href = '#/';
        link.className = 'btn btn-primary';
        link.textContent = '放映中一覧へ';
        empty.append(title, explanation, link);
        this.#list.append(empty);
      }
      for (const info of recordings) this.#list.append(this.#card(info));
    } catch (error) {
      if (this.#destroyed || generation !== this.#loadGeneration) return;
      this.#notice.textContent = `録画を読み込めませんでした: ${recordingError(error)}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-secondary';
      retry.textContent = '再試行';
      retry.addEventListener('click', this.#reload);
      this.#list.replaceChildren(retry);
    }
  }

  #card(info: RecordingInfo): HTMLElement {
    const card = document.createElement('article');
    card.className = 'recorded-card';
    const header = document.createElement('div');
    header.className = 'recorded-header';
    const title = document.createElement('h2');
    title.className = 'recorded-title';
    title.textContent = info.title;
    const badge = document.createElement('span');
    badge.className = `recorded-badge ${info.incompleteReason ? 'is-incomplete' : ''}`;
    badge.textContent = info.incompleteReason ? '途中終了・要確認' : '完了';
    header.append(title, badge);
    const meta = document.createElement('p');
    meta.className = 'recorded-meta-row';
    meta.textContent = `${info.channelName} · ${new Date(info.createdAt).toLocaleString('ja-JP')}`;
    const detail = document.createElement('p');
    detail.className = 'recorded-meta-row';
    detail.textContent = `約${(info.durationMs / 1000).toFixed(1)}秒 · ${(info.bytes / 1048576).toFixed(1)} MiB`;
    card.append(header, meta, detail);
    if (info.incompleteReason) {
      const reason = document.createElement('p');
      reason.className = 'recorded-reason';
      reason.textContent = info.incompleteReason;
      card.append(reason);
    }
    const actions = document.createElement('div');
    actions.className = 'recorded-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-primary';
    play.textContent = '再生';
    play.setAttribute('aria-label', `${info.title} を再生`);
    play.addEventListener('click', () => { void this.#play(info); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary';
    remove.textContent = '削除';
    remove.setAttribute('aria-label', `${info.title} を削除`);
    remove.addEventListener('click', () => {
      if (!window.confirm(`「${info.title}」をこの端末から削除しますか？`)) return;
      remove.disabled = true;
      if (this.#playingId === info.id) this.#stopPlayback();
      void deleteRecording(info.id).catch((error: unknown) => {
        this.#notice.textContent = `削除できませんでした: ${recordingError(error)}`;
        remove.disabled = false;
      });
    });
    actions.append(remove, play);
    card.append(actions);
    return card;
  }

  async #play(info: RecordingInfo): Promise<void> {
    this.#stopPlayback();
    const generation = this.#playGeneration;
    this.#playingId = info.id;
    this.#notice.textContent = '録画を開いています…';
    try {
      const file = await recordingFile(info.id);
      if (this.#destroyed || generation !== this.#playGeneration) return;
      const player = new VideoPlayer({
        filePlayback: true, programTitle: info.title,
        onPlayPause: (playing) => {
          if (this.#session) this.#session.setPaused(!playing);
          else if (playing) void this.#play(info);
        },
        onVolumeChange: (volume, muted) => { this.#session?.setVolume(volume, muted); },
        onSubtitleToggle: (visible) => { this.#session?.setCaptionsVisible(visible); },
      });
      this.#player = player;
      const heading = document.createElement('h2');
      heading.className = 'recorded-title';
      heading.textContent = info.title;
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'btn btn-secondary';
      restart.textContent = '先頭から再生';
      restart.addEventListener('click', () => { void this.#play(info); });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn btn-secondary';
      close.textContent = '再生を閉じる';
      close.addEventListener('click', () => { this.#stopPlayback(); });
      const actions = document.createElement('div');
      actions.className = 'recorded-actions';
      actions.append(restart, close);
      this.#playback.replaceChildren(heading, player.element, actions);
      this.#playback.hidden = false;
      this.#session = new RecordedSession(file, player.takeOffscreen(), player.captionHost, info.serviceId,
        (text) => { player.setStatusText(text); }, () => {
          this.#session = null;
          this.#wakeLock.release();
          player.setPlaying(false);
        }, info.wave);
      this.#wakeLock.acquire();
      this.#notice.textContent = '';
      player.element.focus();
      this.#playback.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      if (this.#destroyed || generation !== this.#playGeneration) return;
      reportPlayback(info.wave, 'playback-open');
      this.#stopPlayback();
      this.#notice.textContent = `録画を再生できませんでした: ${recordingError(error)}`;
    }
  }

  #stopPlayback(): void {
    this.#playGeneration++;
    this.#wakeLock.release();
    this.#session?.stop();
    this.#session = null;
    this.#player?.destroy();
    this.#player = null;
    this.#playingId = null;
    this.#playback.replaceChildren();
    this.#playback.hidden = true;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#wakeLock.destroy();
    window.removeEventListener(RECORDINGS_CHANGED, this.#reload);
    this.#stopPlayback();
  }
}
