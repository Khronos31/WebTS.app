import { describe, expect, it } from 'vitest';
import { handleReport, type ReportEnv } from '../functions/api/report';
import { parseReport } from '../src/reports/report-schema';

// 送ってよいのは決めた項目だけ。受け側がそれ以外を保存しないことを確かめる。

const ok = {
  v: '0.2.1-beta', model: 'PX-W3U4', os: 'Windows', browser: 'Chrome', browserMajor: 140,
  kind: 'view', wave: 'GR', result: 'ok', stage: -1, code: 0, detail: 'none',
};

describe('report schema', () => {
  it('accepts a well-formed report', () => {
    expect(parseReport(ok)).toEqual(ok);
    expect(parseReport({ ...ok, result: 'failed', stage: 7, code: 6 })).not.toBeNull();
    expect(parseReport({ ...ok, kind: 'scan', wave: 'CS', result: 'no-signal' })).not.toBeNull();
  });

  it('carries why opening failed, as a fixed word only', () => {
    const failed = { ...ok, kind: 'scan', result: 'failed', stage: 2, code: 3 };
    expect(parseReport({ ...failed, detail: 'descriptor-unreadable' })?.detail)
      .toBe('descriptor-unreadable');
    expect(parseReport({ ...failed, detail: 'COM3 busy' })).toBeNull();
    // 止まっていないのに理由があるのはおかしい。
    expect(parseReport({ ...ok, detail: 'busy' })).toBeNull();
  });

  it('carries why the card did not start, as a fixed word only', () => {
    const failed = { ...ok, result: 'failed', stage: 4, code: 9 };
    expect(parseReport({ ...failed, detail: 'card-connect-timeout' })?.detail)
      .toBe('card-connect-timeout');
    expect(parseReport({ ...failed, detail: 'card-init' })?.detail).toBe('card-init');
    expect(parseReport({ ...failed, detail: 'card-connect-3B0212' })).toBeNull();
  });

  it('accepts reports from pages older than detail as none', () => {
    const { detail: _detail, ...older } = ok;
    expect(parseReport(older)?.detail).toBe('none');
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

  it('carries how a recording ended or failed, and how playback stopped', () => {
    const record = { ...ok, kind: 'record' };
    expect(parseReport(record)).not.toBeNull();
    expect(parseReport({ ...record, result: 'incomplete', detail: 'record-gap' })?.detail)
      .toBe('record-gap');
    expect(parseReport({ ...record, result: 'failed', stage: 0, detail: 'record-quota' })?.detail)
      .toBe('record-quota');
    // 途中終了は録画だけ。理由は決まった語だけ。
    expect(parseReport({ ...ok, result: 'incomplete', detail: 'record-gap' })).toBeNull();
    expect(parseReport({ ...record, result: 'incomplete', detail: 'record gap at 12:00' })).toBeNull();
    // 再生はチューナーを使わないので、機種は none。
    expect(parseReport({ ...ok, kind: 'playback', model: 'none', result: 'failed', stage: 0,
      detail: 'playback-no-video' })).not.toBeNull();
    // 途中終了の理由は stage と code を持たない。
    expect(parseReport({ ...record, result: 'incomplete', stage: 3, detail: 'record-gap' })).toBeNull();
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
  it('stores a valid report, with the day and nothing about the sender', async () => {
    const { env, rows } = fakeDatabase();
    const response = await handleReport(post('webts.app', JSON.stringify(ok)), env);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    const [day, ...rest] = rows[0]!;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rest).toEqual(['0.2.1-beta', 'PX-W3U4', 'Windows', 'Chrome', 140,
      'view', 'GR', 'ok', -1, 0, 'none']);
  });

  it('accepts reports from both production hosts', async () => {
    const { env, rows } = fakeDatabase();
    for (const host of ['webts.app', 'webts-app.pages.dev']) {
      expect((await handleReport(post(host, JSON.stringify(ok)), env)).status).toBe(204);
    }
    expect(rows).toHaveLength(2);
  });

  it('does not accept reports on other hosts', async () => {
    const { env, rows } = fakeDatabase();
    // beta は 0.4.0 でやめた。古い beta のページから届いても受け取らない。
    for (const host of ['evil.example', 'webts.app.evil.example', '87acda07.webts-app.pages.dev',
      'beta.webts.app', 'beta.webts-app.pages.dev']) {
      expect((await handleReport(post(host, JSON.stringify(ok)), env)).status).toBe(404);
    }
    expect(rows).toHaveLength(0);
  });

  it('does nothing without the database binding', async () => {
    const response = await handleReport(post('webts.app', JSON.stringify(ok)), {});
    expect(response.status).toBe(404);
  });

  it('rejects malformed, oversized or extra-field bodies', async () => {
    const { env, rows } = fakeDatabase();
    expect((await handleReport(post('webts.app', '{'), env)).status).toBe(400);
    expect((await handleReport(post('webts.app', JSON.stringify({ ...ok, ip: '1.2.3.4' })), env))
      .status).toBe(400);
    expect((await handleReport(post('webts.app', 'x'.repeat(2000)), env)).status).toBe(413);
    expect((await handleReport(post('webts.app', JSON.stringify(ok), 'text/plain'), env))
      .status).toBe(415);
    expect(rows).toHaveLength(0);
  });
});
