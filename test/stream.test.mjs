import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStream, publicAddress } from '../src/stream-contract.js';
const now = 1800000000000;
function flac(depth = 16, rate = 44100) {
  const b = Buffer.alloc(42); b.write('fLaC'); b[4] = 128; b.writeUIntBE(34, 5, 3);
  b.writeBigUInt64BE((BigInt(rate) << 44n) | (1n << 41n) | (BigInt(depth-1) << 36n) | 441000n, 18); return b;
}
const probe = (b = flac()) => async () => new Response(b, { status: 206, headers: { 'content-range': 'bytes 0-41/99999' } });
const options = { now, resolve: async () => [{ address: '8.8.8.8' }], probe: probe() };
const stream = { url: `https://cdn.example/file?exp=${now/1000+900}&sig=provider`, codec: 'flac', format: 'flac', bitDepth: 16, sampleRate: 44.1 };
test('bounded FLAC STREAMINFO controls quality; no Atmos or credentials invented', async () => {
  const actual = await validateStream({ ...stream, quality: 'Hi-Res', headers: { authorization: 'never-return' } }, options);
  assert.equal(actual.quality, 'Lossless'); assert.equal(actual.sampleRate, 44100); assert.equal(actual.atmos, false); assert.equal(actual.headers, undefined);
  assert.equal((await validateStream({ ...stream, bitDepth: 16 }, { ...options, probe: probe(flac(24, 96000)) })).quality, 'Hi-Res Lossless');
  await assert.rejects(validateStream({ ...stream, codec: 'alac' }, options));
});
test('HTTP, LAN, userinfo, expired/permanent/overlong URLs, DRM rejected', async () => {
  for (const value of [{ url: 'http://cdn.example/file' }, { url: 'https://user:secret@cdn.example/file' }, { url: 'https://cdn.example/file' }, { url: `https://cdn.example/?exp=${now/1000-1}` }, { url: `https://cdn.example/?exp=${now/1000+3600}` }, { encrypted: true }, { codec: 'eac3-joc' }]) await assert.rejects(validateStream({ ...stream, ...value }, options));
  await assert.rejects(validateStream(stream, { ...options, resolve: async () => [{ address: '192.168.8.204' }] }));
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', 'fe80::1', 'fc00::1']) assert.equal(publicAddress(ip), false);
});

test('lossy, unknown, mislabeled bytes and unbounded responses fail closed', async () => {
  for (const codec of ['opus', 'aac', 'mp3', 'unknown']) await assert.rejects(validateStream({ ...stream, codec }, options));
  for (const bytes of [Buffer.from('OggSOpusHead'), Buffer.from('ID3'), Buffer.alloc(42)]) await assert.rejects(validateStream(stream, { ...options, probe: probe(bytes) }));
  await assert.rejects(validateStream(stream, { ...options, probe: async () => new Response(flac()) }));
});

test('Qobuz Akamai etsp recognized only with vendor signature shape and bounded 60-minute compatibility', async () => {
  const url = `https://streaming-qobuz-std.akamaized.net/file?etsp=${now/1000+900}&hmac=${'a'.repeat(27)}`;
  assert.equal((await validateStream({ ...stream, url }, options)).codec, 'flac');
  for (const bad of [url.replace('streaming-qobuz-std.akamaized.net','cdn.example'), url.replace('hmac=','missing='), url.replace('a'.repeat(27),'invalid'), url.replace(String(now/1000+900),String(now/1000+3601)), url.replace(String(now/1000+900),String(now/1000-1))]) {
    await assert.rejects(validateStream({ ...stream, url: bad }, options));
  }
});

test('55-minute Qobuz URL accepted unchanged; other origins retain 30-minute bound', async () => {
  const url = `https://streaming-qobuz-std.akamaized.net/file?etsp=${now/1000+3300}&hmac=${'a'.repeat(27)}`;
  const actual = await validateStream({ ...stream, url }, options);
  assert.equal(actual.url, url);
  for (const extra of ['&session_secret=forbidden', '&hmac=duplicate', '&etsp=1800003300']) {
    await assert.rejects(validateStream({ ...stream, url: url+extra }, options));
  }
  for (const seconds of [299, 0, -1, 3601]) {
    await assert.rejects(validateStream({ ...stream, url: url.replace(String(now/1000+3300), String(now/1000+seconds)) }, options));
  }
  await assert.rejects(validateStream({ ...stream, url: `https://cdn.example/file?exp=${now/1000+3300}&sig=provider` }, options));
  await assert.rejects(validateStream({ ...stream, url }, { ...options, resolve: async () => [{ address: '127.0.0.1' }] }));
  await assert.rejects(validateStream({ ...stream, url }, { ...options, probe: async () => { throw Error('redirect refused'); } }));
});
