// beta 版の動作報告を受け取る（Cloudflare Pages Functions）。
//
// 受け取るのは src/reports/report-schema.ts が決めた項目だけで、1つでも
// 違えば捨てる。**IP アドレスも User-Agent も保存しない。**日付は日単位にする。
//
// beta 以外のホストでは受け付けない。関数は本番のデプロイにも入るが、
// 本番から報告が届くことはない（本番のビルドは送らない）ので、届いたら
// 何かがおかしい。保存先（D1）の結び付けも beta（Preview）にだけある。

import { parseReport } from '../../src/reports/report-schema';

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1Statement;
}

export interface ReportEnv {
  readonly REPORTS_DB?: D1Database;
}

const BETA_HOSTS = new Set(['beta.webts.app', 'beta.webts-app.pages.dev']);
const MAX_BODY_BYTES = 1024;

export async function handleReport(request: Request, env: ReportEnv): Promise<Response> {
  if (!BETA_HOSTS.has(new URL(request.url).hostname) || env.REPORTS_DB === undefined) {
    return new Response(null, { status: 404 });
  }
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    return new Response(null, { status: 415 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = parseReport(body);
  if (report === null) return new Response(null, { status: 400 });

  await env.REPORTS_DB.prepare(
    'INSERT INTO reports (day, v, model, os, browser, browser_major, kind, wave, result, stage, code)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    new Date().toISOString().slice(0, 10),
    report.v, report.model, report.os, report.browser, report.browserMajor,
    report.kind, report.wave, report.result, report.stage, report.code,
  ).run();
  return new Response(null, { status: 204 });
}

export const onRequestPost = (context: { request: Request; env: ReportEnv }): Promise<Response> =>
  handleReport(context.request, context.env);
