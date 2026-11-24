"""yt-dlp sidecar for the Open Sourcebook engine.

One generalized extraction endpoint for the ~1800 sites yt-dlp supports:
metadata, chapters, thumbnail, and subtitles (manual first, automatic as a
fallback, VTT converted to deduped plain text). It also exposes FFmpeg chapter
frames and a faster-whisper transcription endpoint. The engine calls this from
`engine/src/extract/video.ts` and `engine/src/extract/audio.ts`; without it the
engine keeps its existing fallback ladders.

Auth: every request must carry `Authorization: Bearer <YTDLP_SIDECAR_TOKEN>`, and
the sidecar does not start without that token set. Every address it is asked to
open is checked first (`guard.py`).
"""

import base64
import hmac
import html
import os
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from threading import Lock
from typing import Any, Optional, Tuple
from urllib.parse import urlparse

import yt_dlp
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from yt_dlp.utils import DownloadError, ExtractorError

from guard import Refused, check_url, open_checked

try:
    from faster_whisper import WhisperModel
except ImportError:  # Keep health/extract usable if the optional model is unavailable.
    WhisperModel = None  # type: ignore[assignment,misc]

app = FastAPI(title="opensourcebook-ytdlp-sidecar", version="0.1.0")

SIDECAR_TOKEN = os.environ.get("YTDLP_SIDECAR_TOKEN", "").strip()
if not SIDECAR_TOKEN:
    raise SystemExit("YTDLP_SIDECAR_TOKEN is not set; the sidecar does not start without it.")

# Optional Netscape cookies file baked into the image at deploy time, the
# deployer's own choice (README). Some pages are only served to a signed-in
# session; clients that can't use cookies just ignore them.
COOKIES_FILE = os.environ.get("YTDLP_COOKIES_FILE", "/app/cookies.txt").strip()
HAS_COOKIES = bool(COOKIES_FILE and os.path.isfile(COOKIES_FILE) and os.path.getsize(COOKIES_FILE) > 0)

# Optional WARP layer: the entrypoint starts wireproxy (userspace WireGuard)
# when a wgcf profile is baked into the image, the deployer's own choice
# (README). YouTube requests then leave through the tunnel. A signed-in
# session (cookies) prefers a stable egress, so cookies win when both are
# present.
WARP_PROFILE = os.environ.get("YTDLP_WARP_PROFILE", "/app/wgcf-profile.conf").strip()
WARP_PROXY_URL = os.environ.get("YTDLP_WARP_PROXY", "socks5://127.0.0.1:1080").strip()
WARP_ENABLED = bool(WARP_PROFILE and os.path.isfile(WARP_PROFILE) and os.path.getsize(WARP_PROFILE) > 0)

YDL_OPTS = {
    "skip_download": True,
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "socket_timeout": 20,
    # Subtitle tracks ride along in the info dict; content is fetched on demand.
    "writesubtitles": True,
    "writeautomaticsub": True,
    # YouTube serves "The page needs to be reloaded" to datacenter IPs on the
    # default web client; tv/android_vr clients are not interrupted this way.
    "extractor_args": {"youtube": {"player_client": ["tv", "android_vr", "web"]}},
}
if HAS_COOKIES:
    YDL_OPTS["cookiefile"] = COOKIES_FILE
SUBTITLE_FETCH_TIMEOUT_SECONDS = 15
MAX_SUBTITLE_BYTES = 5_000_000
MAX_TRANSCRIPT_CHARS = 200_000
MAX_FRAME_COUNT = 32
MAX_FRAME_BYTES = 2_000_000
MAX_AUDIO_BYTES = 25_000_000
MAX_TRANSCRIBE_BASE64_CHARS = 36_000_000
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small").strip() or "small"
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu").strip() or "cpu"
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"

GONE_PATTERN = re.compile(
    r"unavailable|removed|deleted|does not exist|no longer available|not found|private", re.IGNORECASE
)
LOGIN_PATTERN = re.compile(
    r"sign in|log\s?in|members.only|age.?gate|confirm your age|use cookies|authentication|account", re.IGNORECASE
)
UNSUPPORTED_PATTERN = re.compile(r"unsupported url|no suitable|generic extractor", re.IGNORECASE)
PROXY_FAILURE_PATTERN = re.compile(
    r"proxy|socks|connection refused|connection reset|connection aborted|timed out|tunnel", re.IGNORECASE
)


def is_youtube_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("youtube.com") or host.endswith("youtube-nocookie.com") or host == "youtu.be"


def ydl_opts_for(url: str) -> dict:
    """Per-request opts: YouTube exits via the WARP tunnel unless cookies are set."""
    opts = dict(YDL_OPTS)
    if WARP_ENABLED and not HAS_COOKIES and is_youtube_host(url):
        opts["proxy"] = WARP_PROXY_URL
    return opts


def ydl_attempts(opts: dict) -> list:
    """Proxied opts first, direct-egress copy as a retry for proxy-shaped failures."""
    attempts = [opts]
    if opts.get("proxy"):
        direct = dict(opts)
        direct.pop("proxy")
        attempts.append(direct)
    return attempts


def is_proxy_failure(exc: Exception) -> bool:
    return bool(PROXY_FAILURE_PATTERN.search(str(exc)))


async def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    given = (authorization or "").encode("utf-8")
    if not hmac.compare_digest(given, f"Bearer {SIDECAR_TOKEN}".encode("utf-8")):
        raise HTTPException(status_code=401, detail="Missing or invalid bearer token")


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Any, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": str(exc.detail)})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Any, _exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"ok": False, "error": "Invalid request parameters"})


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "cookies": HAS_COOKIES, "warp": WARP_ENABLED and not HAS_COOKIES}


@app.get("/extract")
def extract(url: str = Query(..., min_length=1), _auth: None = Depends(require_token)) -> dict:
    check_url_allowed(url)
    info = None
    attempts = ydl_attempts(ydl_opts_for(url))
    for index, opts in enumerate(attempts):
        # A dead tunnel must never break extraction: proxy-shaped failures
        # retry once on direct egress, identical data either way.
        retry_direct = index + 1 < len(attempts)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except (DownloadError, ExtractorError) as exc:
            if retry_direct and is_proxy_failure(exc):
                continue
            raise HTTPException(status_code=status_for_error(exc), detail=clean_error(exc)) from exc
        except Exception as exc:  # upstream/network failure of any other shape
            if retry_direct and is_proxy_failure(exc):
                continue
            raise HTTPException(status_code=502, detail=f"Upstream extraction failed: {clean_error(exc)}") from exc
        break
    if not isinstance(info, dict):
        raise HTTPException(status_code=502, detail="Upstream returned no info dict")

    transcript, transcript_source = extract_transcript(info)
    return {
        "ok": True,
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration_seconds": info.get("duration"),
        "webpage_url": info.get("webpage_url") or url,
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "description": info.get("description"),
        "transcript": transcript,
        "transcript_source": transcript_source,
        "thumbnail": info.get("thumbnail"),
        "chapters": clean_chapters(info.get("chapters")),
        "storyboard_urls": [],
    }


class FrameRequest(BaseModel):
    url: str = Field(..., min_length=1)
    timestamps_ms: list[int] = Field(..., min_length=1, max_length=MAX_FRAME_COUNT)


class TranscribeRequest(BaseModel):
    url: Optional[str] = None
    audio_base64: Optional[str] = None
    content_type: Optional[str] = None
    language: Optional[str] = None


@app.post("/frames")
def frames(request: FrameRequest, _auth: None = Depends(require_token)) -> dict:
    """Download a source video and cut bounded JPEG frames with FFmpeg."""
    check_url_allowed(request.url)
    timestamps = clean_timestamps(request.timestamps_ms)
    if not timestamps:
        raise HTTPException(status_code=422, detail="timestamps_ms must contain non-negative values")
    try:
        with tempfile.TemporaryDirectory(prefix="opensourcebook-frames-") as directory:
            source_path = download_media(request.url, Path(directory))
            assets = extract_frames(source_path, timestamps, Path(directory))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Frame extraction failed: {clean_error(exc)}") from exc
    return {"ok": True, "url": request.url, "frames": assets}


@app.post("/transcribe")
def transcribe(request: TranscribeRequest, _auth: None = Depends(require_token)) -> dict:
    """Transcribe an uploaded or remotely hosted audio/video body with Whisper."""
    if not request.url and not request.audio_base64:
        raise HTTPException(status_code=422, detail="url or audio_base64 is required")
    if request.url:
        check_url_allowed(request.url)
    if WhisperModel is None:
        raise HTTPException(status_code=503, detail="faster-whisper is not installed")
    try:
        with tempfile.TemporaryDirectory(prefix="opensourcebook-transcribe-") as directory:
            media_path, content_type = resolve_transcription_input(request, Path(directory))
            result = transcribe_file(media_path, request.language)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Transcription failed: {clean_error(exc)}") from exc
    return {
        "ok": True,
        "text": result["text"],
        "language": result["language"],
        "duration_seconds": result["duration_seconds"],
        "source": "faster-whisper",
        "content_type": content_type,
    }


def check_url_allowed(url: str) -> None:
    """Refuses, as a 422, an address that is not public (`guard.py`); its host is resolved and every address checked."""
    try:
        check_url(url)
    except Refused as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def status_for_error(exc: Exception) -> int:
    message = str(exc)
    if GONE_PATTERN.search(message):
        return 404
    if LOGIN_PATTERN.search(message) or UNSUPPORTED_PATTERN.search(message):
        return 422
    return 502


def clean_error(exc: Exception) -> str:
    return re.sub(r"\s+", " ", str(exc)).strip()[:300] or exc.__class__.__name__


def clean_chapters(chapters: Any) -> list:
    cleaned = []
    for chapter in chapters or []:
        if not isinstance(chapter, dict):
            continue
        start = chapter.get("start_time")
        if not isinstance(start, (int, float)):
            continue
        cleaned.append(
            {
                "title": chapter.get("title") or "",
                "start_time": start,
                "end_time": chapter.get("end_time"),
            }
        )
    return cleaned[:100]


def clean_timestamps(timestamps: list[int]) -> list[int]:
    """Deduplicate requested frame times while preserving chapter order."""
    cleaned: list[int] = []
    seen: set[int] = set()
    for timestamp in timestamps:
        if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp < 0:
            continue
        if timestamp in seen:
            continue
        seen.add(timestamp)
        cleaned.append(timestamp)
    return cleaned[:MAX_FRAME_COUNT]


def download_media(url: str, directory: Path) -> Path:
    """Download one playable video with yt-dlp; the directory is request-scoped."""
    base = ydl_opts_for(url)
    base.update(
        {
            "skip_download": False,
            "writesubtitles": False,
            "writeautomaticsub": False,
            "format": "bv*+ba/b",
            "outtmpl": str(directory / "source.%(ext)s"),
            "merge_output_format": "mp4",
            "overwrites": True,
        }
    )
    attempts = ydl_attempts(base)
    for index, options in enumerate(attempts):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([url])
            break
        except (DownloadError, ExtractorError) as exc:
            if index + 1 < len(attempts) and is_proxy_failure(exc):
                continue
            raise HTTPException(status_code=status_for_error(exc), detail=clean_error(exc)) from exc
    candidates = [
        path
        for path in directory.glob("source.*")
        if path.is_file() and path.suffix.lower() in {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".wav", ".ogg", ".flac"}
    ]
    if not candidates:
        raise HTTPException(status_code=502, detail="yt-dlp did not produce a playable media file")
    return max(candidates, key=lambda path: path.stat().st_size)


def extract_frames(source_path: Path, timestamps: list[int], directory: Path) -> list[dict]:
    """Cut one bounded JPEG per timestamp; unavailable/out-of-range times are omitted."""
    frames: list[dict] = []
    total_bytes = 0
    for index, timestamp_ms in enumerate(timestamps):
        output_path = directory / f"frame-{index}.jpg"
        seconds = timestamp_ms / 1000
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{seconds:.3f}",
            "-i",
            str(source_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=w='min(1280,iw)':h=-2",
            "-q:v",
            "4",
            "-y",
            str(output_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=45)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        if not output_path.is_file():
            continue
        data = output_path.read_bytes()
        if not data or len(data) > MAX_FRAME_BYTES:
            continue
        total_bytes += len(data)
        if total_bytes > 20_000_000:
            break
        width, height = probe_dimensions(output_path)
        frame: dict[str, Any] = {
            "timestamp_ms": timestamp_ms,
            "content_type": "image/jpeg",
            "data_base64": base64.b64encode(data).decode("ascii"),
        }
        if width is not None:
            frame["width"] = width
        if height is not None:
            frame["height"] = height
        frames.append(frame)
    return frames


def probe_dimensions(path: Path) -> Tuple[Optional[int], Optional[int]]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=s=x:p=0",
        str(path),
    ]
    try:
        output = subprocess.check_output(command, text=True, timeout=10).strip()
        width, height = (int(value) for value in output.split("x", 1))
        return width, height
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
        return None, None


def resolve_transcription_input(request: TranscribeRequest, directory: Path) -> Tuple[Path, str]:
    if request.audio_base64:
        if len(request.audio_base64) > MAX_TRANSCRIBE_BASE64_CHARS:
            raise HTTPException(status_code=413, detail="audio_base64 is too large")
        try:
            data = base64.b64decode(request.audio_base64, validate=True)
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail="audio_base64 is invalid") from None
        content_type = normalize_media_content_type(request.content_type)
    else:
        assert request.url is not None
        try:
            headers = {"User-Agent": "opensourcebook-ytdlp-sidecar/0.1", "Accept": "audio/*,video/*"}
            with open_checked(urllib.request.Request(request.url, headers=headers), timeout=SUBTITLE_FETCH_TIMEOUT_SECONDS) as response:
                declared_length = int(response.headers.get("content-length") or 0)
                if declared_length > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="remote media is too large")
                data = response.read(MAX_AUDIO_BYTES + 1)
                if len(data) > MAX_AUDIO_BYTES:
                    raise HTTPException(status_code=413, detail="remote media is too large")
                content_type = normalize_media_content_type(response.headers.get("content-type"))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Media download failed: {clean_error(exc)}") from exc
    if not data:
        raise HTTPException(status_code=422, detail="media body is empty")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="media is too large")
    content_type = content_type or "application/octet-stream"
    path = directory / f"input{media_suffix(content_type)}"
    path.write_bytes(data)
    return path, content_type


def normalize_media_content_type(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    content_type = value.split(";", 1)[0].strip().lower()
    return content_type if re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", content_type) else None


def media_suffix(content_type: str) -> str:
    return {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/mp4": ".m4a",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
    }.get(content_type, ".bin")


_whisper_model: Any = None
_whisper_model_lock = Lock()


def transcribe_file(path: Path, language: Optional[str]) -> dict:
    global _whisper_model
    with _whisper_model_lock:
        if _whisper_model is None:
            _whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
        model = _whisper_model
    segments, info = model.transcribe(str(path), language=language or None, beam_size=5, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    return {
        "text": text[:MAX_TRANSCRIPT_CHARS],
        "language": getattr(info, "language", None),
        "duration_seconds": getattr(info, "duration", None),
    }


def extract_transcript(info: dict) -> Tuple[str, str]:
    """Return (plain_text, source) where source is subtitles|automatic|none."""
    for key, source in (("subtitles", "subtitles"), ("automatic_captions", "automatic")):
        tracks = info.get(key) or {}
        language = pick_language(tracks)
        if not language:
            continue
        vtt_url = next(
            (fmt.get("url") for fmt in tracks.get(language) or [] if fmt.get("ext") == "vtt" and fmt.get("url")),
            None,
        )
        if not vtt_url:
            continue
        vtt = fetch_text(vtt_url)
        if not vtt:
            continue
        text = vtt_to_text(vtt)
        if text:
            return text[:MAX_TRANSCRIPT_CHARS], source
    return "", "none"


def pick_language(tracks: dict) -> Optional[str]:
    languages = list(tracks.keys())
    if not languages:
        return None
    if "en" in languages:
        return "en"
    for language in languages:
        if language.startswith("en"):
            return language
    return sorted(languages)[0]


def fetch_text(url: str) -> str:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "opensourcebook-ytdlp-sidecar/0.1"})
        with open_checked(request, timeout=SUBTITLE_FETCH_TIMEOUT_SECONDS) as response:
            return response.read(MAX_SUBTITLE_BYTES).decode("utf-8", errors="replace")
    except Exception:
        return ""


def vtt_to_text(vtt: str) -> str:
    """Plain-text view of a VTT: cue text only, tags stripped, rolling duplicates merged."""
    lines = []
    in_cue = False
    for raw in vtt.splitlines():
        line = raw.strip()
        if "-->" in line:
            in_cue = True
            continue
        if not line:
            in_cue = False
            continue
        if not in_cue or re.fullmatch(r"\d+", line):
            continue  # headers, NOTE/STYLE blocks, cue identifiers
        text = html.unescape(re.sub(r"<[^>]+>", "", line)).strip()
        if text:
            lines.append(text)
    return dedupe_rolling(lines)


def dedupe_rolling(lines: list) -> str:
    """Auto-caption VTTs repeat text across rolling cue windows; merge on overlap."""
    parts = []
    previous = ""
    for line in lines:
        overlap = longest_suffix_prefix_overlap(previous, line)
        if overlap < len(line):
            parts.append(line[overlap:].strip())
        previous = line
    return " ".join(part for part in parts if part)


def longest_suffix_prefix_overlap(previous: str, line: str) -> int:
    for size in range(min(len(previous), len(line)), 0, -1):
        if previous.endswith(line[:size]):
            return size
    return 0
