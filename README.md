# BitChord SpotiFLAC Multi-Source Addon

A single BitChord-compatible HTTP addon aggregating Qobuz, Tidal and Amazon Music metadata behind one search endpoint and routing streams to the correct provider.

## Compatibility and current limitations (0.7.1)

Targets the official Android BitChord **1.9.1** addon-auth v1 contract, checked
2026-11-10 against client main `acf219a7e4a7f52f026d4336d5c7ac5cf7bfafcc`.
The Sources “Outdated addon” note tests `bitchordAuth`, not the addon version.
The flag now accompanies actual request verification; the addon ID is unchanged.
Older clients, desktop/web, modified APKs, rooted/unlocked devices and curl cannot
search or resolve streams through this authenticated edition. Actual Android
hardware attestation and the on-device warning refresh remain unverified.

Set `BITCHORD_HOSTS` to your public hostname(s), comma separated, without scheme,
port or path. Startup fails if absent. `/manifest.json` stays public. All other
client routes verify the official Ed25519 JWT plus P-256 host-bound proof using
the **unmodified official verifier**, downloaded 2026-11-10 from
https://bitchord.kushagrasingh.in/addon-auth/bitchord-addon-auth.mjs .
Keys are fetched only from the official HTTPS JWKS URL (10s timeout), cached an
hour with rate-limited rotation refresh. No developer login/API key is required.
Tests use locally generated protocol fixtures; they are **not official-issued
device tokens**, and no test trust key is installed in production.
See https://bitchord.kushagrasingh.in/docs for the protocol and client limits.

Health is exempt only on container loopback for Docker's healthcheck. Provider
`/auth/*` management routes are disabled (404 after app verification): app proof
is not owner authorization. Keep session provisioning private and external to
this public API. Health confirms process initialization, not playable audio.

Qobuz metadata search works; playback is **pending human provider verification**.
Version 0.7.1 builds the missing v2grant challenge URL from `challenge_id`, matching
[official Mornye protocol.rs](https://github.com/mornyeapp/Mornye/blob/45df9860661e9c4e731ef26a60c44b2b5d8cf125/rust_backend/crates/extensions/src/signed_session/protocol.rs#L93)
and [exchange.rs](https://github.com/mornyeapp/Mornye/blob/45df9860661e9c4e731ef26a60c44b2b5d8cf125/rust_backend/crates/extensions/src/signed_session/exchange.rs#L159).
The official API page performs Turnstile in the user's browser and offers a
copy-link fallback containing the full callback URL. This provider challenge is
separate from BitChord's device proof. No CAPTCHA automation or native app proof
is fabricated. Tidal/Amazon remain separately configured external backends.

Private operator provisioning (run in the container; no web admin route):

    node src/provider-session-cli.js start /data/operator-link.txt

Privately open that file's URL in a normal browser immediately (current provider
challenge expires in 180 seconds). Complete the provider's human verification.
If the browser offers to open SpotiFLAC, use the page's manual copy-link fallback
instead; copy the **full** callback URL, including state and grant, into
`/data/operator-callback.txt`, owner uid1000, mode600, without putting it in argv,
shell history or chat. Then run:

    node src/provider-session-cli.js complete /data/operator-callback.txt

A successful exchange deletes the input callback file and persists session
credentials mode600. The server rereads the session before resolving streams;
no restart needed. An expired challenge requires a new start command with a new
output filename. A rejected session is invalidated; failed exchanges are sanitized.
No automatic refresh is added: expired sessions require fresh verification.
Do not expose `/data`, the link, callback or session file. Real human completion,
exchange and playback remain unverified until the operator finishes this step.

Streams must be explicit HTTPS, non-DRM URLs on public IPs, without userinfo or
custom ports. Only provider URLs with recognized expiry (`exp`, `expires`,
`Expires`, or AWS date/TTL) and 5–30 minutes remaining are returned. Unrecognized
or permanent provider URLs fail closed (502) until a supported expiring URL is
available; the addon cannot shorten a third-party URL's lifetime itself. It does
not proxy media or forward app/provider headers to the player. Actual expiry is
enforced by the trusted provider; there is no claim of verifying its signature.
All exposed tiers require FLAC bytes: a Range request for bytes0–1023 must return206
and a valid leading STREAMINFO block; quality/depth/rate come from those bytes,
never catalogue metadata or the selected tier. Opus/AAC/MP3, mislabeled bytes and
ALAC (no bounded MP4 parser yet) fail unavailable. This verifies the delivered
codec, not the recording provenance or whether the provider previously transcoded. No Atmos capability is advertised or invented.
`allowDownloads: false` declares playback-only use. Only the bounded header is read; no full media is cached.
Official docs target15–30 minutes and require at least5; existing5–30-minute
remaining-lifetime acceptance is retained.

Run `npm test` (zero npm dependencies): crypto fixtures, cache/rotation,
issuer/audience/time/host failures, HTTP middleware/discovery, provider verification
failure, metadata and unsafe URL cases. These tests do not prove provider playback.

## Architecture

Official BitChord Android client -> /manifest.json, /search, /stream/{id} -> this addon -> Qobuz / Tidal HTTP / Amazon HTTP -> normalized BitChord response.

## Run

Use Docker Compose as before:

    docker compose up --build

The addon listens on port 8080.

Configure .env from .env.example. TIDAL_API_URL points to a separately hosted binimum/hifi-api instance. AMAZON_API_URL points to a separately hosted itsmeadarsh2008/amazon-music-api instance, and AMAZON_API_TOKEN is its bearer token.

The Python backends remain separate intentionally; the Node addon stays lightweight and does not copy their runtimes.

## BitChord

Point BitChord at the running addon server, not the raw GitHub manifest.

    https://your-addon.example.com

Endpoints:

    GET /manifest.json
    GET /health
    GET /search?q=...
    GET /stream/{id}?quality=lossless

CORS and OPTIONS are supported.

## Qobuz

Qobuz keeps the existing signed-session flow. A valid signed session is required; provider authentication is not bypassed.

## Tidal

Run binimum/hifi-api separately with a valid Tidal account and set TIDAL_API_URL. The adapter uses its documented /search/ and /track/ endpoints and returns the explicit playback URL contained in the returned manifest.

The Tidal project documents one in-flight playback request per playback credential and queues requests when credentials are occupied.

## Amazon Music

Run itsmeadarsh2008/amazon-music-api separately and set AMAZON_API_URL plus AMAZON_API_TOKEN. The adapter uses /search and /stream_urls.

Only an explicit HTTPS stream URL with no DRM marker is passed through. The addon does not call /widevine_key, reconstruct DRM segments, decrypt protected media, or transcode protected content.

Therefore Amazon metadata/search can work even when its current backend cannot expose a direct non-DRM playback URL. That behavior is deliberate.

## Health

Container-loopback GET /health reports each provider independently so you can see what is configured and reachable before troubleshooting BitChord.

## Security

- Keep Qobuz session files private.
- Keep Amazon bearer tokens private.
- Prefer HTTPS for internet-facing deployments.
- Do not expose Tidal/Amazon credential files or backend administration publicly.
- Do not commit .env, tokens, cookies, session files, or captured provider responses.

## Upstream projects

- Qobuz: SpotiFLAC Extension qobuz-web provider.
- Tidal: binimum/hifi-api.
- Amazon Music: itsmeadarsh2008/amazon-music-api.

## Version 0.6.0

- Added external Tidal and Amazon provider adapters.
- Added namespaced provider IDs.
- Added merged multi-provider search.
- Added provider health reporting.
- Added CORS and OPTIONS handling.
- Kept the existing Qobuz signed-session implementation intact.
