-- beta 版の動作報告（functions/api/report.ts が書く）。Cloudflare D1。
-- 項目は src/reports/report-schema.ts と同じ。IP も User-Agent も持たない。
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,            -- UTC の日付（YYYY-MM-DD）。時刻は持たない
  v TEXT NOT NULL,
  model TEXT NOT NULL,
  os TEXT NOT NULL,
  browser TEXT NOT NULL,
  browser_major INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- view | scan
  wave TEXT NOT NULL,           -- GR | BS | CS
  result TEXT NOT NULL,         -- ok | no-signal | failed
  stage INTEGER NOT NULL,
  code INTEGER NOT NULL
);

-- 集計の例：機種・波・結果ごとの件数
-- SELECT model, kind, wave, result, stage, code, COUNT(*) AS n
--   FROM reports GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4;
