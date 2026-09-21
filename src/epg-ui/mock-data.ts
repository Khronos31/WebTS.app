// EPGStation準拠のチャンネルおよび番組モックデータ

import type { ChannelItem, ProgramItem, OnAirScheduleItem, RegionScanOption } from './types';

export const MOCK_CHANNELS: ChannelItem[] = [
  // 地上波 (GR) - 実機 192.168.1.135:8888 の東京・関東エリアに準拠（マルチチャンネル網羅）
  { id: 3273601024, serviceId: 1024, networkId: 32736, name: 'ＮＨＫ総合１・東京', halfWidthName: 'NHK総合1・東京', channelType: 'GR', channel: '27', remoteControlKeyId: 1, isPrimary: true, isSubChannel: false },
  { id: 3273601025, serviceId: 1025, networkId: 32736, name: 'ＮＨＫ総合２・東京', halfWidthName: 'NHK総合2・東京', channelType: 'GR', channel: '27', remoteControlKeyId: 1, isPrimary: false, isSubChannel: true },

  { id: 3273701032, serviceId: 1032, networkId: 32737, name: 'ＮＨＫＥテレ１東京', halfWidthName: 'NHKEテレ1東京', channelType: 'GR', channel: '26', remoteControlKeyId: 2, isPrimary: true, isSubChannel: false },
  { id: 3273701033, serviceId: 1033, networkId: 32737, name: 'ＮＨＫＥテレ２東京', halfWidthName: 'NHKEテレ2東京', channelType: 'GR', channel: '26', remoteControlKeyId: 2, isPrimary: false, isSubChannel: true },
  { id: 3273701034, serviceId: 1034, networkId: 32737, name: 'ＮＨＫＥテレ３東京', halfWidthName: 'NHKEテレ3東京', channelType: 'GR', channel: '26', remoteControlKeyId: 2, isPrimary: false, isSubChannel: true },

  { id: 3273801040, serviceId: 1040, networkId: 32738, name: '日テレ１', halfWidthName: '日テレ1', channelType: 'GR', channel: '25', remoteControlKeyId: 4, isPrimary: true, isSubChannel: false },
  { id: 3273801041, serviceId: 1041, networkId: 32738, name: '日テレ２', halfWidthName: '日テレ2', channelType: 'GR', channel: '25', remoteControlKeyId: 4, isPrimary: false, isSubChannel: true },

  { id: 3274101064, serviceId: 1064, networkId: 32741, name: 'テレビ朝日', halfWidthName: 'テレビ朝日', channelType: 'GR', channel: '24', remoteControlKeyId: 5, isPrimary: true, isSubChannel: false },
  { id: 3274101065, serviceId: 1065, networkId: 32741, name: 'テレビ朝日２', halfWidthName: 'テレビ朝日2', channelType: 'GR', channel: '24', remoteControlKeyId: 5, isPrimary: false, isSubChannel: true },
  { id: 3274101066, serviceId: 1066, networkId: 32741, name: 'テレビ朝日３', halfWidthName: 'テレビ朝日3', channelType: 'GR', channel: '24', remoteControlKeyId: 5, isPrimary: false, isSubChannel: true },

  { id: 3273901048, serviceId: 1048, networkId: 32739, name: 'ＴＢＳ１', halfWidthName: 'TBS1', channelType: 'GR', channel: '22', remoteControlKeyId: 6, isPrimary: true, isSubChannel: false },
  { id: 3273901049, serviceId: 1049, networkId: 32739, name: 'ＴＢＳ２', halfWidthName: 'TBS2', channelType: 'GR', channel: '22', remoteControlKeyId: 6, isPrimary: false, isSubChannel: true },

  { id: 3274201072, serviceId: 1072, networkId: 32742, name: 'テレ東', halfWidthName: 'テレ東', channelType: 'GR', channel: '23', remoteControlKeyId: 7, isPrimary: true, isSubChannel: false },
  { id: 3274201073, serviceId: 1073, networkId: 32742, name: 'テレ東２', halfWidthName: 'テレ東2', channelType: 'GR', channel: '23', remoteControlKeyId: 7, isPrimary: false, isSubChannel: true },
  { id: 3274201074, serviceId: 1074, networkId: 32742, name: 'テレ東３', halfWidthName: 'テレ東3', channelType: 'GR', channel: '23', remoteControlKeyId: 7, isPrimary: false, isSubChannel: true },

  { id: 3274001056, serviceId: 1056, networkId: 32740, name: 'フジテレビ', halfWidthName: 'フジテレビ', channelType: 'GR', channel: '21', remoteControlKeyId: 8, isPrimary: true, isSubChannel: false },
  { id: 3274001057, serviceId: 1057, networkId: 32740, name: 'フジテレビ２', halfWidthName: 'フジテレビ2', channelType: 'GR', channel: '21', remoteControlKeyId: 8, isPrimary: false, isSubChannel: true },
  { id: 3274001058, serviceId: 1058, networkId: 32740, name: 'フジテレビ３', halfWidthName: 'フジテレビ3', channelType: 'GR', channel: '21', remoteControlKeyId: 8, isPrimary: false, isSubChannel: true },

  { id: 3239123608, serviceId: 23608, networkId: 32391, name: 'ＴＯＫＹＯ　ＭＸ１', halfWidthName: 'TOKYO MX1', channelType: 'GR', channel: '16', remoteControlKeyId: 9, isPrimary: true, isSubChannel: false },
  { id: 3239123610, serviceId: 23610, networkId: 32391, name: 'ＴＯＫＹＯ　ＭＸ２', halfWidthName: 'TOKYO MX2', channelType: 'GR', channel: '16', remoteControlKeyId: 9, isPrimary: false, isSubChannel: true },

  { id: 3237524632, serviceId: 24632, networkId: 32375, name: 'ｔｖｋ１', halfWidthName: 'tvk1', channelType: 'GR', channel: '31', remoteControlKeyId: 3, isPrimary: true, isSubChannel: false },
  { id: 3237524633, serviceId: 24633, networkId: 32375, name: 'ｔｖｋ２', halfWidthName: 'tvk2', channelType: 'GR', channel: '31', remoteControlKeyId: 3, isPrimary: false, isSubChannel: true },
  { id: 3237524634, serviceId: 24634, networkId: 32375, name: 'ｔｖｋ３', halfWidthName: 'tvk3', channelType: 'GR', channel: '31', remoteControlKeyId: 3, isPrimary: false, isSubChannel: true },

  { id: 3229529752, serviceId: 29752, networkId: 32295, name: 'テレ玉１', halfWidthName: 'テレ玉1', channelType: 'GR', channel: '32', remoteControlKeyId: 3, isPrimary: true, isSubChannel: false },
  { id: 3229529754, serviceId: 29754, networkId: 32295, name: 'テレ玉２', halfWidthName: 'テレ玉2', channelType: 'GR', channel: '32', remoteControlKeyId: 3, isPrimary: false, isSubChannel: true },

  { id: 3232727704, serviceId: 27704, networkId: 32327, name: 'チバテレ１', halfWidthName: 'チバテレ1', channelType: 'GR', channel: '30', remoteControlKeyId: 3, isPrimary: true, isSubChannel: false },
  { id: 3232727705, serviceId: 27705, networkId: 32327, name: 'チバテレ２', halfWidthName: 'チバテレ2', channelType: 'GR', channel: '30', remoteControlKeyId: 3, isPrimary: false, isSubChannel: true },
  { id: 3232727706, serviceId: 27706, networkId: 32327, name: 'チバテレ３', halfWidthName: 'チバテレ3', channelType: 'GR', channel: '30', remoteControlKeyId: 3, isPrimary: false, isSubChannel: true },

  // 衛星放送 (BS)
  { id: 400101, serviceId: 101, networkId: 4, name: 'ＮＨＫ ＢＳ', halfWidthName: 'NHK BS', channelType: 'BS', channel: 'BS15_0', remoteControlKeyId: 1, isPrimary: true, isSubChannel: false },
  { id: 400141, serviceId: 141, networkId: 4, name: 'ＢＳ日テレ', halfWidthName: 'BS日テレ', channelType: 'BS', channel: 'BS13_0', remoteControlKeyId: 4, isPrimary: true, isSubChannel: false },
  { id: 400151, serviceId: 151, networkId: 4, name: 'ＢＳ朝日１', halfWidthName: 'BS朝日1', channelType: 'BS', channel: 'BS01_0', remoteControlKeyId: 5, isPrimary: true, isSubChannel: false },
  { id: 400161, serviceId: 161, networkId: 4, name: 'ＢＳ－ＴＢＳ', halfWidthName: 'BS-TBS', channelType: 'BS', channel: 'BS01_1', remoteControlKeyId: 6, isPrimary: true, isSubChannel: false },
  { id: 400171, serviceId: 171, networkId: 4, name: 'ＢＳテレ東', halfWidthName: 'BSテレ東', channelType: 'BS', channel: 'BS03_1', remoteControlKeyId: 7, isPrimary: true, isSubChannel: false },
  { id: 400181, serviceId: 181, networkId: 4, name: 'ＢＳフジ・１８１', halfWidthName: 'BSフジ・181', channelType: 'BS', channel: 'BS15_1', remoteControlKeyId: 8, isPrimary: true, isSubChannel: false },
  { id: 400211, serviceId: 211, networkId: 4, name: 'ＢＳ１１イレブン', halfWidthName: 'BS11イレブン', channelType: 'BS', channel: 'BS09_0', remoteControlKeyId: 11, isPrimary: true, isSubChannel: false },
  { id: 400222, serviceId: 222, networkId: 4, name: 'ＢＳ１２トゥエルビ', halfWidthName: 'BS12トゥエルビ', channelType: 'BS', channel: 'BS09_1', remoteControlKeyId: 12, isPrimary: true, isSubChannel: false },

  // CS放送
  { id: 600055, serviceId: 55, networkId: 6, name: 'ショップチャンネル', halfWidthName: 'ショップチャンネル', channelType: 'CS', channel: 'CS02', remoteControlKeyId: 55, isPrimary: true, isSubChannel: false },
  { id: 600296, serviceId: 296, networkId: 6, name: 'ＴＢＳチャンネル１', halfWidthName: 'TBSチャンネル1', channelType: 'CS', channel: 'CS14', remoteControlKeyId: 296, isPrimary: true, isSubChannel: false },
  { id: 600310, serviceId: 310, networkId: 6, name: 'スーパー！ドラマＴＶ', halfWidthName: 'スーパー!ドラマTV', channelType: 'CS', channel: 'CS08', remoteControlKeyId: 310, isPrimary: true, isSubChannel: false },
  { id: 600330, serviceId: 330, networkId: 6, name: 'キッズステーション', halfWidthName: 'キッズステーション', channelType: 'CS', channel: 'CS12', remoteControlKeyId: 330, isPrimary: true, isSubChannel: false },
];

export interface ProgramTemplate {
  name: string;
  description: string;
  genre: string;
  durationMinutes: number;
  extended?: Record<string, string> | undefined;
}

// チャンネルごとの番組テンプレートプール
const POOL_GR1: ProgramTemplate[] = [
  {
    name: 'ニュースウオッチ９▽国内外の重要ニュースを徹底解説',
    description: '日本と世界の「いま」を深く掘り下げて伝えます。最新の政治・経済・社会ニュース、気象情報、スポーツハイライトなど分かりやすくお届けします。',
    genre: 'ニュース/報道',
    durationMinutes: 60,
    extended: { '出演者': '【キャスター】広内仁、星麻琴\n【気象情報】斉田季実治', '番組内容': '▽最新の国内外ニュース\n▽激動の世界情勢の背景\n▽明日の全国天気予報' },
  },
  {
    name: 'クローズアップ現代▽未来を変える最新テクノロジー最前線',
    description: '現代社会が直面する課題や変革の兆しを独自の視点と徹底的な現場取材で描くドキュメンタリー。',
    genre: 'ドキュメンタリー/教養',
    durationMinutes: 30,
    extended: { 'キャスター': '桑子真帆', 'テーマ': 'AIと社会の共存、自動運転の現在地' },
  },
  {
    name: '時論公論▽経済展望と暮らしの行方',
    description: 'NHK解説委員がニュースの深層をわかりやすくコンパクトに解説します。',
    genre: 'ニュース/報道',
    durationMinutes: 15,
  },
];

const POOL_GR2: ProgramTemplate[] = [
  {
    name: 'デザインあｎｅｏ「観察と構造」',
    description: '身の回りのデザインを、映像と音楽で新鮮な感覚とともに見つめ直す番組。ものの形や仕組みに隠された意味を解き明かします。',
    genre: '趣味/教育',
    durationMinutes: 15,
    extended: { '音楽': 'Cornelius / 蓮沼執太', 'デザイン監修': '佐藤卓' },
  },
  {
    name: 'ピタゴラスイッチ「かさなる・うごくの巻」',
    description: '子どもたちの「考え方」を育てる番組。ピタゴラそうち、アルゴリズムこうしん、フレーミーなど人気コーナー満載！',
    genre: 'アニメ/特撮',
    durationMinutes: 15,
  },
  {
    name: '日曜美術館・選「美の旅路・光を紡ぐ画家たち」',
    description: '名画に隠されたドラマと美の真髄を巡る美術紀行。',
    genre: 'ドキュメンタリー/教養',
    durationMinutes: 45,
  },
];

const POOL_GR4: ProgramTemplate[] = [
  {
    name: '金曜ロードショー「名作劇場・超大作SFアドベンチャー」',
    description: '世界中を熱狂させた大ヒット映画をノーカット地上波初放送！未知の宇宙と人類の未来を描く感動の超大作。',
    genre: '映画',
    durationMinutes: 120,
    extended: { '監督': 'クリストファー・ノーラン', '出演': 'マシュー・マコノヒー、アン・ハサウェイ' },
  },
  {
    name: 'news zero▽速報・今日のまとめとカルチャー＆スポーツ',
    description: '「あなたのプラスに」をコンセプトに、今日起きたニュースをいち早く、多角的に伝えます。',
    genre: 'ニュース/報道',
    durationMinutes: 60,
  },
];

const POOL_GR5: ProgramTemplate[] = [
  {
    name: '報道ステーション▽最新ニュース＆スポーツ・徹底検証',
    description: '「きょう、知りたいこと」を深く、温かく、分かりやすくお伝えします。熱闘甲子園やプロ野球の速報も充実！',
    genre: 'ニュース/報道',
    durationMinutes: 70,
    extended: { 'メインキャスター': '大越健介', 'サブキャスター': '安藤萌々' },
  },
  {
    name: 'テレビ千鳥▽大人気企画！面白実験バラエティ',
    description: '千鳥の二人が送る純度100％の爆笑バラエティ番組！今夜は前代未聞のチャレンジ企画。',
    genre: 'バラエティ',
    durationMinutes: 30,
  },
];

const POOL_GR6: ProgramTemplate[] = [
  {
    name: '日曜劇場「エンジニアズ・ドリーム」第８話',
    description: '不可能と言われた新世代ブラウザとWeb技術の革新に挑む開発者たちの熱き闘いを描くヒューマンドラマ。',
    genre: 'ドラマ',
    durationMinutes: 54,
    extended: { '出演': '堺雅人、阿部寛、二階堂ふみ', '主題歌': '米津玄師' },
  },
  {
    name: 'news23▽多角的な視点から本質に迫る夜の報道番組',
    description: 'いま世界と日本で何が起きているのか。現場からの生の声とともに深掘り解説。',
    genre: 'ニュース/報道',
    durationMinutes: 55,
  },
];

const POOL_GR7: ProgramTemplate[] = [
  {
    name: 'ワールドビジネスサテライト (WBS)▽経済の最前線を生放送',
    description: '日経新聞グループの総力を結集した夜の看板経済番組。ビジネスパーソン必見の「トレンドたまご」も！',
    genre: 'ニュース/報道',
    durationMinutes: 60,
  },
  {
    name: 'ガイアの夜明け▽メイド・イン・ジャパンの逆襲',
    description: '厳しいビジネス界で独自の技術と情熱で活路を切り拓く人々のドラマを追う経済ドキュメンタリー。',
    genre: 'ドキュメンタリー/教養',
    durationMinutes: 54,
  },
];

const POOL_GR8: ProgramTemplate[] = [
  {
    name: '火曜ドラマ「コード・シンフォニー」第５話',
    description: '最前線のサイバーセキュリティチームが国家規模のデジタル危機に立ち向かうスリリングなサスペンス！',
    genre: 'ドラマ',
    durationMinutes: 54,
  },
  {
    name: '人志松本の酒のツマミになる話▽大爆笑トーク連発！',
    description: '普段言えないような本音や、クスッと笑える実体験を語り明かすトークバラエティ。',
    genre: 'バラエティ',
    durationMinutes: 58,
  },
];

const POOL_GR9: ProgramTemplate[] = [
  {
    name: '新作アニメ「デジタル・フロンティア」第１１話',
    description: '仮想空間と現実が交錯する世界で繰り広げられるサイバーパンク・アクションアニメーション！',
    genre: 'アニメ/特撮',
    durationMinutes: 30,
    extended: { '声の出演': '内田真礼、松岡禎丞、佐倉綾音' },
  },
  {
    name: '５時に夢中！▽東京の夕方を熱くする生ワイドショー',
    description: '歯に衣着せぬコメンテーター陣による爽快かつ刺激的な情報番組。',
    genre: '情報/ワイドショー',
    durationMinutes: 60,
  },
];

const POOL_BS: ProgramTemplate[] = [
  {
    name: 'プレミアムシネマ「名作クラシック劇場」',
    description: '映画史に燦然と輝く名作を最高画質のデジタルリマスター版でお届けします。',
    genre: '映画',
    durationMinutes: 120,
  },
  {
    name: '世界ふれあい街歩き「歴史とアートが息づく街」',
    description: '旅人の目線で世界の美しい街並みを歩く紀行番組。路地裏の温かな出会いをお届け。',
    genre: 'ドキュメンタリー/教養',
    durationMinutes: 60,
  },
  {
    name: '日本百名山・厳選紀行「朝日に輝くアルプスの峰々」',
    description: 'ドローン映像と4Kカメラで迫る圧倒的な大自然のパノラマ映像。',
    genre: 'ドキュメンタリー/教養',
    durationMinutes: 45,
  },
];

const POOL_CS: ProgramTemplate[] = [
  {
    name: '海外ドラマ「CSI: サイバー捜査班」シーズン３',
    description: '最先端のデジタル証拠から犯人を追い詰める全米大ヒットクライムサスペンス。',
    genre: 'ドラマ',
    durationMinutes: 55,
  },
  {
    name: 'アニメ一挙放送「レジェンド・オブ・ヒーロー」',
    description: '根強い人気を誇るバトルアクションアニメの人気エピソードを連続放送！',
    genre: 'アニメ/特撮',
    durationMinutes: 60,
  },
];

function getProgramPoolForChannel(channel: ChannelItem): ProgramTemplate[] {
  if (channel.channelType === 'BS') return POOL_BS;
  if (channel.channelType === 'CS') return POOL_CS;

  const key = channel.remoteControlKeyId;
  switch (key) {
    case 1: return POOL_GR1;
    case 2: return POOL_GR2;
    case 4: return POOL_GR4;
    case 5: return POOL_GR5;
    case 6: return POOL_GR6;
    case 7: return POOL_GR7;
    case 8: return POOL_GR8;
    case 9: return POOL_GR9;
    default: return POOL_GR1;
  }
}

/**
 * 現在時刻 (Date.now()) に基づいてリアルタイムに消化率と番組を生成する関数
 */
export function generateOnAirSchedules(now: number = Date.now(), onlyEnabled: boolean = true): OnAirScheduleItem[] {
  const enabledIds = onlyEnabled ? getEnabledChannelIds() : null;
  const targetChannels = enabledIds
    ? MOCK_CHANNELS.filter((ch) => enabledIds.has(ch.id))
    : MOCK_CHANNELS;

  return targetChannels.map((channel, idx) => {
    const pool = getProgramPoolForChannel(channel);
    const firstTemplate = pool[0];
    const baseDuration = (firstTemplate ? firstTemplate.durationMinutes : 45) * 60 * 1000;

    // 各チャンネルごとに異なる開始時刻になるようチャンネルIDでシードオフセットをつける
    const offsetSeed = (channel.id % 7) * 7 * 60 * 1000;

    // 現在時刻が番組期間内に収まるように計算
    const currentStart = Math.floor((now - offsetSeed) / baseDuration) * baseDuration + offsetSeed;
    const currentEnd = currentStart + baseDuration;
    const nextStart = currentEnd;

    const templateIndex = Math.abs((Math.floor(now / baseDuration) + idx) % pool.length);
    const nextTemplateIndex = (templateIndex + 1) % pool.length;

    const currentTemplate = pool[templateIndex] ?? pool[0]!;
    const nextTemplate = pool[nextTemplateIndex] ?? pool[0]!;
    const nextEnd = nextStart + (nextTemplate.durationMinutes * 60 * 1000);

    const elapsed = Math.max(0, now - currentStart);
    const total = Math.max(1, currentEnd - currentStart);
    const digestibility = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));

    const currentProgram: ProgramItem = {
      id: channel.id * 1000 + 1,
      channelId: channel.id,
      startAt: currentStart,
      endAt: currentEnd,
      name: currentTemplate.name,
      description: currentTemplate.description,
      extended: currentTemplate.extended,
      genre: currentTemplate.genre,
      videoType: '1080i (MPEG2)',
      audioMode: 'ステレオ (AAC)',
    };

    const nextProgram: ProgramItem = {
      id: channel.id * 1000 + 2,
      channelId: channel.id,
      startAt: nextStart,
      endAt: nextEnd,
      name: nextTemplate.name,
      description: nextTemplate.description,
      extended: nextTemplate.extended,
      genre: nextTemplate.genre,
      videoType: '1080i (MPEG2)',
      audioMode: 'ステレオ (AAC)',
    };

    return {
      channel,
      currentProgram,
      nextProgram,
      digestibility,
    };
  });
}

/**
 * 地上デジタル全帯域物理チャンネル (UHF 13ch 〜 52ch)
 */
export const FULL_SCAN_PHYSICAL_CHANNELS: number[] = Array.from({ length: 40 }, (_, i) => i + 13);

const ENABLED_CHANNELS_STORAGE_KEY = 'webts_enabled_channels';

/**
 * デフォルトの有効チャンネルID一覧（代表局のみON、マルチ編成サブチャンネルはOFF）
 */
export function getDefaultEnabledChannelIds(): Set<number> {
  const ids = new Set<number>();
  for (const ch of MOCK_CHANNELS) {
    if (ch.isPrimary !== false) {
      ids.add(ch.id);
    }
  }
  return ids;
}

/**
 * 有効（チェック済み）のチャンネルID一覧を取得
 */
export function getEnabledChannelIds(): Set<number> {
  try {
    const saved = localStorage.getItem(ENABLED_CHANNELS_STORAGE_KEY);
    if (saved !== null) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length > 0) {
        return new Set<number>(arr);
      }
    }
  } catch {
    // ignore
  }
  return getDefaultEnabledChannelIds();
}

/**
 * 有効チャンネルID一覧を保存
 */
export function saveEnabledChannelIds(ids: number[] | Set<number>): void {
  const arr = Array.from(ids);
  try {
    localStorage.setItem(ENABLED_CHANNELS_STORAGE_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('webts-channels-changed', { detail: { channelIds: arr } }));
}
