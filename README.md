# BitChord SpotiFLAC Multi-Source Addon

A single BitChord-compatible HTTP addon aggregating Qobuz, Tidal and Amazon Music metadata behind one search endpoint and routing streams to the correct provider.

## Compatibility and current limitations (0.7.0)

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

Qobuz metadata search works. Playback on the deployed upstream session still
fails `503 verification_required`: its bootstrap expects session credentials or
a verification URL, but the current provider returns challenge_id/server_nonce/
expires_in/turnstile_site_key. This fork does not fabricate sessions, automate
CAPTCHAs or claim to fix that separate provider protocol mismatch. Tidal/Amazon
require separately authenticated external backends; neither is enabled on the
reference deployment. No paid backend or media cache was added.

Streams must be explicit HTTPS, non-DRM URLs on public IPs, without userinfo or
custom ports. Only provider URLs with recognized expiry (`exp`, `expires`,
`Expires`, or AWS date/TTL) and 5–30 minutes remaining are returned. Unrecognized
or permanent provider URLs fail closed (502) until a supported expiring URL is
available; the addon cannot shorten a third-party URL's lifetime itself. It does
not proxy media or forward app/provider headers to the player. Actual expiry is
enforced by the trusted provider; there is no claim of verifying its signature.
FLAC/ALAC quality derives from returned depth/rate, with sample rate normalized
to Hz, never the selected tier. No Atmos capability is advertised or invented.
`allowDownloads: false` declares playback-only use. No full media is cached.

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
