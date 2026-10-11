#!/usr/bin/env python3
"""Turn a YouTube link into a Markdown transcript, from the video's captions.

Usage:
    transcribe.py <youtube-url> [--out PATH] [--language en] [--no-metadata]

Captions come from the YouTube transcript API first, then from yt-dlp's
subtitle download. Title, channel, date and description come from yt-dlp.
Nothing is published anywhere; the transcript is written to --out (default
~/mike/out/<title>.md) for save_to_mike.

Exit codes:
    0  transcript written (its path is the last line printed)
    2  bad arguments (not a YouTube link)
    3  YouTube refused this machine's network address (data-centre addresses
       are asked to sign in); nothing was written
    4  the video has no captions; audio transcription is not available here
"""
import argparse
import html
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VIDEO_ID_RE = re.compile(r"(?:youtu\.be/|[?&]v=|/live/|/shorts/|/embed/)([\w-]{11})")
BLOCK_MARKERS = (
    "confirm you",  # "Sign in to confirm you're not a bot"
    "RequestBlocked",
    "IpBlocked",
    "blocking requests from your IP",
    "HTTP Error 429",
)
# yt-dlp player clients to try, as in the original script: android with
# missing PO tokens, then tv_embedded, then the default.
YTDLP_CLIENTS = [
    ["--extractor-args", "youtube:player_client=android;youtube:formats=missing_pot"],
    ["--extractor-args", "youtube:player_client=tv_embedded"],
    [],
]


class Blocked(Exception):
    """YouTube refused the request because of where it came from."""


def video_id(url: str) -> str | None:
    match = VIDEO_ID_RE.search(url)
    return match.group(1) if match else None


def is_block(text: str) -> bool:
    return any(marker in text for marker in BLOCK_MARKERS)


def ytdlp(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["yt-dlp", "--no-update", "--no-playlist", *args],
        capture_output=True, text=True, timeout=timeout,
    )


def fetch_metadata(url: str) -> dict:
    """Title, channel, date, duration and description; {} when unavailable."""
    blocked = False
    for client in YTDLP_CLIENTS:
        out = ytdlp(["-J", "--skip-download", *client, url])
        if out.returncode == 0:
            try:
                info = json.loads(out.stdout)
            except json.JSONDecodeError:
                continue
            return {
                "title": info.get("title") or "",
                "channel": info.get("uploader") or info.get("channel") or "",
                "upload_date": info.get("upload_date") or "",
                "duration": info.get("duration") or 0,
                "description": info.get("description") or "",
                "url": info.get("webpage_url") or url,
            }
        blocked = blocked or is_block(out.stderr)
    if blocked:
        raise Blocked("yt-dlp")
    return {}


def captions_from_api(vid: str, languages: list[str]) -> str | None:
    """Caption text from youtube-transcript-api: a manual track in the wanted
    languages, else a generated one, else any track."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None
    api = YouTubeTranscriptApi()
    try:
        try:
            fetched = api.fetch(vid, languages=languages)
        except Exception as error:
            if is_block(type(error).__name__ + " " + str(error)):
                raise
            tracks = api.list(vid)
            try:
                track = tracks.find_manually_created_transcript(languages)
            except Exception:
                track = next(iter(tracks), None)
                if track is None:
                    return None
            fetched = track.fetch()
    except Exception as error:
        if is_block(type(error).__name__ + " " + str(error)):
            raise Blocked("caption API") from None
        return None
    text = " ".join(snippet.text for snippet in fetched)
    return clean(text) or None


def vtt_text(vtt: str) -> str:
    """Spoken text from a WebVTT file. Auto-generated captions repeat each
    line as the next one scrolls in, so consecutive repeats are dropped."""
    lines: list[str] = []
    for raw in vtt.splitlines():
        line = raw.strip()
        if not line or line == "WEBVTT" or "-->" in line or line.isdigit():
            continue
        if re.match(r"^(Kind|Language|NOTE|STYLE|REGION)\b", line):
            continue
        line = re.sub(r"<[^>]+>", "", line)  # inline timing and styling tags
        line = html.unescape(line).strip()
        if line and (not lines or lines[-1] != line):
            lines.append(line)
    return clean(" ".join(lines))


def captions_from_ytdlp(url: str, languages: list[str]) -> str | None:
    blocked = False
    with tempfile.TemporaryDirectory() as tmp:
        for client in YTDLP_CLIENTS:
            out = ytdlp([
                "--skip-download", "--write-subs", "--write-auto-subs",
                "--sub-langs", ",".join(f"{lang}.*" for lang in languages) or "en.*",
                "--sub-format", "vtt", *client,
                "-o", str(Path(tmp) / "captions.%(ext)s"), url,
            ])
            files = sorted(Path(tmp).glob("captions*.vtt"))
            if files:
                return vtt_text(files[0].read_text(encoding="utf-8", errors="replace")) or None
            blocked = blocked or is_block(out.stderr)
    if blocked:
        raise Blocked("yt-dlp")
    return None


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\n", " ")).strip()


def paragraphs(text: str, sentences_per_paragraph: int = 5) -> str:
    """Breaks one long caption run into readable paragraphs."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    if len(sentences) < 3:
        # Captions without punctuation: break every ~120 words instead.
        words = text.split()
        return "\n\n".join(" ".join(words[i:i + 120]) for i in range(0, len(words), 120))
    return "\n\n".join(
        " ".join(sentences[i:i + sentences_per_paragraph])
        for i in range(0, len(sentences), sentences_per_paragraph)
    )


def safe_filename(title: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", " ", title).strip().strip(".")
    return (re.sub(r"\s+", " ", name)[:120] or "transcript") + ".md"


def render(title: str, text: str, meta: dict, info: dict) -> str:
    front = ["---"] + [f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in meta.items()] + ["---", ""]
    body = [f"# {title}", ""]
    header = " · ".join(part for part in [
        info.get("channel", ""),
        (lambda d: f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else d)(info.get("upload_date", "")),
    ] if part)
    if header or info.get("description"):
        body += ["## About the video", ""]
        if header:
            body += [header, ""]
        if info.get("description"):
            body += [info["description"].strip(), ""]
    body += ["## Transcript", "", paragraphs(text), ""]
    return "\n".join(front + body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="a YouTube link")
    parser.add_argument("--out", help="output .md path (default ~/mike/out/<title>.md)")
    parser.add_argument("--language", default="en", help="preferred caption language, e.g. en, fr (default en)")
    parser.add_argument("--no-metadata", action="store_true", help="skip title, channel and description")
    args = parser.parse_args()

    vid = video_id(args.url)
    if not vid:
        print("Not a YouTube video link.", file=sys.stderr)
        return 2
    languages = list(dict.fromkeys([args.language, "en"]))

    blocked_by: list[str] = []
    info: dict = {}
    if not args.no_metadata:
        try:
            info = fetch_metadata(args.url)
        except Blocked as block:
            blocked_by.append(str(block))

    text, method = None, ""
    try:
        text, method = captions_from_api(vid, languages), "youtube-transcript-api"
    except Blocked as block:
        blocked_by.append(str(block))
    if not text:
        try:
            text, method = captions_from_ytdlp(args.url, languages), "yt-dlp captions"
        except Blocked as block:
            blocked_by.append(str(block))

    if not text:
        if blocked_by:
            print(
                "YouTube refused this machine's network address (it asks data-centre addresses "
                f"to sign in; refused: {', '.join(sorted(set(blocked_by)))}). Nothing was written.",
                file=sys.stderr,
            )
            return 3
        print("This video has no captions, and transcribing its audio is not available here.", file=sys.stderr)
        return 4

    title = info.get("title") or vid
    meta = {
        "source": info.get("url") or args.url,
        "title": title,
        "method": method,
        "transcribed": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    duration = info.get("duration") or 0
    if duration > 120 and len(text) < duration * 2:
        meta["note"] = f"captions look incomplete: {len(text)} characters for {duration // 60} minutes of video"
        print(meta["note"], file=sys.stderr)

    out = Path(args.out).expanduser() if args.out else Path.home() / "mike" / "out" / safe_filename(title)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(title, text, meta, info), encoding="utf-8")
    print(f"{len(text)} characters via {method}")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
