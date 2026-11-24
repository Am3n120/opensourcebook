# yt-dlp sidecar

A small FastAPI service that wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) and exposes one
generalized video-extraction endpoint for the Open Sourcebook engine.

## Why

Open Sourcebook saves videos and social posts from anywhere on the web. Instead of maintaining per-site API
clients (YouTube Data API, TikTok, Instagram, Vimeo, ...), this sidecar leans on yt-dlp's
~1800 supported extractors. The engine calls `GET /extract` and gets back uniform metadata,
chapters, thumbnail, and a plain-text transcript (manual subtitles preferred, automatic captions
as fallback, VTT converted and deduped). The engine-side client is `engine/src/extract/video.ts`;
when the sidecar is not configured, the engine silently keeps its Gemini → oEmbed fallback ladder.

One service to deploy. The engine uses the existing `/extract` contract plus the
optional `/frames` and `/transcribe` endpoints; when either optional capability is
unavailable, it keeps its existing fallback ladder.

## Endpoint contract

### `GET /extract?url=<video-url>`

Auth: requests must carry `Authorization: Bearer <YTDLP_SIDECAR_TOKEN>` (401 otherwise). The
sidecar does not start without the token set, and the Worker in front of it answers 503 to every
request until it has one.

Addresses: the URL asked for (and a media link to transcribe, and each subtitle file) must be a
public http(s) address. Its host is resolved and every address it has is checked
(`guard.py`): loopback, private, link-local, unique-local, carrier-grade NAT, multicast, reserved
and documentation ranges are refused, IPv6 forms that carry an IPv4 address are judged by it, and
an IPv4 address written any way but plain dotted decimal is refused. What yt-dlp opens after that
(the site's redirects and media hosts) it looks up and opens itself. `python3 -m unittest
test_guard` runs the check's tests with nothing installed.

Success (200):

```json
{
  "ok": true,
  "title": "...",
  "uploader": "...",
  "duration_seconds": 3725,
  "webpage_url": "https://...",
  "extractor": "Youtube",
  "description": "...",
  "transcript": "plain text, VTT cues merged and deduped",
  "transcript_source": "subtitles | automatic | none",
  "thumbnail": "https://...",
  "chapters": [{ "title": "Intro", "start_time": 0, "end_time": 61 }],
  "storyboard_urls": []
}
```

`transcript_source` is `none` (with empty `transcript`) when the site exposes no subtitles.
`storyboard_urls` is reserved and currently always empty.

### `POST /frames`

Request JSON: `{"url":"https://…","timestamps_ms":[0,61000]}`. The sidecar downloads
one source with yt-dlp, uses FFmpeg to cut bounded JPEGs, and returns
`{"ok":true,"frames":[{"timestamp_ms":61000,"content_type":"image/jpeg","data_base64":"…","width":1280,"height":720}]}`.
The engine persists each returned frame as an R2 `frame` asset with `timestampMs`
and the matching chapter title as its caption. Requests are capped at 32 timestamps.

### `POST /transcribe`

Request JSON is either `{"url":"https://…","content_type":"audio/mpeg"}` for a
remote upload/audio link or `{"audio_base64":"…","content_type":"audio/mpeg"}` for
raw upload bytes. The sidecar runs CPU `faster-whisper` and returns
`{"ok":true,"text":"…","language":"en","source":"faster-whisper"}`.
The model size/device/compute type are controlled by `WHISPER_MODEL_SIZE`
(default `small` in `app.py`; the image bakes and sets `base`, see the Dockerfile),
`WHISPER_DEVICE` (default `cpu`), and `WHISPER_COMPUTE_TYPE`
(default `int8`). If the endpoint fails, the engine tries its configured
OpenRouter/Gemini transcription provider.

Errors are always JSON `{ "ok": false, "error": "..." }` with a meaningful status:

- `401` — missing/invalid bearer token
- `404` — video gone (unavailable, removed, private)
- `422` — unsupported URL, login-required (members-only, age gate), or a disallowed local URL
- `502` — upstream/network failure

### `GET /healthz`

`{ "ok": true }` — unauthenticated liveness probe.

## Run locally

```sh
cd services/ytdlp-sidecar
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
YTDLP_SIDECAR_TOKEN=dev-token uvicorn app:app --port 8080

curl -H "Authorization: Bearer dev-token" \
  "http://localhost:8080/extract?url=https://www.youtube.com/watch?v=..."
```

## Deploy (production: Cloudflare Containers)

Deployed as the `re-ytdlp` Worker (`wrangler.toml` + `worker/index.js` here) on Cloudflare
Containers: `npx wrangler deploy` from this directory (needs Docker running locally and the
Workers Paid plan). The Worker enforces the bearer token (`wrangler secret put
YTDLP_SIDECAR_TOKEN`), hands the same token to the container, which checks it again, and
proxies to it; the container itself is unreachable from the public internet.

Any other container host also works (Fly.io, Railway, Cloud Run, a VPS) via the Dockerfile:

```sh
docker build -t opensourcebook-ytdlp-sidecar .
docker run -p 8080:8080 -e YTDLP_SIDECAR_TOKEN=<token> opensourcebook-ytdlp-sidecar
```

Then point the engine at it via `YTDLP_SIDECAR_URL` / `YTDLP_SIDECAR_TOKEN` in the Worker
environment.

## An egress tunnel (optional)

The image can carry a userspace WireGuard tunnel ([wireproxy](https://github.com/windtf/wireproxy), no
TUN/capabilities needed) that exposes a local SOCKS5 proxy, so that requests to YouTube leave
through a network of your choosing instead of the container host's own addresses. It is off
unless you add a profile. Whether to use one, and whether that fits the terms of the network
and of the sites you read, is your own choice and responsibility. When a profile is present and
no cookies are configured, YouTube requests go through the tunnel; a failure that looks like the
proxy's is retried once directly, so a dead tunnel does not break extraction. Other sites never
use the tunnel.

1. Make a WireGuard profile, for example a Cloudflare WARP one with
   [wgcf](https://github.com/ViRb3/wgcf): `wgcf register --accept-tos && wgcf generate`.
2. Append a SOCKS5 section to the generated `wgcf-profile.conf`:
   `[Socks5]` / `BindAddress = 127.0.0.1:1080`.
3. Save the file as `wgcf-profile.conf` in this directory (it is gitignored — it carries a
   private key).
4. `npx wrangler deploy` — the Dockerfile installs wireproxy and copies the profile when
   present; `entrypoint.sh` starts the tunnel before uvicorn. `/healthz` reports
   `{"cookies": …, "warp": …}` so you can see which layers are live.

Precedence: cookies > the tunnel > direct. Replace the profile by regenerating it and
redeploying.

## A cookies file (optional)

Public videos are read without cookies. Some pages are only served to a signed-in session, and
yt-dlp can send the cookies of one: `cookiefile` support is built in, and the file is baked into
the image at deploy time. This is a setting you turn on yourself. The account the cookies belong
to, what it is allowed to see and the site's terms for it are your own choice and
responsibility; a cookies file is a login, so keep it private and use one you are content to
keep on a server.

1. Export the cookies for the site in Netscape format from a browser signed in to the account
   you chose.
2. Save the file as `cookies.txt` in this directory (it is gitignored).
3. `npx wrangler deploy` — the Dockerfile copies it to `/app/cookies.txt` when present;
   `app.py` picks it up automatically. Deploy works fine without the file.

Replace it by saving a new file and redeploying.

Known site behavior (updated 2026-08-10):

- **YouTube**: the `tv` / `android_vr` player clients work from Cloudflare datacenter IPs
  for ordinary public videos (verified in production). Pages that need a signed-in session
  are read only with a cookies file.
- **Vimeo**'s extractor wants login cookies at the moment (read from `cookies.txt` when present).
- Long tail of yt-dlp's ~1800 extractors generally works from datacenter IPs; behavior is
  per-site and shifts over time.

Notes:

- The service is stateless; the only optional on-disk artifact is `cookies.txt`.
  Login-required sites without cookies return 422.
- yt-dlp extractors break as sites change; bump the pinned `yt-dlp` version in
  `requirements.txt` regularly (redeploy after bumping).
- Requests are bounded by `socket_timeout` (20s) in `YDL_OPTS`; the engine adds its own client
  timeout and treats any failure as "keep the fallback ladder".
