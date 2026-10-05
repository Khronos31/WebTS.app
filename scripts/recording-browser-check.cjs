const { chromium } = require(process.env.WEBTS_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
// 任意のブラウザ結合チェック。Playwright はリポジトリ外に用意する。
// dev server と local/qa-recording.bin（6秒、serviceId=101、MPEG-2/AAC の生成信号）が必要。
// 新規の一時ブラウザcontextだけを使用し、チューナーや利用者の録画には触れない。
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.WEBTS_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${process.env.WEBTS_QA_URL || 'http://127.0.0.1:5173'}/#/recorded`);
  await page.getByText('録画された番組はありません').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: '/tmp/webts-empty.png' });
  await page.evaluate(async () => {
    const store = await import('/src/epg-ui/recording-store.ts');
    const bytes = new Uint8Array(await (await fetch('/local/qa-recording.bin')).arrayBuffer());
    const sink = await store.openRecordingSink('qa-fixture');
    await sink.write(bytes);
    await sink.commit({ version: 1, id: 'qa-fixture', title: 'QA用テスト映像', channelName: 'テスト信号', serviceId: 101, createdAt: Date.now(), durationMs: 6000, bytes: bytes.length, incompleteReason: 'UI確認用の生成信号' });
  });
  await page.getByRole('button', { name: 'QA用テスト映像 を再生' }).click();
  await page.waitForTimeout(1000);
  await page.locator('.recorded-playback .video-controls-bar button').first().click();
  await page.waitForTimeout(7000);
  assert.doesNotMatch(await page.locator('.recorded-playback').innerText(), /再生が終了しました/);
  await page.locator('.recorded-playback .video-controls-bar button').first().click();
  await page.waitForTimeout(500);
  assert.doesNotMatch(await page.locator('.recorded-playback').innerText(), /再生が終了しました/);
  await page.screenshot({ path: '/tmp/webts-playback.png' });
  console.log('playback status', await page.locator('.recorded-playback').innerText());
  await page.waitForTimeout(6000);
  assert.match(await page.locator('.recorded-playback').innerText(), /再生が終了しました/);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(1000); // drawer の resize/transition 完了後に撮る。
  await page.screenshot({ path: '/tmp/webts-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.recorded-playback .video-controls-bar').evaluate(bar =>
    [...bar.querySelectorAll('button')].every(button => {
      const r = button.getBoundingClientRect();
      const parent = bar.getBoundingClientRect();
      return r.left >= parent.left && r.right <= parent.right;
    })), true, 'mobile player buttons must remain inside the player');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/webts-light.png' });
  await page.reload();
  await page.getByRole('button', { name: 'QA用テスト映像 を再生' }).waitFor();
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'QA用テスト映像 を削除' }).click();
  await page.getByText('録画された番組はありません').waitFor();
  assert.deepEqual(errors, []);
  // チューナーを模倣せず、録画UIへ既知のTS断片を直接渡して保存の接続を確認。
  await page.evaluate(async () => {
    const { RecordingControl } = await import('/src/epg-ui/components/recording-control.ts');
    const control = new RecordingControl(() => ({ title: 'QA キャプチャ', channelName: 'テスト信号', serviceId: 101 }));
    control.setReady(true);
    document.querySelector('main').prepend(control.element);
    window.qaRecording = control;
  });
  await page.getByRole('button', { name: '30秒録画を開始' }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: '/tmp/webts-record-dialog.png' });
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.getByRole('button', { name: '30秒録画を開始' }).click();
  await page.getByRole('button', { name: '録画する', exact: true }).click();
  await page.getByText('あと30秒', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/local/qa-recording.bin')).arrayBuffer());
    window.qaRecording.push(bytes.subarray(0, 188 * 100));
    await window.qaRecording.finish('QAで手動終了');
  });
  await page.getByRole('button', { name: 'QA キャプチャ を再生' }).waitFor();
  await page.getByRole('button', { name: 'QA キャプチャ を削除' }).click();
  await page.evaluate(() => window.qaRecording.destroy());
  await page.getByText('録画された番組はありません').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS OPFS create/list/reload/delete, recorded playback, mobile width; no page errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
