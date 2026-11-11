import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER = path.join(HERE, 'providers', 'qobuz-web', 'index.js');
const MANIFEST = path.join(HERE, 'providers', 'qobuz-web', 'manifest.json');
const HTTP_HELPER = path.join(HERE, 'http-sync.cjs');

function sleepMs(ms) {
  const end = Date.now() + Math.max(0, Number(ms || 0));
  while (Date.now() < end) {}
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hmacSha256Base64Url(key, message) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'utf8'))
    .update(String(message), 'utf8')
    .digest('base64url');
}

function randomHex(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function syncHttp(url, method = 'GET', body = '', headers = {}, timeoutMs = 30000) {
  const payload = JSON.stringify({ url, method, body: body || '', headers: headers || {}, timeoutMs });
  const result = spawnSync(process.execPath, [HTTP_HELPER, payload], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '').trim();
  if (!stdout) throw new Error(String(result.stderr || 'HTTP helper returned no output').trim());
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('HTTP helper returned invalid JSON');
  }
  if (value.error) {
    const error = new Error(String(value.error));
    error.code = 'NETWORK_ERROR';
    throw error;
  }
  return value;
}

function queryUrl(base, values) {
  const u = new URL(base);
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null && value !== '') {
      u.searchParams.set(key, String(value));
    }
  }
  return u.toString();
}

function nowIso() {
  const d = new Date();
  return d.toISOString().replace('Z', 'Z');
}

function responseObject(response) {
  return {
    statusCode: Number(response.statusCode || response.status || 0),
    status: Number(response.statusCode || response.status || 0),
    ok: Boolean(response.ok),
    url: String(response.url || ''),
    body: String(response.body || ''),
    headers: response.headers || {}
  };
}

export class SignedSession {
  constructor(config) {
    this.config = config;
    this.http = config.http || syncHttp;
    this.now = config.now || Date.now;
    this.file = process.env.QOBUZ_SESSION_FILE ||
      path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'qobuz-session.json');
    this.lastAuthUrl = '';
    this.installId = '';
    this.record = {};
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.record = raw && typeof raw === 'object' ? raw : {};
    } catch {
      this.record = {};
    }
    this.installId = String(this.record.install_id || process.env.QOBUZ_INSTALL_ID || randomHex(16));
    this.record.install_id = this.installId;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.record, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  clear() {
    const installId = this.installId;
    this.record = { install_id: installId };
    this.lastAuthUrl = '';
    this.save();
  }

  isUsable() {
    const id = String(this.record.session_id || '').trim();
    const secret = String(this.record.session_secret || '').trim();
    if (!id || !secret) return false;
    const expires = Date.parse(String(this.record.expires_at || ''));
    return Number.isFinite(expires) && this.now() < expires;
  }

  status() {
    this.load(); // Private provisioning can update the persisted session without a restart.
    this.lastAuthUrl = this.record.pending?.expires_at > this.now() ? this.record.pending.url : '';
    return {
      authenticated: this.isUsable(),
      verification_required: Boolean(this.lastAuthUrl),
      auth_url: this.lastAuthUrl,
      expires_at: String(this.record.expires_at || ''),
      install_id: this.installId,
      session_id: ''
    };
  }

  endpoint(endpoint) {
    const base = String(this.config.baseUrl).replace(/\/$/, '');
    return endpoint.startsWith('http://') || endpoint.startsWith('https://')
      ? endpoint
      : base + '/' + String(endpoint).replace(/^\/+/, '');
  }

  bootstrap() {
    if (this.record.pending?.expires_at > this.now()) {
      this.lastAuthUrl = this.record.pending.url;
      return { needsVerification: true, auth_url: this.lastAuthUrl };
    }
    const url = queryUrl(this.endpoint(this.config.endpoints.bootstrap), {
      app_version: this.config.appVersion,
      install_id: this.installId
    });
    const response = responseObject(this.http(url, 'GET', '', {
      Accept: 'application/json',
      'User-Agent': 'SpotiFLAC-Mobile/' + this.config.appVersion
    }, 15000));

    if (response.statusCode >= 200 && response.statusCode < 300) {
      let payload = {};
      try { payload = JSON.parse(response.body || '{}'); } catch {}
      if (typeof payload.session_id === 'string' && payload.session_id.trim() &&
        typeof payload.session_secret === 'string' && payload.session_secret.trim() &&
        typeof payload.expires_at === 'string' && Date.parse(payload.expires_at) > this.now()) {
        delete this.record.pending;
        this.record.session_id = String(payload.session_id);
        this.record.session_secret = String(payload.session_secret);
        this.record.expires_at = String(payload.expires_at);
        this.record.namespace = this.config.namespace;
        this.record.base_url = this.config.baseUrl;
        this.record.app_version = this.config.appVersion;
        this.record.platform = this.config.platform;
        this.lastAuthUrl = '';
        this.save();
        return { success: true };
      }

      // Official Mornye signed_session/protocol.rs: challenge_url (v2grant).
      const challenge = payload.challenge_id;
      const ttl = Number(payload.expires_in);
      if (typeof challenge === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(challenge) &&
          Number.isFinite(ttl) && ttl > 0 && ttl <= 600) {
        const state = randomHex(24);
        const callback = queryUrl(this.config.callbackUrl, { cb_version: 'v2grant', state });
        const authUrl = queryUrl(this.endpoint(this.config.endpoints.challenge), { id: challenge, cb: callback });
        this.record.pending = { state, url: authUrl, expires_at: this.now() + ttl * 1000 };
        this.lastAuthUrl = authUrl;
        this.save();
        return { needsVerification: true, auth_url: authUrl };
      }

    }

    const error = new Error('signed-session bootstrap failed: HTTP ' + response.statusCode);
    // Never attach provider bodies or capability material to errors.
    throw error;
  }

  ensureAuthenticated() {
    if (this.isUsable()) return { success: true };
    return this.bootstrap();
  }

  completeGrant(grant) {
    let value = String(grant || '').trim();
    const pending = this.record.pending;
    if (!pending || pending.expires_at <= this.now()) return { success: false, error: 'Fresh human verification required' };
    try {
      const callback = new URL(value);
      const expected = new URL(this.config.callbackUrl);
      if (callback.protocol !== expected.protocol || callback.host !== expected.host ||
          callback.pathname !== expected.pathname || callback.searchParams.get('state') !== pending.state) {
        return { success: false, error: 'Verification callback mismatch' };
      }
      value = callback.searchParams.get('grant') || '';
    } catch { return { success: false, error: 'Full verification callback URL required' }; }

    if (!value) return { success: false, error: 'grant is required' };

    const url = this.endpoint(this.config.endpoints.exchange);
    const body = JSON.stringify({
      grant: value,
      install_id: this.installId,
      app_version: this.config.appVersion,
      platform: this.config.platform
    });
    const response = responseObject(this.http(url, 'POST', body, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'SpotiFLAC-Mobile/' + this.config.appVersion
    }, 30000));

    let payload = {};
    try { payload = JSON.parse(response.body || '{}'); } catch {}

    if (response.statusCode >= 200 && response.statusCode < 300 &&
        typeof payload.session_id === 'string' && payload.session_id.trim() &&
        typeof payload.session_secret === 'string' && payload.session_secret.trim() &&
        typeof payload.expires_at === 'string' && Date.parse(payload.expires_at) > this.now()) {
      delete this.record.pending;
      this.record.session_id = String(payload.session_id);
      this.record.session_secret = String(payload.session_secret);
      this.record.expires_at = String(payload.expires_at);
      this.record.namespace = this.config.namespace;
      this.record.base_url = this.config.baseUrl;
      this.record.app_version = this.config.appVersion;
      this.record.platform = this.config.platform;
      this.lastAuthUrl = '';
      this.save();
      return { success: true };
    }

    return {
      success: false,
      error: 'session exchange failed',
      statusCode: response.statusCode,
      detail: 'Provider did not return a valid session'
    };
  }

  signedHeaders(method, url, body) {
    if (!this.isUsable()) {
      const error = new Error('signed session is not authenticated');
      error.needsVerification = true;
      throw error;
    }

    const now = Date.now();
    const timestamp = nowIso();
    const window = Math.floor(Math.floor(now / 1000) / Number(this.config.timeWindowSeconds || 300));
    const rolling = hmacSha256Base64Url(
      String(this.record.session_secret),
      String(window) + ':' + String(this.record.session_id)
    );
    const bodyHash = sha256(body || '');
    const parsed = new URL(url);
    const signing = [
      this.config.schemeLabel,
      String(method).toUpperCase(),
      parsed.pathname || '/',
      '',
      bodyHash,
      timestamp,
      randomHex(12),
      String(this.record.session_id),
      this.config.appVersion,
      this.config.platform
    ].join('\n');

    const nonce = signing.split('\n')[6];
    const signature = hmacSha256Base64Url(rolling, signing);

    const headers = {
      [this.config.headerPrefix + 'Session']: String(this.record.session_id),
      [this.config.headerPrefix + 'Timestamp']: timestamp,
      [this.config.headerPrefix + 'Nonce']: nonce,
      [this.config.headerPrefix + 'Body-SHA256']: bodyHash,
      [this.config.headerPrefix + 'Signature']: signature,
      [this.config.headerPrefix + 'App-Version']: this.config.appVersion,
      [this.config.headerPrefix + 'Platform']: this.config.platform,
      Accept: 'application/json',
      'User-Agent': 'SpotiFLAC-Mobile/' + this.config.appVersion
    };

    if (body) headers['Content-Type'] = 'application/json';
    return headers;
  }

  signedFetch(method, pathName, body = '', extraHeaders = {}) {
    try {
      const ensured = this.ensureAuthenticated();
      if (ensured && ensured.needsVerification) return ensured;
    } catch (error) {
      if (error && error.needsVerification) {
        return { needsVerification: true, error: 'VERIFY_REQUIRED', auth_url: this.lastAuthUrl };
      }
      throw error;
    }

    const bodyText = body === null || body === undefined
      ? ''
      : (typeof body === 'string' ? body : JSON.stringify(body));

    const url = this.endpoint(pathName);
    let headers = this.signedHeaders(method, url, bodyText);
    for (const [key, value] of Object.entries(extraHeaders || {})) {
      headers[key] = String(value);
    }

    let response = responseObject(this.http(url, String(method).toUpperCase(), bodyText, headers, 30000));

    if ((response.statusCode === 401 || response.statusCode === 428) &&
        /VERIFY_REQUIRED|SESSION_INVALID|verify/i.test(response.body || '')) {
      this.clear();
      try {
        const boot = this.bootstrap();
        if (boot.needsVerification) return boot;
      } catch {}
    }

    let payload = {};
    try { payload = JSON.parse(response.body || '{}'); } catch {}

    const result = {
      statusCode: response.statusCode,
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      url: response.url || url,
      body: response.body,
      headers: response.headers || {}
    };
    if (payload && typeof payload === 'object') {
      for (const key of ['error', 'code', 'origin', 'action', 'retryable', 'retryMode', 'retry_after_seconds']) {
        if (payload[key] !== undefined) result[key] = payload[key];
      }
      if (payload.retry_after_seconds !== undefined) result.retryAfterSeconds = payload.retry_after_seconds;
    }
    return result;
  }
}

export class SpotiFLACQobuzHost {
  constructor() {
    this.providerManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const signed = this.providerManifest.signedSession;
    this.session = new SignedSession({
      namespace: signed.namespace,
      baseUrl: signed.baseUrl,
      appVersion: signed.appVersion,
      platform: signed.platform,
      callbackUrl: signed.callbackUrl,
      schemeLabel: signed.schemeLabel,
      headerPrefix: signed.headerPrefix,
      timeWindowSeconds: signed.timeWindowSeconds,
      endpoints: signed.endpoints
    });

    this.extension = null;
    const self = this;

    const contextObject = {
      console,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      registerExtension(value) {
        self.extension = value;
        contextObject.extension = value;
      },
      log: {
        info: (...args) => console.log('[Qobuz]', ...args),
        debug: (...args) => {},
        warn: (...args) => console.warn('[Qobuz]', ...args),
        error: (...args) => console.error('[Qobuz]', ...args)
      },
      settings: {
        appId: process.env.QOBUZ_APP_ID || '798273057',
        countryCode: process.env.QOBUZ_COUNTRY_CODE || 'US'
      },
      utils: {
        appUserAgent: () => 'SpotiFLAC-Mobile',
        randomUserAgent: () => 'Mozilla/5.0',
        isDownloadCancelled: () => false,
        sha256,
        sleep: (ms) => { sleepMs(Math.min(Number(ms || 0), 5000)); return true; }
      },
      http: {
        get(url, headers = {}) {
          return syncHttp(String(url), 'GET', '', headers, 30000);
        },
        post(url, body, headers = {}) {
          return syncHttp(String(url), 'POST', typeof body === 'string' ? body : JSON.stringify(body ?? ''), headers, 30000);
        }
      },
      session: {
        status: () => self.session.status(),
        clear: () => { self.session.clear(); return { success: true }; },
        completeGrant: (grant) => self.session.completeGrant(grant),
        signedFetch: (method, pathName, body, headers) => self.session.signedFetch(method, pathName, body, headers)
      },
      file: {
        delete() { return { success: false, error: 'file API is not available in BitChord server mode' }; },
        download() { return { success: false, error: 'file API is not available in BitChord server mode' }; }
      },
      gobackend: {
        checkISRCExists() { return { exists: false }; },
        getAudioQuality() { return null; },
        getLyricsLRC() { return ''; }
      },
      crypto: {
        sha256
      }
    };

    this.context = vm.createContext(contextObject);
    const source = fs.readFileSync(PROVIDER, 'utf8');
    vm.runInContext(source, this.context, {
      filename: 'qobuz-web/index.js',
      timeout: 15000
    });

    if (!this.extension) throw new Error('Qobuz provider did not register an extension');

    if (typeof this.extension.initialize === 'function') {
      this.extension.initialize({
        appId: contextObject.settings.appId,
        countryCode: contextObject.settings.countryCode
      });
    }
  }

  authStatus() {
    return this.session.status();
  }

  startAuth() {
    try {
      const result = this.session.ensureAuthenticated();
      return {
        ...result,
        auth_url: result.auth_url || this.session.lastAuthUrl || ''
      };
    } catch (error) {
      return { success: false, error: String(error.message || error) };
    }
  }

  completeAuth(value) {
    return this.session.completeGrant(value);
  }

  clearAuth() {
    this.session.clear();
    return { success: true };
  }

  search(query, limit = 25) {
    return this.extension.customSearch(String(query || ''), {
      filter: 'track',
      limit: Math.min(Math.max(Number(limit || 25), 1), 25)
    }) || [];
  }

  resolveStream(trackId, quality) {
    const parsedId = typeof this.context.parseTrackID === 'function'
      ? this.context.parseTrackID(String(trackId || ''))
      : String(trackId || '').replace(/^qobuz:/i, '');

    if (!parsedId) throw Object.assign(new Error('invalid qobuz track id'), { code: 'NOT_FOUND' });

    const q = String(quality || 'lossless').toLowerCase();
    const qualityCode = q === 'high' ? 'HI_RES' : q === 'low' ? 'LOSSLESS' : 'HI_RES_LOSSLESS';
    const info = this.context.resolveDownloadInfo(parsedId, qualityCode, {});

    if (!info || !info.directURL) throw new Error('Qobuz did not return a playable stream URL');

    return {
      url: String(info.directURL),
      format: 'flac',
      quality: Number(info.bitDepth) > 16 || Number(info.sampleRate) > 48000 ? 'Hi-Res Lossless' : 'Lossless',
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      ...(Number(info.sampleRate || 0) > 0 ? { sampleRate: Number(info.sampleRate) } : {}),
      ...(Number(info.bitDepth || 0) > 0 ? { bitDepth: Number(info.bitDepth) } : {})
    };
  }
}
