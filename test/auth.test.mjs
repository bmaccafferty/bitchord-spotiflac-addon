import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createBitChordAuth, BITCHORD_AUTH_ISSUER as iss } from '../src/bitchord-addon-auth.mjs';
const { subtle } = webcrypto;
const enc = new TextEncoder();
const b64 = v => Buffer.from(v).toString('base64url');
const json = v => b64(JSON.stringify(v));
const signer = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await subtle.exportKey('jwk', device.publicKey);
const key = { ...await subtle.exportKey('jwk', signer.publicKey), kid: 'fixture' };
let now = 1800000000000;
let calls = 0;
const auth = createBitChordAuth({ hosts: ['addon.example.com'], now: () => now,
  fetch: async () => { calls++; return Response.json({ keys: [key] }); } });
async function credentials(overrides = {}, host = 'addon.example.com', ts = now) {
  const unsigned = `${json({ alg: 'EdDSA', kid: 'fixture' })}.${json({ iss, aud: 'bitchord-addons', iat: now / 1000, exp: now / 1000 + 3600, cnf: { jwk }, sub: 'fixture', ...overrides })}`;
  const token = `${unsigned}.${b64(await subtle.sign('Ed25519', signer.privateKey, enc.encode(unsigned)))}`;
  const ath = b64(await subtle.digest('SHA-256', enc.encode(token)));
  const proof = `v1.${ts}.${b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, enc.encode(`bitchord-addon-proof/v1\n${host}\n${ts}\n${ath}`)))}`;
  return { token, proof };
}
test('official protocol fixture: valid Ed25519 token and hardware-key proof; JWKS cached', async () => {
  assert.equal((await auth.verify(await credentials())).ok, true);
  assert.equal((await auth.verify(await credentials())).ok, true);
  assert.equal(calls, 1);
});
for (const [name, claims, host, ts, code] of [
  ['expired', { exp: now / 1000 - 61 }, undefined, undefined, 'expired'],
  ['audience', { aud: 'wrong' }, undefined, undefined, 'invalid_token'],
  ['issuer', { iss: 'https://evil.example' }, undefined, undefined, 'invalid_token'],
  ['future', { iat: now / 1000 + 61 }, undefined, undefined, 'invalid_token'],
  ['device binding', { cnf: {} }, undefined, undefined, 'invalid_token'],
  ['wrong host', {}, 'other.example.com', undefined, 'invalid_proof'],
  ['old proof', {}, undefined, now - 120001, 'stale_proof']
]) test(name, async () => assert.equal((await auth.verify(await credentials(claims, host, ts))).error, code));
test('missing, malformed and forged credentials fail closed with protocol challenge', async () => {
  for (const value of [{}, { token: 'bad', proof: 'bad' }, { ...await credentials(), token: (await credentials()).token.slice(0, -8) + 'AAAAAAAA' }]) {
    const result = await auth.verify(value);
    assert.equal(result.status, 401);
    assert.match(auth.rejection(result).headers['www-authenticate'], /^BitChord /);
    assert.equal(auth.rejection(result).headers['cache-control'], 'no-store');
  }
});
test('JWKS outage fails closed', async () => {
  const denied = createBitChordAuth({ hosts: ['addon.example.com'], now: () => now, fetch: async () => { throw Error('offline'); } });
  assert.equal((await denied.verify(await credentials())).status, 503);
});
test('unknown kid triggers rate-limited rotation refresh', async () => {
  let fetches = 0;
  const rotated = createBitChordAuth({ hosts: ['addon.example.com'], now: () => now, fetch: async () => { fetches++; return Response.json({ keys: fetches === 1 ? [] : [key] }); } });
  assert.equal((await rotated.verify(await credentials())).error, 'invalid_token');
  assert.equal((await rotated.verify(await credentials())).error, 'invalid_token');
  assert.equal(fetches, 1);
  now += 300001;
  assert.equal((await rotated.verify(await credentials())).ok, true);
  assert.equal(fetches, 2);
});
