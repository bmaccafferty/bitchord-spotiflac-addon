import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignedSession } from '../src/spotiflac-qobuz-host.js';
const cfg = { baseUrl: 'https://api.zarz.moe/v2', callbackUrl: 'spotiflac://session-grant', endpoints: { bootstrap: '/bootstrap', challenge: '/challenge', exchange: '/session/exchange' } };
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  process.env.QOBUZ_SESSION_FILE = path.join(dir, 'session.json');
  let now = Date.now(); let calls = [];
  let payload = { challenge_id: 'fresh-challenge', expires_in: 180, server_nonce: 'not-a-session', turnstile_site_key: 'public-key' }; let status = 200;
  const config = { ...cfg, now: () => now, http: (...args) => { calls.push(args); return { statusCode: status, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }; } };
  const s = new SignedSession(config);
  try { fn({ s, config, calls, tick: () => { now += 181000; }, reply: (p, code = 200) => { payload = p; status = code; } }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('challenge URL uses vendor v2grant contract; private persisted state reused until expiry', () => fixture(({ s, config, calls, tick }) => {
  const r = s.ensureAuthenticated(); const url = new URL(r.auth_url); const cb = new URL(url.searchParams.get('cb'));
  assert.equal(url.pathname, '/v2/challenge'); assert.equal(url.searchParams.get('id'), 'fresh-challenge'); assert.equal(cb.searchParams.get('cb_version'), 'v2grant');
  assert.ok(cb.searchParams.get('state')); assert.equal(s.isUsable(), false);
  assert.equal(new SignedSession(config).ensureAuthenticated().auth_url, r.auth_url); assert.equal(calls.length, 1);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  tick(); assert.notEqual(s.ensureAuthenticated().auth_url, r.auth_url); assert.equal(calls.length, 2);
}));
test('malformed challenge/session responses fail without provider body leaks', () => fixture(({ s, reply }) => {
  for (const p of ['invalid-json', {}, { challenge_id: 'x', expires_in: -1 }, { challenge_id: {}, expires_in: 180 }, { session_id: 'id', session_secret: 'secret-marker', expires_at: 'invalid' }]) {
    reply(p); assert.throws(() => s.bootstrap(), e => !JSON.stringify(e).includes('secret-marker') && !e.response);
  }
}));
test('human callback state required; failure sanitized; successful exchange persists across reload', () => fixture(({ s, config, calls, reply }) => {
  const url = new URL(s.bootstrap().auth_url); const cb = new URL(url.searchParams.get('cb')); cb.searchParams.set('grant', 'human-grant');
  assert.equal(s.completeGrant('human-grant').success, false);
  const wrong = new URL(cb); wrong.searchParams.set('state', 'wrong'); assert.equal(s.completeGrant(wrong.href).success, false); assert.equal(calls.length, 1);
  reply({ error: 'secret-marker' }, 401); const failed = s.completeGrant(cb.href); assert.equal(failed.success, false); assert.ok(!JSON.stringify(failed).includes('secret-marker')); assert.equal(s.isUsable(), false);
  reply({ session_id: 'id', session_secret: 'private-secret', expires_at: new Date(Date.now()+3600000).toISOString() });
  assert.equal(s.completeGrant(cb.href).success, true); assert.equal(new SignedSession(config).isUsable(), true);
  assert.equal(s.status().auth_url, ''); assert.equal(s.record.pending, undefined);
  assert.equal(JSON.parse(calls.at(-1)[2]).grant, 'human-grant');
}));
test('expired callback and invalid expiry cannot authenticate', () => fixture(({ s, tick, reply }) => {
  const cb = new URL(new URL(s.bootstrap().auth_url).searchParams.get('cb')); cb.searchParams.set('grant','human'); tick();
  assert.equal(s.completeGrant(cb.href).success, false);
  const fresh = new URL(new URL(s.bootstrap().auth_url).searchParams.get('cb')); fresh.searchParams.set('grant','human');
  reply({session_id:'id',session_secret:'secret',expires_at:'invalid'}); assert.equal(s.completeGrant(fresh.href).success,false);
}));
test('provider auth rejection invalidates persisted session and requests human verification', () => fixture(({ s, config, reply }) => {
  Object.assign(s.config, { headerPrefix: 'X-Zarz-', schemeLabel: 'ZARZ-HMAC-V1', timeWindowSeconds: 300 });
  s.record.session_id = 'rejected'; s.record.session_secret = 'private'; s.record.expires_at = new Date(Date.now()+3600000).toISOString(); s.save();
  const original = s.http; let called = 0;
  s.http = (...args) => ++called === 1 ? { statusCode: 401, body: '{"error":"SESSION_INVALID"}' } : original(...args);
  const result = s.signedFetch('POST','/dl/qbz','{}');
  assert.equal(result.needsVerification, true); assert.equal(s.isUsable(), false); assert.equal(new SignedSession(config).isUsable(), false);
}));
