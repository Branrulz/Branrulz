"""MuffinPop highlight channel automation.

Finds new gameplay clips, turns them into YouTube Shorts and weekly
best-of compilations, and uploads them on a schedule.

Commands:
    python muffinpop.py scan        # find new clips
    python muffinpop.py short       # build today's Short(s)
    python muffinpop.py compile     # build a best-of compilation now
    python muffinpop.py upload      # upload anything built but not uploaded
    python muffinpop.py run         # all of the above, for the daily scheduled task
    python muffinpop.py status      # show what's queued
    python muffinpop.py login       # connect to your YouTube channel
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "state.json"
CONFIG_FILE = HERE / "config.yaml"
CLIENT_SECRET = HERE / "client_secret.json"
TOKEN_FILE = HERE / "token.json"
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".webm", ".avi"}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
YT_SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
             "https://www.googleapis.com/auth/youtube"]


# ---------------------------------------------------------------- config/state

def expand(p: str) -> Path:
    p = os.path.expandvars(os.path.expanduser(p))
    path = Path(p)
    return path if path.is_absolute() else (HERE / path)


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        sys.exit("config.yaml not found. Copy config.example.yaml to config.yaml and edit it.")
    with open(CONFIG_FILE, encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"clips": {}, "videos": []}


def save_state(state: dict) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp.replace(STATE_FILE)


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------- ffmpeg helpers

def need_ffmpeg() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found. Install it (winget install Gyan.FFmpeg) and reopen the terminal.")


def probe(path: Path) -> dict | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60, check=True).stdout
        info = json.loads(out)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return None
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video:
        return None
    has_audio = any(s.get("codec_type") == "audio" for s in info["streams"])
    return {"duration": float(info["format"].get("duration", 0) or 0), "has_audio": has_audio,
            "width": video.get("width"), "height": video.get("height")}


def ffmpeg(args: list[str]) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{result.stderr.strip()}")


def audio_input(clip: dict, start: float, length: float) -> tuple[list[str], str]:
    """Input args + map label for the clip's audio, or silence if it has none."""
    if clip["has_audio"]:
        return [], "0:a"
    return ["-f", "lavfi", "-t", f"{length:.3f}", "-i", "anullsrc=r=48000:cl=stereo"], "1:a"


# ---------------------------------------------------------------- scanning

def guess_game(path: Path, roots: list[Path], names: dict) -> str:
    parts: list[str] = []
    for root in roots:
        try:
            parts = list(path.relative_to(root).parts[:-1])
            break
        except ValueError:
            continue
    candidates = parts + [path.stem]
    for text in candidates:
        low = text.lower()
        for key, nice in names.items():
            if key.lower() in low:
                return nice
    for text in parts:
        if not re.fullmatch(r"[\d\-_ .]+", text):  # skip date-only folders
            return text.replace("_", " ").strip()
    return "Gaming"


def clip_id(path: Path) -> str:
    st = path.stat()
    return hashlib.sha1(f"{path.name}|{st.st_size}".encode()).hexdigest()[:16]


def scan(cfg: dict, state: dict) -> int:
    folders = [expand(p) for p in cfg.get("clip_folders", [])]
    fav = expand(cfg["favorites_folder"]) if cfg.get("favorites_folder") else None
    if fav:
        fav.mkdir(parents=True, exist_ok=True)
        folders.append(fav)
    names = cfg.get("game_names", {}) or {}
    min_len = float(cfg.get("min_clip_seconds", 5))
    added = 0
    for root in folders:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.suffix.lower() not in VIDEO_EXTS or not path.is_file():
                continue
            try:
                cid = clip_id(path)
            except OSError:
                continue
            if cid in state["clips"]:
                continue
            info = probe(path)
            if not info or info["duration"] < min_len:
                continue
            state["clips"][cid] = {
                "path": str(path),
                "game": guess_game(path, folders, names),
                "duration": round(info["duration"], 2),
                "has_audio": info["has_audio"],
                "recorded": dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
                "favorite": bool(fav and fav in path.parents),
                "used_short": False,
                "used_compilation": False,
            }
            added += 1
    log(f"Scan found {added} new clip(s); {len(state['clips'])} total.")
    return added


def available(state: dict, flag: str) -> list[tuple[str, dict]]:
    clips = [(cid, c) for cid, c in state["clips"].items()
             if not c[flag] and Path(c["path"]).exists()]
    # Favorites first, then oldest first so nothing sits forever.
    clips.sort(key=lambda kv: (not kv[1]["favorite"], kv[1]["recorded"]))
    return clips


# ---------------------------------------------------------------- titles

SHORT_TITLES = [
    "{game} play you have to see 😳",
    "This {game} moment was INSANE",
    "Wait for it... ({game})",
    "How did this work?! 🤯 {game}",
    "Clean {game} play 🔥",
    "{game} but I actually hit it",
    "POV: you finally clutch in {game}",
    "My best {game} play this week?",
    "Nobody expected this in {game}",
    "{game} highlight that broke my brain",
]
COMP_TITLES = [
    "MuffinPop Best Plays of the Week #{n} | {games}",
    "Top {count} Clutch Moments #{n} ({games})",
    "Weekly Highlights #{n}: {games} 🔥",
    "{count} Plays You Won't Believe #{n} | {games}",
]


def pick_title(templates: list[str], recent: list[str], **kw) -> tuple[str, str]:
    # Avoid repeating any of the last few titles (keeps the channel from looking copy-pasted).
    options = [t for t in templates if t not in recent] or templates
    t = random.choice(options)
    return t, t.format(**kw)[:100]


def hashtag(game: str) -> str:
    return "#" + re.sub(r"[^A-Za-z0-9]", "", game)


def fmt_time(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}" if seconds >= 3600 \
        else f"{seconds // 60}:{seconds % 60:02d}"


# ---------------------------------------------------------------- building

def next_publish(time_str: str, after: dt.datetime | None = None) -> dt.datetime:
    hh, mm = (int(x) for x in time_str.split(":"))
    now = after or dt.datetime.now()
    when = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if when <= dt.datetime.now() + dt.timedelta(minutes=30):
        when += dt.timedelta(days=1)
    return when


def build_short(cfg: dict, state: dict, cid: str, clip: dict) -> dict:
    out_dir = expand(cfg.get("output_folder", "./output"))
    out_dir.mkdir(parents=True, exist_ok=True)
    max_len = float(cfg["shorts"].get("max_seconds", 58))
    # Replay-buffer clips end on the big moment, so keep the end.
    start = max(0.0, clip["duration"] - max_len)
    length = clip["duration"] - start
    out = out_dir / f"short_{dt.date.today():%Y%m%d}_{cid}.mp4"
    extra, amap = audio_input(clip, start, length)
    vf = ("[0:v]split[a][b];"
          "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2,eq=brightness=-0.08[bg];"
          "[b]scale=1080:-2:force_original_aspect_ratio=decrease[fg];"
          "[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p[v]")
    ffmpeg(["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", clip["path"], *extra,
            "-filter_complex", vf, "-map", "[v]", "-map", amap,
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest", "-movflags", "+faststart", str(out)])
    recent = [v.get("template") for v in state["videos"][-6:]]
    template, title = pick_title(SHORT_TITLES, recent, game=clip["game"])
    desc = (f"{clip['game']} highlight from MuffinPop 🧁💥\n\n"
            f"Subscribe for daily gaming highlights!\n\n"
            f"#shorts {hashtag(clip['game'])} #gaming #highlights")
    return {"kind": "short", "file": str(out), "title": title, "template": template,
            "description": desc, "tags": [clip["game"], "shorts"], "clips": [cid],
            "publish_at": next_publish(cfg["shorts"].get("publish_time", "17:00")).isoformat(),
            "uploaded": False}


def build_compilation(cfg: dict, state: dict, clips: list[tuple[str, dict]]) -> dict:
    out_dir = expand(cfg.get("output_folder", "./output"))
    work = HERE / "work"
    out_dir.mkdir(parents=True, exist_ok=True)
    work.mkdir(exist_ok=True)
    parts, chapters, t = [], [], 0.0
    for i, (cid, clip) in enumerate(clips):
        part = work / f"part_{i:02d}.mp4"
        extra, amap = audio_input(clip, 0, clip["duration"])
        vf = ("[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
              "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p,"
              f"fade=t=in:st=0:d=0.3,fade=t=out:st={max(0, clip['duration'] - 0.3):.2f}:d=0.3[v]")
        ffmpeg(["-i", clip["path"], *extra, "-filter_complex", vf, "-map", "[v]", "-map", amap,
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", str(part)])
        chapters.append(f"{fmt_time(t)} {clip['game']}")
        t += probe(part)["duration"]
        parts.append(part)
    listing = work / "list.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    n = sum(1 for v in state["videos"] if v["kind"] == "compilation") + 1
    out = out_dir / f"compilation_{n:03d}_{dt.date.today():%Y%m%d}.mp4"
    music = cfg.get("music_file")
    if music and expand(music).exists():
        vol = float(cfg.get("music_volume", 0.15))
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listing), "-stream_loop", "-1", "-i", str(expand(music)),
                "-filter_complex", f"[1:a]volume={vol}[m];[0:a][m]amix=inputs=2:duration=first[a]",
                "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(out)])
    else:
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(out)])
    # Thumbnail from the middle of the first (best) clip.
    thumb = out.with_suffix(".jpg")
    try:
        ffmpeg(["-ss", f"{clips[0][1]['duration'] / 2:.2f}", "-i", str(out), "-frames:v", "1", "-q:v", "2", str(thumb)])
    except RuntimeError:
        thumb = None
    shutil.rmtree(work, ignore_errors=True)

    games = sorted({c["game"] for _, c in clips}, key=lambda g: -sum(c["game"] == g for _, c in clips))
    games_txt = " & ".join(games[:2]) + (" + more" if len(games) > 2 else "")
    recent = [v.get("template") for v in state["videos"][-6:]]
    template, title = pick_title(COMP_TITLES, recent, n=n, count=len(clips), games=games_txt)
    # Chapters need a 0:00 start and 3+ entries of 10s+; YouTube ignores them otherwise.
    desc = ("The best plays of the week from MuffinPop 🧁💥\n\n"
            + "\n".join(chapters) + "\n\n"
            + "Subscribe for daily highlights and a new best-of every week!\n\n"
            + " ".join([hashtag(g) for g in games[:3]] + ["#gaming", "#highlights"]))
    return {"kind": "compilation", "file": str(out), "thumbnail": str(thumb) if thumb else None,
            "title": title, "template": template, "description": desc,
            "tags": games + ["best of", "compilation", "weekly highlights"], "clips": [c for c, _ in clips],
            "publish_at": next_publish(cfg["compilation"].get("publish_time", "12:00")).isoformat(),
            "uploaded": False}


def make_shorts(cfg: dict, state: dict) -> None:
    if not cfg.get("shorts", {}).get("enabled", True):
        return
    today = dt.date.today().isoformat()
    made_today = sum(1 for v in state["videos"] if v["kind"] == "short" and v.get("built", "").startswith(today))
    want = int(cfg["shorts"].get("per_day", 1)) - made_today
    for cid, clip in available(state, "used_short")[:max(0, want)]:
        log(f"Building Short from {Path(clip['path']).name} ({clip['game']})")
        try:
            video = build_short(cfg, state, cid, clip)
        except RuntimeError as e:
            log(f"Skipping clip, {e}")
            clip["used_short"] = True
            continue
        video["built"] = dt.datetime.now().isoformat(timespec="seconds")
        clip["used_short"] = True
        state["videos"].append(video)
        save_state(state)
        log(f"Built: {video['title']}")
    if want > 0 and not available(state, "used_short"):
        log("No unused clips left for Shorts. Go play some games! 🎮")


def make_compilation(cfg: dict, state: dict, force: bool = False) -> None:
    comp = cfg.get("compilation", {})
    if not comp.get("enabled", True):
        return
    if not force:
        if WEEKDAYS[dt.date.today().weekday()] != comp.get("weekday", "sunday").lower():
            return
        last = [v for v in state["videos"] if v["kind"] == "compilation"]
        if last and dt.datetime.fromisoformat(last[-1]["built"]) > dt.datetime.now() - dt.timedelta(days=6):
            return
    pool = available(state, "used_compilation")
    if len(pool) < int(comp.get("min_clips", 5)):
        log(f"Only {len(pool)} clip(s) available; need {comp.get('min_clips', 5)} for a compilation.")
        return
    chosen = pool[: int(comp.get("max_clips", 15))]
    log(f"Building compilation from {len(chosen)} clips")
    video = build_compilation(cfg, state, chosen)
    video["built"] = dt.datetime.now().isoformat(timespec="seconds")
    for cid, _ in chosen:
        state["clips"][cid]["used_compilation"] = True
    state["videos"].append(video)
    save_state(state)
    log(f"Built: {video['title']}")


# ---------------------------------------------------------------- YouTube

def youtube_client(interactive: bool):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        sys.exit("Missing packages. Run: pip install -r requirements.txt")
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), YT_SCOPES)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        if not interactive:
            sys.exit("Not logged in to YouTube. Run: python muffinpop.py login")
        if not CLIENT_SECRET.exists():
            sys.exit("client_secret.json not found. See README step 4.")
        creds = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), YT_SCOPES).run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return build("youtube", "v3", credentials=creds)


def login(cfg: dict) -> None:
    yt = youtube_client(interactive=True)
    me = yt.channels().list(part="snippet", mine=True).execute().get("items", [])
    if not me:
        sys.exit("Logged in, but that Google account has no YouTube channel.")
    ch = me[0]
    log(f"Connected to channel: {ch['snippet']['title']} ({ch['id']})")
    if cfg.get("channel_id") and ch["id"] != cfg["channel_id"]:
        log(f"WARNING: that is not {cfg['channel_id']}. Delete token.json and log in again, "
            "choosing the MuffinPop channel when Google asks which account to use.")


def upload_all(cfg: dict, state: dict) -> None:
    if not cfg.get("upload", {}).get("enabled", True):
        return
    pending = [v for v in state["videos"] if not v["uploaded"] and Path(v["file"]).exists()]
    if not pending:
        log("Nothing to upload.")
        return
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload
    yt = youtube_client(interactive=False)
    up = cfg["upload"]
    for v in pending:
        publish = dt.datetime.fromisoformat(v["publish_at"])
        if publish < dt.datetime.now() + dt.timedelta(minutes=15):
            publish = next_publish(f"{publish:%H:%M}")
            v["publish_at"] = publish.isoformat()
        body = {
            "snippet": {"title": v["title"], "description": v["description"],
                        "tags": list(dict.fromkeys(v["tags"] + up.get("default_tags", [])))[:30],
                        "categoryId": str(up.get("category_id", "20"))},
            "status": {"privacyStatus": "private",
                       "publishAt": publish.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "selfDeclaredMadeForKids": bool(up.get("made_for_kids", False))},
        }
        log(f"Uploading {v['kind']}: {v['title']}")
        try:
            req = yt.videos().insert(part="snippet,status", body=body,
                                     media_body=MediaFileUpload(v["file"], chunksize=8 * 1024 * 1024, resumable=True))
            resp = None
            while resp is None:
                status, resp = req.next_chunk()
                if status:
                    print(f"  {int(status.progress() * 100)}%", end="\r", flush=True)
        except HttpError as e:
            if "quotaExceeded" in str(e) or "uploadLimitExceeded" in str(e):
                log("YouTube daily upload limit reached; will try again next run.")
                break
            log(f"Upload failed: {e}")
            continue
        v["uploaded"] = True
        v["video_id"] = resp["id"]
        save_state(state)
        log(f"Uploaded https://youtu.be/{resp['id']} (goes public {publish:%a %b %d %I:%M %p})")
        if v.get("thumbnail") and Path(v["thumbnail"]).exists():
            try:
                yt.thumbnails().set(videoId=resp["id"], media_body=MediaFileUpload(v["thumbnail"])).execute()
            except HttpError:
                log("Couldn't set thumbnail (your channel may need phone verification at youtube.com/verify).")


# ---------------------------------------------------------------- CLI

def status(state: dict) -> None:
    clips = state["clips"].values()
    print(f"Clips found:            {len(state['clips'])}")
    print(f"  unused for Shorts:    {sum(not c['used_short'] for c in clips)}")
    print(f"  unused for best-of:   {sum(not c['used_compilation'] for c in clips)}")
    print(f"Videos built:           {len(state['videos'])}")
    for v in state["videos"][-10:]:
        mark = f"uploaded youtu.be/{v['video_id']}" if v["uploaded"] else "waiting to upload"
        print(f"  [{v['kind']:<11}] {v['title']}  -> {mark}")


def main() -> None:
    ap = argparse.ArgumentParser(description="MuffinPop highlight channel automation")
    ap.add_argument("command", choices=["scan", "short", "compile", "upload", "run", "status", "login"])
    args = ap.parse_args()
    cfg = load_config()
    state = load_state()
    if args.command == "login":
        return login(cfg)
    if args.command == "status":
        return status(state)
    need_ffmpeg()
    if args.command in ("scan", "short", "compile", "run"):
        scan(cfg, state)
        save_state(state)
    if args.command in ("short", "run"):
        make_shorts(cfg, state)
    if args.command == "compile":
        make_compilation(cfg, state, force=True)
    if args.command == "run":
        make_compilation(cfg, state)
    if args.command in ("upload", "run"):
        upload_all(cfg, state)
    save_state(state)


if __name__ == "__main__":
    main()
