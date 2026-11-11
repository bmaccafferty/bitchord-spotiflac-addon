import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { SpotiFLACQobuzHost } from '../src/spotiflac-qobuz-host.js';
const originalLookup = dns.lookup;
dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
syncBuiltinESMExports();
const { subtle } = webcrypto;
const dir = await mkdtemp(join(tmpdir(), 'spotiflac-test-'));
process.env.PORT = '0'; process.env.BITCHORD_HOSTS = 'addon.example.com';
process.env.ENABLE_TIDAL = 'false'; process.env.ENABLE_AMAZON = 'false';
process.env.QOBUZ_SESSION_FILE = join(dir, 'session.json');
const signer = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const device = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const key = { ...await subtle.exportKey('jwk', signer.publicKey), kid: 'fixture' };
const realFetch = globalThis.fetch;
const mediaUrl = `https://streaming-qobuz-std.akamaized.net/fixture?etsp=${Math.floor(Date.now()/1000)+3300}&hmac=${'a'.repeat(27)}`;
const media = Buffer.alloc(1024); media.write('fLaC'); media[4] = 128; media.writeUIntBE(34, 5, 3);
media.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (23n << 36n), 18);
globalThis.fetch = (url, ...args) => String(url) === 'https://bitchord-auth.kushagrasingh.in/.well-known/jwks.json' ? Promise.resolve(Response.json({ keys: [key] })) : String(url) === mediaUrl ? Promise.resolve(new Response(media, { status: 206, headers: { 'content-range': 'bytes 0-1023/99999' } })) : realFetch(url, ...args);
const { server } = await import('../src/server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const b64 = v => Buffer.from(v).toString('base64url'); const enc = new TextEncoder();
async function headers() {
  const ts = Date.now();
  const tokenBody = `${b64(JSON.stringify({ alg: 'EdDSA', kid: 'fixture' }))}.${b64(JSON.stringify({ iss: 'https://bitchord-auth.kushagrasingh.in', aud: 'bitchord-addons', iat: Math.floor(ts/1000), exp: Math.floor(ts/1000)+3600, cnf: { jwk: await subtle.exportKey('jwk', device.publicKey) } }))}`;
  const token = `${tokenBody}.${b64(await subtle.sign('Ed25519', signer.privateKey, enc.encode(tokenBody)))}`;
  const ath = b64(await subtle.digest('SHA-256', enc.encode(token)));
  const proof = `v1.${ts}.${b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, enc.encode(`bitchord-addon-proof/v1\naddon.example.com\n${ts}\n${ath}`)))}`;
  return { 'X-BitChord-Token': token, 'X-BitChord-Proof': proof };
}
test('HTTP contract: discovery public; real middleware accepts valid fixtures and denies missing/forged', async () => {
  try {
    const manifest = await (await realFetch(`${origin}/manifest.json`)).json();
    assert.equal(manifest.bitchordAuth, true); // AddonManifest.requiresBitChordAuth, 1.9.1
    assert.equal(manifest.id, 'com.pavan.bitchord.spotiflac.multisource');
    assert.equal(manifest.allowDownloads, false);
    for (const path of ['/search?q=test', '/stream/qobuz:1', '/auth/start', '/health/other']) {
      const response = await realFetch(origin+path);
      assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /^BitChord /);
    }
    const valid = await headers();
    assert.deepEqual(await (await realFetch(`${origin}/search`, { headers: valid })).json(), { tracks: [] });
    const blocked = await realFetch(`${origin}/stream/qobuz:1`, { headers: valid });
    assert.equal(blocked.status, 503); assert.equal((await blocked.json()).error, 'verification_required');
    // Test-only provider fixture; production never loads this code or these keys.
    const originalStatus = SpotiFLACQobuzHost.prototype.authStatus;
    const originalResolve = SpotiFLACQobuzHost.prototype.resolveStream;
    try {
      SpotiFLACQobuzHost.prototype.authStatus = () => ({ authenticated: true });
      SpotiFLACQobuzHost.prototype.resolveStream = (id, quality) => {
        assert.equal(id, '94965602'); assert.equal(quality, 'lossless');
        return { url: mediaUrl, codec: 'flac' };
      };
      const response = await realFetch(`${origin}/stream/qobuz:94965602?quality=lossless`, { headers: await headers() });
      assert.equal(response.status, 200);
      const stream = await response.json();
      assert.equal(stream.url, mediaUrl); assert.equal(stream.codec, 'flac');
      assert.equal(stream.bitDepth, 24); assert.equal(stream.sampleRate, 44100);
      assert.equal(stream.quality, 'Hi-Res Lossless');
      SpotiFLACQobuzHost.prototype.resolveStream = () => ({ url: mediaUrl, codec: 'aac' });
      assert.equal((await realFetch(`${origin}/stream/qobuz:94965602`, { headers: await headers() })).status, 502);
    } finally {
      SpotiFLACQobuzHost.prototype.authStatus = originalStatus;
      SpotiFLACQobuzHost.prototype.resolveStream = originalResolve;
    }
    assert.equal((await realFetch(`${origin}/auth/start`, { headers: valid })).status, 404);
    assert.equal((await realFetch(`${origin}/search`, { headers: { ...valid, 'X-BitChord-Proof': 'bad' } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = realFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); await rm(dir, { recursive: true }); }
});
