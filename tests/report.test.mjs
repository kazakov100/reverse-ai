// node --test tests/   (no dependencies; the Apps Script call is mocked)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST, parse, resetLimits } from '../api/report.mjs';

const good = {
  kind: 'suggestion', why: 'less_sure', typed: 'sepearet auth and idv', from: 'English', to: 'Hebrew',
  result: 'דקפקשרקא שואי שמג ןגה', app: 'Slack', version: '0.1.4', system: 'Mac 15.6',
  settings: 'Strict · Smart on · Auto-fix off',
};
let calls, answer;

beforeEach(() => {
  resetLimits();
  process.env.REPORT_SCRIPT_URL = 'https://script.example/exec';
  process.env.REPORT_SECRET = 's3cret';
  calls = []; answer = 'ok';
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(answer); };
});

const send = (body, headers = { 'x-reverse-report': '1' }, ip = '1.2.3.4') =>
  POST(new Request('https://reverseai.vercel.app/api/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

test('a valid report is forwarded once, with the secret and the sheet fields', async () => {
  const res = await send(good);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://script.example/exec');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.secret, 's3cret');
  assert.deepEqual(sent.row, {
    report: 'Wrong suggestion', happened: 'Suggested in the bubble', why: 'Word lists, less sure',
    typed: 'sepearet auth and idv', result: 'דקפקשרקא שואי שמג ןגה', note: '', from: 'English', to: 'Hebrew',
    app: 'Slack', version: '0.1.4', system: 'Mac 15.6', settings: 'Strict · Smart on · Auto-fix off',
  });
});

test('every kind maps to its Report and What happened columns', () => {
  const kinds = {
    suggestion: ['Wrong suggestion', 'Suggested in the bubble'],
    auto: ['Wrong fix', 'Fixed automatically'],
    missed: ['Missed fix', 'Not fixed'],
  };
  for (const [kind, [report, happened]] of Object.entries(kinds)) {
    const row = parse(JSON.stringify({ ...good, kind }));
    assert.equal(row.report, report); assert.equal(row.happened, happened);
  }
});

test('without the header: 401, nothing forwarded', async () => {
  assert.equal((await send(good, {})).status, 401);
  assert.equal(calls.length, 0);
});

test('too big: 413', async () => {
  assert.equal((await send({ ...good, note: 'x'.repeat(5000) })).status, 413);
  assert.equal(calls.length, 0);
});

test('malformed reports: 400', async () => {
  const bad = [
    'not json', '[]', 'null',
    { ...good, kind: 'other' },
    { ...good, why: 'guess' },
    { ...good, extra: 'field' },
    { ...good, typed: '' },
    { ...good, version: undefined },
    { ...good, typed: 42 },
    { ...good, app: 'a'.repeat(81) },
    { ...good, typed: 'line\nbreak' },
  ];
  for (const body of bad) assert.equal((await send(body)).status, 400, JSON.stringify(body));
  assert.equal(calls.length, 0);
});

test('a formula-looking report is still accepted (the sheet stores it as text)', async () => {
  assert.equal((await send({ ...good, typed: '=IMPORTXML("http://x","//a")' })).status, 200);
});

test('rate limit: the 21st report in an hour from one address gets 429', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await send(good)).status, 200);
  assert.equal((await send(good)).status, 429);
  assert.equal((await send(good, undefined, '5.6.7.8')).status, 200);   // another address still gets through
});

test('the sheet refusing (wrong secret) is a 502, a full day is a 429', async () => {
  answer = 'no';
  assert.equal((await send(good)).status, 502);
  answer = 'full';
  assert.equal((await send(good)).status, 429);
});

test('the sheet unreachable: 502', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await send(good)).status, 502);
});

test('not set up: 503', async () => {
  delete process.env.REPORT_SECRET;
  assert.equal((await send(good)).status, 503);
});
