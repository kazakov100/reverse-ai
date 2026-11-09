// POST /api/report: a report the reverse.ai app sends when a friend clicks Report.
// Checks it, then hands it to the Apps Script attached to the developer's Google Sheet, which adds one row
// (sheet/Code.gs). Nothing is logged or stored here. IP addresses are only hashed in memory, for the rate limit.
import { createHash, randomBytes } from 'node:crypto';

const MAX_BYTES = 4096;
// what the app sends -> the sheet's "Report" and "What happened" columns
const KINDS = {
  suggestion: ['Wrong suggestion', 'Suggested in the bubble'],
  auto: ['Wrong fix', 'Fixed automatically'],
  missed: ['Missed fix', 'Not fixed'],
};
const WHY = { sure: 'Word lists, sure', less_sure: 'Word lists, less sure', smart: 'Smart mode', '': '' };
// free-text fields and their maximum lengths
const TEXT = { typed: 500, result: 500, note: 500, from: 30, to: 30, app: 80, version: 20, system: 60, settings: 120 };
const REQUIRED = ['typed', 'from', 'to', 'version', 'system'];
const CONTROL = /[\u0000-\u001f\u007f]/;

// rate limit, per instance: 20 reports an hour per address, 300 an hour in all
const WINDOW_MS = 3_600_000, PER_ADDRESS = 20, PER_INSTANCE = 300;
const salt = randomBytes(16);
let hits = new Map(), all = [];

const reply = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(request) {
  if (request.headers.get('x-reverse-report') !== '1') return reply(401, { error: 'not a reverse.ai report' });
  if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return reply(413, { error: 'too big' });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BYTES) return reply(413, { error: 'too big' });

  const row = parse(raw);
  if (!row) return reply(400, { error: 'malformed report' });
  if (!allowed(request, Date.now())) return reply(429, { error: 'too many reports, try later' });

  const url = process.env.REPORT_SCRIPT_URL, secret = process.env.REPORT_SECRET;
  if (!url || !secret) return reply(503, { error: 'reports are not set up' });
  let answer;
  try {
    // Apps Script answers with a redirect to the result; following it (as a GET) is what Google expects
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, row }),
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    answer = res.ok ? (await res.text()).trim() : '';
  } catch {
    answer = '';
  }
  if (answer === 'ok') return reply(200, { ok: true });
  if (answer === 'full') return reply(429, { error: 'too many reports today' });
  return reply(502, { error: 'could not save the report' });
}

/** The report as the sheet's fields, or null if anything is missing, unknown, too long or not plain text. */
export function parse(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const key of Object.keys(body)) if (key !== 'kind' && key !== 'why' && !(key in TEXT)) return null;
  const kind = KINDS[body.kind], why = WHY[body.why ?? ''];
  if (!kind || why === undefined) return null;
  const row = { report: kind[0], happened: kind[1], why };
  for (const [key, max] of Object.entries(TEXT)) {
    const value = body[key] ?? '';
    if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) return null;
    row[key] = value.trim();
  }
  if (REQUIRED.some(key => row[key] === '')) return null;
  return row;
}

function allowed(request, now) {
  const address = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const key = createHash('sha256').update(salt).update(address).digest('base64url');
  const recent = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  all = all.filter(t => now - t < WINDOW_MS);
  if (recent.length >= PER_ADDRESS || all.length >= PER_INSTANCE) { hits.set(key, recent); return false; }
  recent.push(now); all.push(now); hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, ts] of hits) if (!ts.some(t => now - t < WINDOW_MS)) hits.delete(k);
  return true;
}

/** For tests only: forget the rate-limit counts. */
export function resetLimits() { hits = new Map(); all = []; }
