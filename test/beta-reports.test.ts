import { describe, expect, it } from 'vitest';
import { handleReport, type ReportEnv } from '../functions/api/report';
import { parseReport } from '../src/reports/report-schema';

// 送ってよいのは決めた項目だけ。受け側がそれ以外を保存しないことを確かめる。

const ok = {
  v: '0.2.1-beta', model: 'PX-W3U4', os: 'Windows', browser: 'Chrome', browserMajor: 140,
  kind: 'view', wave: 'GR', result: 'ok', stage: -1, code: 0,
};

describe('report schema', () => {
  it('accepts a well-formed report', () => {
    expect(parseReport(ok)).toEqual(ok);
    expect(parseReport({ ...ok, result: 'failed', stage: 7, code: 6 })).not.toBeNull();
    expect(parseReport({ ...ok, kind: 'scan', wave: 'CS', result: 'no-signal' })).not.toBeNull();
  });

  it('rejects anything extra or missing', () => {
    expect(parseReport({ ...ok, serial: 'X' })).toBeNull();
    const { code: _code, ...missing } = ok;
    expect(parseReport(missing)).toBeNull();
    expect(parseReport([ok])).toBeNull();
    expect(parseReport(null)).toBeNull();
  });

  it('rejects free text in the fields', () => {
    expect(parseReport({ ...ok, model: 'PX-W3U4 serial 1234 at C:\\Users\\name' })).toBeNull();
    expect(parseReport({ ...ok, os: 'Windows 11 Pro' })).toBeNull();
    expect(parseReport({ ...ok, v: '0.2.1 (home-pc)' })).toBeNull();
    expect(parseReport({ ...ok, wave: 'BS/CS' })).toBeNull();
  });

  it('keeps stage and code consistent with the result', () => {
    expect(parseReport({ ...ok, stage: 3 })).toBeNull();
    expect(parseReport({ ...ok, code: 6 })).toBeNull();
    expect(parseReport({ ...ok, result: 'failed', stage: -1, code: 6 })).toBeNull();
    expect(parseReport({ ...ok, result: 'failed', stage: 2.5, code: 6 })).toBeNull();
  });
});

function fakeDatabase() {
  const rows: unknown[][] = [];
  const env: ReportEnv = {
    REPORTS_DB: {
      prepare: () => {
        let values: unknown[] = [];
        const statement = {
          bind: (...bound: unknown[]) => { values = bound; return statement; },
          run: async () => { rows.push(values); return {}; },
        };
        return statement;
      },
    },
  };
  return { env, rows };
}

function post(host: string, body: string, type = 'application/json'): Request {
  return new Request(`https://${host}/api/report`, {
    method: 'POST', headers: { 'Content-Type': type }, body,
  });
}

describe('report endpoint', () => {
  it('stores a valid report from beta, with the day and nothing about the sender', async () => {
    const { env, rows } = fakeDatabase();
    const response = await handleReport(post('beta.webts.app', JSON.stringify(ok)), env);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    const [day, ...rest] = rows[0]!;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rest).toEqual(['0.2.1-beta', 'PX-W3U4', 'Windows', 'Chrome', 140,
      'view', 'GR', 'ok', -1, 0]);
  });

  it('does not accept reports on other hosts', async () => {
    const { env, rows } = fakeDatabase();
    for (const host of ['webts.app', 'webts-app.pages.dev', 'evil.example']) {
      expect((await handleReport(post(host, JSON.stringify(ok)), env)).status).toBe(404);
    }
    expect(rows).toHaveLength(0);
  });

  it('does nothing without the database binding', async () => {
    const response = await handleReport(post('beta.webts.app', JSON.stringify(ok)), {});
    expect(response.status).toBe(404);
  });

  it('rejects malformed, oversized or extra-field bodies', async () => {
    const { env, rows } = fakeDatabase();
    expect((await handleReport(post('beta.webts.app', '{'), env)).status).toBe(400);
    expect((await handleReport(post('beta.webts.app', JSON.stringify({ ...ok, ip: '1.2.3.4' })), env))
      .status).toBe(400);
    expect((await handleReport(post('beta.webts.app', 'x'.repeat(2000)), env)).status).toBe(413);
    expect((await handleReport(post('beta.webts.app', JSON.stringify(ok), 'text/plain'), env))
      .status).toBe(415);
    expect(rows).toHaveLength(0);
  });
});
