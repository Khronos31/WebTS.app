// EPGStationスタイルの動画プレイヤーコンポーネント
// ARIB STD-B24 風の字幕オーバーレイ・字幕切替トグル・主/副音声・全画面・PiP対応

export interface VideoPlayerOptions {
  videoSrc?: string | undefined;
  autoplay?: boolean | undefined;
  programTitle?: string | undefined;
  onSubtitleToggle?: ((enabled: boolean) => void) | undefined;
  onAudioTrackChange?: ((track: 'main' | 'sub') => void) | undefined;
}

export class VideoPlayer {
  public readonly element: HTMLElement;
  private video: HTMLVideoElement;
  private subtitleOverlay: HTMLElement;
  private subtitleText: HTMLElement;
  private controlsBar: HTMLElement;
  private playBtn: HTMLButtonElement;
  private playIcon: HTMLElement;
  private volumeBtn: HTMLButtonElement;
  private volumeIcon: HTMLElement;
  private volumeSlider: HTMLInputElement;
  private subtitleBtn: HTMLButtonElement;
  private audioBtn: HTMLButtonElement;
  private pipBtn: HTMLButtonElement;
  private fullscreenBtn: HTMLButtonElement;

  private isSubtitlesEnabled = true;
  private currentAudioTrack: 'main' | 'sub' = 'main';
  private hideControlsTimer: number | null = null;
  private subtitleTimer: number | null = null;
  private subtitleIndex = 0;

  // モック用の放送字幕サンプル（リアルタイムに巡回表示）
  private mockSubtitles: string[] = [
    '最新の全国の気象情報をお伝えします。',
    '日本海側を中心にお昼頃にかけて雨が強まる見込みです。',
    '東京地方は夜遅くにかけて雷を伴う所があるでしょう。',
    '各地の注意報・警報の最新状況をご確認ください。',
    '続いて経済ニュースです。東京市場の平均株価は…',
    '以上、ニュースセンターからお伝えしました。',
  ];

  constructor(options: VideoPlayerOptions = {}) {
    this.element = document.createElement('div');
    this.element.className = 'video-player-container';
    this.element.tabIndex = 0;

    // 1. ビデオ要素
    this.video = document.createElement('video');
    this.video.className = 'video-player-media';
    this.video.src = options.videoSrc || '/mock-stream.mp4';
    this.video.playsInline = true;
    this.video.loop = true;
    this.video.muted = true; // ブラウザの自動再生ポリシー対策で初期ミュート
    if (options.autoplay !== false) {
      this.video.autoplay = true;
    }

    // 2. 字幕オーバーレイレイヤー (ARIB STD-B24 風スタイル)
    this.subtitleOverlay = document.createElement('div');
    this.subtitleOverlay.className = 'video-subtitle-overlay';

    this.subtitleText = document.createElement('div');
    this.subtitleText.className = 'video-subtitle-text';
    this.subtitleText.textContent = this.mockSubtitles[0] ?? '';
    this.subtitleOverlay.append(this.subtitleText);

    // 3. コントロールバー
    this.controlsBar = document.createElement('div');
    this.controlsBar.className = 'video-controls-bar';

    // 左側: 再生/停止, LIVEバッジ, 音量
    const leftGroup = document.createElement('div');
    leftGroup.className = 'video-controls-group left';

    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'player-btn play-btn';
    this.playBtn.setAttribute('aria-label', '再生 / 一時停止');
    this.playIcon = document.createElement('span');
    this.updatePlayIcon(true);
    this.playBtn.append(this.playIcon);

    const liveBadge = document.createElement('div');
    liveBadge.className = 'player-live-badge';
    liveBadge.innerHTML = `<span class="live-dot"></span>LIVE`;

    this.volumeBtn = document.createElement('button');
    this.volumeBtn.type = 'button';
    this.volumeBtn.className = 'player-btn volume-btn';
    this.volumeBtn.setAttribute('aria-label', 'ミュート切り替え');
    this.volumeIcon = document.createElement('span');
    this.updateVolumeIcon(true);
    this.volumeBtn.append(this.volumeIcon);

    this.volumeSlider = document.createElement('input');
    this.volumeSlider.type = 'range';
    this.volumeSlider.className = 'player-volume-slider';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = '0'; // 初期ミュートに合わせる

    leftGroup.append(this.playBtn, liveBadge, this.volumeBtn, this.volumeSlider);

    // 右側: 字幕切替, 音声切替, PiP, 全画面
    const rightGroup = document.createElement('div');
    rightGroup.className = 'video-controls-group right';

    // 字幕 (CC) 切り替えボタン
    this.subtitleBtn = document.createElement('button');
    this.subtitleBtn.type = 'button';
    this.subtitleBtn.className = 'player-btn subtitle-btn active';
    this.subtitleBtn.title = '字幕の表示/非表示を切り替え (C)';
    this.subtitleBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
        <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
      </svg>
      <span class="btn-text">字幕 ON</span>
    `;

    // 音声切替ボタン
    this.audioBtn = document.createElement('button');
    this.audioBtn.type = 'button';
    this.audioBtn.className = 'player-btn audio-btn';
    this.audioBtn.title = '音声トラック切り替え (主/副)';
    this.audioBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor">
        <path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/>
      </svg>
      <span class="btn-text">主音声</span>
    `;

    // PiP ボタン
    this.pipBtn = document.createElement('button');
    this.pipBtn.type = 'button';
    this.pipBtn.className = 'player-btn pip-btn';
    this.pipBtn.title = 'ピクチャー・イン・ピクチャー';
    this.pipBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
        <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/>
      </svg>
    `;

    // 全画面ボタン
    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.type = 'button';
    this.fullscreenBtn.className = 'player-btn fullscreen-btn';
    this.fullscreenBtn.title = '全画面表示 (F)';
    this.fullscreenBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor">
        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
      </svg>
    `;

    rightGroup.append(this.subtitleBtn, this.audioBtn, this.pipBtn, this.fullscreenBtn);
    this.controlsBar.append(leftGroup, rightGroup);

    // プレイヤーコンテナに組み立て
    this.element.append(this.video, this.subtitleOverlay, this.controlsBar);

    // イベントバインド
    this.bindEvents(options);

    // 字幕の巡回タイマー開始 (3.5秒ごと)
    this.startSubtitleLoop();

    // 初期再生の試行
    void this.video.play().catch(() => {
      this.updatePlayIcon(false);
    });
  }

  private bindEvents(options: VideoPlayerOptions): void {
    // 再生/一時停止クリック
    const togglePlay = () => {
      if (this.video.paused) {
        void this.video.play();
        this.updatePlayIcon(true);
      } else {
        this.video.pause();
        this.updatePlayIcon(false);
      }
    };

    this.playBtn.addEventListener('click', togglePlay);
    this.video.addEventListener('click', togglePlay);

    this.video.addEventListener('play', () => this.updatePlayIcon(true));
    this.video.addEventListener('pause', () => this.updatePlayIcon(false));

    // 音量 & ミュート
    this.volumeBtn.addEventListener('click', () => {
      if (this.video.muted || this.video.volume === 0) {
        this.video.muted = false;
        this.video.volume = 0.5;
        this.volumeSlider.value = '0.5';
        this.updateVolumeIcon(false);
      } else {
        this.video.muted = true;
        this.volumeSlider.value = '0';
        this.updateVolumeIcon(true);
      }
    });

    this.volumeSlider.addEventListener('input', () => {
      const val = Number(this.volumeSlider.value);
      this.video.volume = val;
      this.video.muted = val === 0;
      this.updateVolumeIcon(val === 0);
    });

    // 字幕切替クリック
    this.subtitleBtn.addEventListener('click', () => {
      this.setSubtitlesEnabled(!this.isSubtitlesEnabled);
      options.onSubtitleToggle?.(this.isSubtitlesEnabled);
    });

    // 音声切替クリック
    this.audioBtn.addEventListener('click', () => {
      this.currentAudioTrack = this.currentAudioTrack === 'main' ? 'sub' : 'main';
      const textSpan = this.audioBtn.querySelector('.btn-text');
      if (textSpan) {
        textSpan.textContent = this.currentAudioTrack === 'main' ? '主音声' : '副音声';
      }
      this.audioBtn.classList.toggle('sub', this.currentAudioTrack === 'sub');
      options.onAudioTrackChange?.(this.currentAudioTrack);
    });

    // PiP クリック
    this.pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled) {
          await this.video.requestPictureInPicture();
        }
      } catch (err) {
        console.warn('PiP error:', err);
      }
    });

    // 全画面クリック
    this.fullscreenBtn.addEventListener('click', async () => {
      try {
        if (!document.fullscreenElement) {
          await this.element.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (err) {
        console.warn('Fullscreen error:', err);
      }
    });

    // コントロールバーの自動非表示 (マウス停止時)
    const showControls = () => {
      this.controlsBar.classList.remove('hidden');
      if (this.hideControlsTimer !== null) clearTimeout(this.hideControlsTimer);
      if (!this.video.paused) {
        this.hideControlsTimer = window.setTimeout(() => {
          this.controlsBar.classList.add('hidden');
        }, 3000);
      }
    };

    this.element.addEventListener('mousemove', showControls);
    this.element.addEventListener('touchstart', showControls, { passive: true });
    this.element.addEventListener('mouseleave', () => {
      if (!this.video.paused) {
        this.controlsBar.classList.add('hidden');
      }
    });

    // キーボードショートカット
    this.element.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'm') {
        e.preventDefault();
        this.volumeBtn.click();
      } else if (e.key === 'c') {
        e.preventDefault();
        this.subtitleBtn.click();
      } else if (e.key === 'f') {
        e.preventDefault();
        this.fullscreenBtn.click();
      }
    });
  }

  public setSubtitlesEnabled(enabled: boolean): void {
    this.isSubtitlesEnabled = enabled;
    this.subtitleOverlay.style.display = enabled ? 'flex' : 'none';
    this.subtitleBtn.classList.toggle('active', enabled);

    const textSpan = this.subtitleBtn.querySelector('.btn-text');
    if (textSpan) {
      textSpan.textContent = enabled ? '字幕 ON' : '字幕 OFF';
    }
  }

  private startSubtitleLoop(): void {
    this.subtitleTimer = window.setInterval(() => {
      if (!this.isSubtitlesEnabled || this.video.paused) return;
      this.subtitleIndex = (this.subtitleIndex + 1) % this.mockSubtitles.length;
      this.subtitleText.textContent = this.mockSubtitles[this.subtitleIndex] ?? '';
    }, 3500);
  }

  private updatePlayIcon(isPlaying: boolean): void {
    this.playIcon.innerHTML = isPlaying
      ? `<svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
      : `<svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  }

  private updateVolumeIcon(isMuted: boolean): void {
    this.volumeIcon.innerHTML = isMuted
      ? `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`
      : `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
  }

  public destroy(): void {
    if (this.hideControlsTimer !== null) {
      clearTimeout(this.hideControlsTimer);
      this.hideControlsTimer = null;
    }
    if (this.subtitleTimer !== null) {
      clearInterval(this.subtitleTimer);
      this.subtitleTimer = null;
    }
    this.video.pause();
    this.video.src = '';
    this.video.load();
  }
}
