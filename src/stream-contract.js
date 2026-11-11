import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^[23]/.test(address) && !/^2001:(db8|0:|10:|20:)/i.test(address);
}

export async function validateStream(stream, { now = Date.now(), resolve = lookup } = {}) {
  const url = new URL(stream.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || stream.encrypted || /atmos|eac3|joc/i.test(stream.codec || '')) {
    throw new Error('Unsupported media URL or encoding');
  }
  const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Non-public media origin');
  // Direct URLs must have provider-enforced expiry; we cannot invent an expiry
  // for a permanent URL. Never fetch media or send BitChord/provider credentials.
  let exp = Number(url.searchParams.get('exp') || url.searchParams.get('expires') || url.searchParams.get('Expires')) * 1000;
  const date = url.searchParams.get('X-Amz-Date');
  const ttl = Number(url.searchParams.get('X-Amz-Expires'));
  if (date && /^\d{8}T\d{6}Z$/.test(date) && ttl > 0) {
    exp = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) + ttl * 1000;
  }
  if (!Number.isFinite(exp) || exp - now < 300000 || exp - now > 1800000) {
    throw new Error('Provider must supply a signed URL with 5–30 minutes remaining');
  }
  if (!['flac', 'alac', 'aac', 'mp3', 'opus'].includes(String(stream.codec).toLowerCase())) throw new Error('Unknown codec');
  const bitDepth = Number(stream.bitDepth);
  let sampleRate = Number(stream.sampleRate);
  if (sampleRate > 0 && sampleRate < 1000) sampleRate *= 1000;
  const lossless = ['flac', 'alac'].includes(String(stream.codec).toLowerCase());
  return {
    url: url.href,
    format: stream.format,
    codec: stream.codec,
    container: stream.container,
    quality: lossless ? ((bitDepth > 16 || sampleRate > 48000) ? 'Hi-Res Lossless' : 'Lossless') : 'Lossy',
    ...(sampleRate > 0 ? { sampleRate } : {}),
    ...(bitDepth > 0 ? { bitDepth } : {}),
    ...(Number(stream.bitrate) > 0 ? { bitrate: Number(stream.bitrate) } : {}),
    atmos: false,
    encrypted: false
  };
}
