import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStream, publicAddress } from '../src/stream-contract.js';
const now = 1800000000000;
const options = { now, resolve: async () => [{ address: '8.8.8.8' }] };
const stream = { url: `https://cdn.example/file?exp=${now/1000+900}&sig=provider`, codec: 'flac', format: 'flac', bitDepth: 16, sampleRate: 44.1 };
test('actual FLAC/ALAC metadata controls quality; no Atmos or credentials invented', async () => {
  const actual = await validateStream({ ...stream, quality: 'Hi-Res', headers: { authorization: 'never-return' } }, options);
  assert.equal(actual.quality, 'Lossless'); assert.equal(actual.sampleRate, 44100); assert.equal(actual.atmos, false); assert.equal(actual.headers, undefined);
  assert.equal((await validateStream({ ...stream, codec: 'alac', bitDepth: 24 }, options)).quality, 'Hi-Res Lossless');
});
test('HTTP, LAN, userinfo, expired/permanent/overlong URLs, DRM rejected', async () => {
  for (const value of [{ url: 'http://cdn.example/file' }, { url: 'https://user:secret@cdn.example/file' }, { url: 'https://cdn.example/file' }, { url: `https://cdn.example/?exp=${now/1000-1}` }, { url: `https://cdn.example/?exp=${now/1000+3600}` }, { encrypted: true }, { codec: 'eac3-joc' }]) await assert.rejects(validateStream({ ...stream, ...value }, options));
  await assert.rejects(validateStream(stream, { ...options, resolve: async () => [{ address: '192.168.8.204' }] }));
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', 'fe80::1', 'fc00::1']) assert.equal(publicAddress(ip), false);
});
