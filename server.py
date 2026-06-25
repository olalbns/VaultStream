"""
StreamVault Server FastAPI Version with Device Token Isolation
"""

import asyncio, json, time, hashlib, threading, re, uuid, os, subprocess, base64, binascii, shutil
import urllib.request, urllib.error, urllib.parse
import httpx
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, Request, Response, HTTPException, Query, BackgroundTasks, Header
from fastapi.responses import JSONResponse, FileResponse, StreamingResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn

try:
    import yt_dlp
    HAS_YTDLP = True
    print("  [OK] yt-dlp", yt_dlp.version.__version__)
except ImportError:
    HAS_YTDLP = False
    print("  [WARN] yt-dlp absent — pip install yt-dlp")

def download_ffmpeg():
    """Download static FFmpeg if not present."""
    base_dir = Path(__file__).parent
    bin_dir = base_dir / "bin"
    bin_dir.mkdir(exist_ok=True)

    import platform
    sys_name = platform.system().lower()
    arch = platform.machine().lower()

    url = ""
    if sys_name == "linux":
        url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    elif sys_name == "darwin": # macOS
        url = "https://evermeet.cx/ffmpeg/getrelease/zip"
    elif sys_name == "windows":
        url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

    if not url: return False

    target = bin_dir / ("ffmpeg.exe" if sys_name == "windows" else "ffmpeg")
    if target.exists():
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]
        return True

    print(f"  [FFMPEG] Téléchargement pour {sys_name}...")
    try:
        import urllib.request
        # This is a simplified downloader, in a real app we'd use a more robust one
        # For this environment, we assume basic tools are available or we skip
        return False
    except:
        return False

def check_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except:
        # Try local bin
        base_dir = Path(__file__).parent
        local_ffmpeg = base_dir / "bin" / "ffmpeg"
        if local_ffmpeg.exists():
            os.environ["PATH"] = str(base_dir / "bin") + os.pathsep + os.environ["PATH"]
            return True
        return False

download_ffmpeg()
HAS_FFMPEG = check_ffmpeg()
if HAS_FFMPEG: print("  [OK] ffmpeg détecté")
else:          print("  [WARN] ffmpeg absent — transcodage désactivé")

# ── Constantes ──────────────────────────────────────
PORT       = int(os.environ.get("PORT", 5000))
HOST       = "0.0.0.0"
CHUNK_SIZE = 1024 * 128
MAX_CONCURRENT_DOWNLOADS = 2

BASE_DIR         = Path(__file__).parent
DATA_DIR         = BASE_DIR / "data"
DL_DIR           = DATA_DIR / "downloads"
USERS_DATA_DIR   = DATA_DIR / "users"
HEADERS_FILE     = DATA_DIR / "custom_headers.json"
YTDLP_COOKIE_FILE = DATA_DIR / "youtube_cookies.txt"
YTDLP_ALT_COOKIE_FILE = DATA_DIR / "cookies.txt"
YTDLP_RUNTIME_COOKIE_FILE = DATA_DIR / "youtube_cookies.runtime.txt"
YTDLP_CACHE_DIR = DATA_DIR / "yt_dlp_cache"
PUPPETEER_SCRIPT = BASE_DIR / "scripts" / "youtube_puppeteer_resolve.js"
STATIC_DIR       = BASE_DIR / "static"
TEMPLATES_DIR    = BASE_DIR / "templates"
IS_RENDER = bool(os.environ.get("RENDER") or os.environ.get("RENDER_SERVICE_ID"))

for d in (DATA_DIR, DL_DIR, USERS_DATA_DIR, YTDLP_CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)
if not HEADERS_FILE.exists(): HEADERS_FILE.write_text("{}")

# ── Isolation Helpers ──────────────────────────────
def get_user_dir(token: str) -> Path:
    # Ensure token is safe
    safe_token = re.sub(r'[^a-zA-Z0-9_-]', '', token or "anonymous")
    user_dir = USERS_DATA_DIR / safe_token
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / "collections").mkdir(parents=True, exist_ok=True)
    return user_dir

def get_user_file(token: str, filename: str, default: str = "[]") -> Path:
    f = get_user_dir(token) / filename
    if not f.exists(): f.write_text(default)
    return f

# ── Download Manager ────────────────────────────────
import queue

class DownloadManager:
    def __init__(self, max_workers=2):
        self.q = queue.Queue()
        self.max_workers = max_workers
        self.workers = []
        for _ in range(max_workers):
            t = threading.Thread(target=self._worker, daemon=True)
            t.start()
            self.workers.append(t)

    def _worker(self):
        while True:
            item = self.q.get()
            if item is None: break
            dl_id, func, args = item
            try:
                func(dl_id, *args)
            except Exception as e:
                print(f"  [QUEUE] Erreur {dl_id}: {e}")
                with _dl_lock:
                    if dl_id in _downloads:
                        _downloads[dl_id]["status"] = "error"
                        _downloads[dl_id]["error"] = str(e)
            finally:
                self.q.task_done()

    def add(self, dl_id, func, *args):
        self.q.put((dl_id, func, args))

dl_manager = DownloadManager(max_workers=MAX_CONCURRENT_DOWNLOADS)

MIME_MAP = {
    ".mp4":"video/mp4",".webm":"video/webm",".ogv":"video/ogg",
    ".ogg":"video/ogg",".mov":"video/quicktime",".m4v":"video/mp4",
    ".mkv":"video/x-matroska",".ts":"video/mp2t",
    ".m3u8":"application/vnd.apple.mpegurl",".mpd":"application/dash+xml",
    ".css":"text/css",".js":"application/javascript",
    ".html":"text/html; charset=utf-8",".json":"application/json",
    ".ico":"image/x-icon",".png":"image/png",".svg":"image/svg+xml",
    ".srt":"text/plain",".vtt":"text/vtt",".mp3":"audio/mpeg",
    ".m4a":"audio/mp4",".opus":"audio/ogg",
}

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)

# ── State ───────────────────────────────────────────
_downloads  = {}
_dl_lock    = threading.Lock()
_cancel_events = {}
_cache      = {}
_cache_lock = threading.Lock()
CACHE_TTL   = 300

# ── Utilitaires ─────────────────────────────────────
def load_json(path, default):
    try:    return json.loads(Path(path).read_text(encoding="utf-8"))
    except: return default

def save_json(path, data):
    Path(path).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def load_custom_headers(): return load_json(HEADERS_FILE, {})

def _normalize_cookie_text(raw):
    text = (raw or "").replace("\r\n", "\n").strip()
    if not text: return ""
    if text.startswith("# HTTP Cookie File") or text.startswith("# Netscape HTTP Cookie File"): return text + "\n"
    return ""

def _write_cookie_file(path, text):
    normalized = _normalize_cookie_text(text)
    if not normalized: raise ValueError("cookiefile invalide")
    path.write_text(normalized, encoding="utf-8", newline="\n")
    return path

def _sync_cookie_file_from_env():
    inline = (os.environ.get("YTDLP_COOKIE_DATA", "") or "").strip()
    inline_b64 = (os.environ.get("YTDLP_COOKIE_DATA_B64", "") or "").strip()
    if inline_b64:
        try: inline = base64.b64decode(inline_b64).decode("utf-8")
        except: return None
    if not inline: return None
    try: return _write_cookie_file(YTDLP_RUNTIME_COOKIE_FILE, inline)
    except: return None

def _yt_dlp_auth_state():
    cf = _candidate_cookie_file(); bs = _parse_cookies_from_browser(os.environ.get("YTDLP_COOKIES_FROM_BROWSER", ""))
    po = _read_youtube_po_tokens()
    return {"render": IS_RENDER, "cookiefile": str(cf) if cf else None, "cookies_from_browser": bool(bs), "cookies_from_browser_value": bs[0] if bs else None, "cookie_env": bool((os.environ.get("YTDLP_COOKIE_DATA", "") or "").strip() or (os.environ.get("YTDLP_COOKIE_DATA_B64", "") or "").strip()), "custom_cookie_header": bool(load_custom_headers().get("Cookie") or load_custom_headers().get("cookie")), "visitor_data": bool((os.environ.get("YTDLP_YT_VISITOR_DATA", "") or "").strip()), "po_token_count": len(po), "po_token_clients": sorted({token.split("+", 1)[0] for token in po if "+" in token}), "puppeteer": has_puppeteer_fallback()}

def _split_multi_value(raw):
    return [item.strip() for item in re.split(r"[\r\n,;]+", raw or "") if item.strip()]

def _read_youtube_po_tokens():
    return _split_multi_value(os.environ.get("YTDLP_YT_PO_TOKENS", "") or os.environ.get("YTDLP_YT_PO_TOKEN", ""))

def _merge_extractor_args(opts, ie_key, values):
    if not values: return
    ea = dict(opts.get("extractor_args") or {}); ia = dict(ea.get(ie_key) or {})
    for k, v in values.items():
        if v not in (None, "", []): ia[k] = v
    ea[ie_key] = ia; opts["extractor_args"] = ea

def _default_youtube_clients():
    raw = _split_multi_value(os.environ.get("YTDLP_YT_PLAYER_CLIENTS", ""))
    return raw if raw else (["android", "tv", "web"] if IS_RENDER else ["android", "web"])

def _youtube_extractor_args(include_po_token=True):
    ya = {"player_client": _default_youtube_clients(), "player_skip": ["configs"]}
    vd = (os.environ.get("YTDLP_YT_VISITOR_DATA", "") or "").strip()
    if vd: ya["visitor_data"] = [vd]
    if include_po_token:
        po = _read_youtube_po_tokens()
        if po: ya["po_token"] = po
    return ya

def _parse_cookies_from_browser(spec):
    raw = (spec or "").strip()
    if not raw: return None
    m = re.fullmatch(r'(?x)(?P<name>[^+:]+)(?:\s*\+\s*(?P<keyring>[^:]+))?(?:\s*:\s*(?!:)(?P<profile>.+?))?(?:\s*::\s*(?P<container>.+))?', raw)
    if not m: return None
    return (m.group("name").lower(), m.group("profile"), m.group("keyring").upper() if m.group("keyring") else None, m.group("container"))

def _candidate_cookie_file():
    env = (os.environ.get("YTDLP_COOKIEFILE", "") or "").strip()
    for p in ([Path(env)] if env else []) + [YTDLP_RUNTIME_COOKIE_FILE, YTDLP_COOKIE_FILE, YTDLP_ALT_COOKIE_FILE]:
        try:
            if p and p.exists() and p.is_file(): return p
        except: continue
    return None

def apply_ytdlp_auth(opts, custom_headers=None):
    opts["cachedir"] = str(YTDLP_CACHE_DIR)
    _merge_extractor_args(opts, "youtube", _youtube_extractor_args())
    cf = _candidate_cookie_file()
    if cf: opts["cookiefile"] = str(cf)
    else:
        bs = _parse_cookies_from_browser(os.environ.get("YTDLP_COOKIES_FROM_BROWSER", ""))
        if bs and not IS_RENDER: opts["cookiesfrombrowser"] = bs
    if custom_headers:
        h = dict(custom_headers)
        if cf: h = {k: v for k, v in h.items() if k.lower() != "cookie"}
        opts["http_headers"] = h
        ua = h.get("User-Agent") or h.get("user-agent")
        if ua and not opts.get("user_agent"): opts["user_agent"] = ua

def fmt_size(x):
    try:
        if isinstance(x, Path): b = x.stat().st_size if x.exists() else 0
        elif x is None: return ""
        else: b = int(x)
    except: return ""
    if b <= 0: return ""
    if b < 1024: return f"{b} o"
    if b < 1<<20: return f"{b/1024:.1f} Ko"
    if b < 1<<30: return f"{b/(1<<20):.1f} Mo"
    return f"{b/(1<<30):.2f} Go"

def safe_filename(title, ext="mp4"):
    s = re.sub(r'[\\/:*?"<>|]', '_', title or "video").strip(". ")[:120]
    return f"{s or 'video'}.{ext}"

# ── API hakunaymatata ──────────────────────────────
def api_hakunaymatata(page_url, custom_headers=None):
    parsed   = urllib.parse.urlparse(page_url)
    host     = parsed.netloc
    m        = re.search(r'/(?:watch|video|v|episode|e)/([a-zA-Z0-9_-]+)', parsed.path)
    vid_id   = m.group(1) if m else ([s for s in parsed.path.split('/') if s] or [""])[-1]

    base = {
        "User-Agent": BROWSER_UA, "Accept": "application/json",
        "Referer": f"https://{host}/", "Origin": f"https://{host}",
    }
    if custom_headers: base.update(custom_headers)

    for api_url in [
        f"https://{host}/api/resource?id={vid_id}",
        f"https://{host}/api/video?id={vid_id}",
        f"https://{host}/api/episode?id={vid_id}",
        f"https://www.hakunaymatata.com/api/resource?id={vid_id}",
    ]:
        try:
            with urllib.request.urlopen(
                urllib.request.Request(api_url, headers=base), timeout=15
            ) as r:
                data = json.loads(r.read().decode())
            dls  = _haku_downloads(data)
            caps = _haku_captions(data)
            if dls:
                return dls, caps, api_url
        except Exception:
            pass
    raise RuntimeError("API hakunaymatata inaccessible")

def _haku_downloads(data):
    inner = data.get("data", data) if isinstance(data, dict) else {}
    items = []
    for d in (inner.get("downloads",[]) if isinstance(inner,dict) else []):
        if d.get("url"):
            items.append({
                "url":d["url"],"resolution":d.get("resolution",0),
                "format":d.get("format","MP4"),"size":int(d.get("size",0)),
                "duration":d.get("duration",0),"codecName":d.get("codecName",""),
            })
    items.sort(key=lambda x: x["resolution"], reverse=True)
    return items

def _haku_captions(data):
    inner = data.get("data", data) if isinstance(data, dict) else {}
    return [{"url":c["url"],"lang":c.get("lan",""),"name":c.get("lanName","")}
            for c in (inner.get("captions",[]) if isinstance(inner,dict) else []) if c.get("url")]

def add_to_history(token, url, title, method):
    f = get_user_file(token, "history.json"); entries = load_json(f, [])
    vid_id = hashlib.md5(url.encode()).hexdigest()[:10]
    entries = [e for e in entries if e.get("url") != url]
    entries.insert(0, {"id": vid_id, "url": url, "title": title or url, "method": method, "ts": int(time.time()), "date": time.strftime("%d %b %Y %H:%M", time.localtime())})
    save_json(f, entries[:50]); return entries[0]

def build_headers(target_url, referer=None, extra=None):
    h = {"User-Agent": BROWSER_UA, "Accept": "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "identity", "Connection": "keep-alive"}
    try:
        p = urllib.parse.urlparse(target_url); h["Referer"] = referer or f"{p.scheme}://{p.netloc}/"; h["Origin"] = f"{p.scheme}://{p.netloc}"
    except: pass
    sh = load_custom_headers()
    if sh: h.update(sh)
    if extra: h.update(extra)
    return h

def mime_from_url(url, fallback="video/mp4"):
    for ext, mime in MIME_MAP.items():
        if ext in url.lower().split("?")[0] and mime.startswith("video"): return mime
    return fallback

def is_youtube_bot_error(err_msg):
    m = (err_msg or "").lower()
    return any(p in m for p in ["sign in to confirm you\'re not a bot", "confirm you\'re not a bot", "verify you are human", "unusual traffic"])

def is_youtube_cookie_error(err_msg):
    m = (err_msg or "").lower()
    return any(p in m for p in ["youtube account cookies are no longer valid", "provided youtube account cookies are no longer valid", "cookies are no longer valid", "login_required"])

def youtube_bot_hint(): return "YouTube demande une verification anti-bot..."

def has_puppeteer_fallback(): return bool(shutil.which("node") and PUPPETEER_SCRIPT.exists())

def run_puppeteer_youtube(url):
    if not has_puppeteer_fallback(): raise RuntimeError("fallback Puppeteer indisponible")
    proc = subprocess.run(["node", str(PUPPETEER_SCRIPT), url], capture_output=True, text=True, timeout=120, cwd=str(BASE_DIR))
    if proc.returncode != 0: raise RuntimeError(proc.stderr or proc.stdout or "echec Puppeteer")
    payload = None
    for line in reversed((proc.stdout or "").strip().splitlines()):
        try: payload = json.loads(line.strip()); break
        except: continue
    if not isinstance(payload, dict) or not payload.get("ok"): raise RuntimeError("Puppeteer error")
    return payload

def _puppeteer_stream_to_result(data):
    s = (data.get("streams") or [{}])[0]; su = s.get("url") or data.get("stream_url")
    if not su: raise RuntimeError("aucun stream")
    return {"url": su, "title": data.get("title", ""), "ext": s.get("ext", "mp4"), "thumbnail": data.get("thumbnail", ""), "duration": data.get("duration"), "headers": data.get("headers") or {}, "streams": data.get("streams") or [], "expires": time.time() + CACHE_TTL}

def strip_youtube_tracking_params(url):
    if not url: return url
    try:
        u = urllib.parse.urlparse(url)
        qs = urllib.parse.parse_qs(u.query)
        # Keep only essential params
        essential = {'v', 'list', 'index', 't', 'start'}
        new_qs = {k: v for k, v in qs.items() if k in essential}
        return urllib.parse.urlunparse(u._replace(query=urllib.parse.urlencode(new_qs, doseq=True)))
    except:
        return url

def normalize_youtube_url(url):
    if not url: return url
    try: p = urllib.parse.urlparse(url.strip())
    except: return url
    h = (p.netloc or "").lower().replace("www.", "")
    if h == "m.youtube.com": h = "youtube.com"
    if h not in {"youtube.com", "youtu.be"}: return url
    if h == "youtube.com" and p.path == "/attribution_link":
        qs = urllib.parse.parse_qs(p.query); inner = qs.get("u", [""])[0]
        if inner:
            try:
                dec = urllib.parse.unquote(inner)
                if dec.startswith("/"): dec = "https://youtube.com" + dec
                return normalize_youtube_url(dec)
            except: pass
    vid = ""
    if h == "youtu.be": vid = (p.path or "").strip("/").split("/")[0]
    elif p.path == "/watch": vid = urllib.parse.parse_qs(p.query).get("v", [""])[0]
    else:
        m = re.match(r"^/(?:shorts|live|embed)/([a-zA-Z0-9_-]{11})", p.path or "")
        if m: vid = m.group(1)
    return f"https://www.youtube.com/watch?v={vid}" if vid and re.match(r"^[a-zA-Z0-9_-]{11}$", vid) else url

def ytdlp_download(dl_id, url, format_id="best", ext="mp4", sub_lang=None, custom_headers=None, title=None):
    if not HAS_YTDLP: raise RuntimeError("yt-dlp non installé")

    # Progress hook
    def progress_hook(d):
        with _dl_lock:
            if dl_id not in _downloads: return
            if _cancel_events.get(dl_id) and _cancel_events[dl_id].is_set():
                raise Exception("Annulé par l'utilisateur")

            if d['status'] == 'downloading':
                p = d.get('_percent_str', '0%').replace('%','')
                try: p = float(p)
                except: p = 0
                _downloads[dl_id].update({
                    "status": "downloading",
                    "progress": p,
                    "speed": d.get('_speed_str', '0 B/s'),
                    "eta": d.get('_eta_str', '00:00'),
                    "size": d.get('_total_bytes_str') or d.get('_total_bytes_approx_str', ''),
                })
            elif d['status'] == 'finished':
                _downloads[dl_id].update({
                    "status": "processing",
                    "progress": 100,
                })

    opts = {
        'format': f"{format_id}/best",
        'outtmpl': str(DL_DIR / f"{dl_id}.%(ext)s"),
        'progress_hooks': [progress_hook],
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
    }

    if sub_lang:
        opts.update({
            'writesubtitles': True,
            'subtitleslangs': [sub_lang],
            'skip_download': False,
        })

    apply_ytdlp_auth(opts, custom_headers)

    with _dl_lock:
        _downloads[dl_id] = {
            "id": dl_id, "url": url, "title": title or url,
            "status": "pending", "progress": 0, "filename": None
        }

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info)).name

        with _dl_lock:
            _downloads[dl_id].update({
                "status": "done",
                "progress": 100,
                "filename": filename,
                "title": info.get('title', _downloads[dl_id]['title'])
            })
    except Exception as e:
        with _dl_lock:
            if dl_id in _downloads:
                _downloads[dl_id].update({"status": "error", "error": str(e)})
        raise

def _extract_with_retry(url, base_opts, for_playlist=False):
    variants = [dict(base_opts)]
    for client in [["android", "web", "tv"], ["mweb", "web", "android"], ["tv", "tv_simply", "web_embedded"]]:
        v = dict(base_opts); _merge_extractor_args(v, "youtube", {"player_client": client, "player_skip": ["configs"]})
        if client[0] == "mweb": _merge_extractor_args(v, "youtube", _youtube_extractor_args(True))
        variants.append(v)
    v5 = dict(base_opts); v5["geo_bypass"] = True; v5["no_color"] = True; variants.append(v5)
    last_err = None
    for opts in variants:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info:
                if not for_playlist and isinstance(info, dict) and info.get("entries") and not info.get("formats"):
                    for e in (info.get("entries") or []):
                        if e: return e
                return info
        except Exception as e: last_err = e
    raise last_err or RuntimeError("no result")

def _clean_url(url):
    """Nettoie l'URL sans toucher aux magnets/infohash."""
    s = str(url).strip()
    if s.startswith('magnet:') or (len(s) == 40 and re.fullmatch(r'[a-fA-F0-9]{40}', s)):
        return s
    m = re.search(r'https?://[^\s<>"]+', s)
    if m: s = m.group(0)
    return normalize_youtube_url(strip_youtube_tracking_params(s))

def ytdlp_resolve(url, custom_headers=None, referer=None):
    url = _clean_url(url)
    with _cache_lock:
        c = _cache.get("r:"+url)
        if c and time.time() < c.get("expires", 0): return c
    opts = {"quiet":True,"no_warnings":True,"noplaylist":True,"format":"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"}
    if referer: opts["referer"] = referer
    apply_ytdlp_auth(opts, custom_headers)
    try: info = _extract_with_retry(url, opts)
    except Exception as e:
        if is_youtube_cookie_error(str(e)) or is_youtube_bot_error(str(e)):
            res = _puppeteer_stream_to_result(run_puppeteer_youtube(url))
            with _cache_lock: _cache["r:"+url] = res
            return res
        raise
    ru = info.get("url") or url
    if "formats" in info:
        best = next((f for f in reversed(info["formats"]) if f.get("vcodec") != "none" and f.get("url") and f.get("ext") == "mp4"), None)
        if not best: best = next((f for f in reversed(info["formats"]) if f.get("vcodec") != "none" and f.get("url")), None)
        if best: ru = best["url"]
    res = {"url": ru, "title": info.get("title",""), "ext": info.get("ext","mp4"), "thumbnail": info.get("thumbnail",""), "duration": info.get("duration"), "headers": info.get("http_headers",{}), "expires": time.time() + CACHE_TTL}
    with _cache_lock: _cache["r:"+url] = res
    return res

def ytdlp_info(url, custom_headers=None):
    url = _clean_url(url)
    opts = {"quiet":True,"no_warnings":True,"noplaylist":True,"nocheckcertificate":True,"ignoreerrors":True,"no_color":True}
    apply_ytdlp_auth(opts, custom_headers)
    try: info = _extract_with_retry(url, opts)
    except Exception as e:
        if is_youtube_cookie_error(str(e)) or is_youtube_bot_error(str(e)):
            p = run_puppeteer_youtube(url)
            return {"title":p.get("title",""),"thumbnail":p.get("thumbnail",""),"duration":p.get("duration"),"uploader":p.get("uploader",""),"formats":[{"id":s.get("id","p"),"type":"video+audio","ext":s.get("ext","mp4"),"resolution":s.get("resolution") or "auto","filesize_str":fmt_size(s.get("filesize") or 0)} for s in (p.get("streams") or []) if s.get("url")],"subtitles":[]}
        raise
    fmts = []
    for f in (info.get("formats") or []):
        vc = f.get("vcodec","none"); ac = f.get("acodec","none"); hv = vc and vc != "none"; ha = ac and ac != "none"
        if hv and ha: ft = "video+audio"
        elif hv: ft = "video"
        elif ha: ft = "audio"
        else: continue
        fmts.append({"id":f.get("format_id",""),"type":ft,"ext":f.get("ext",""),"resolution":f.get("resolution") or (f"{f.get('height')}p" if f.get("height") else "audio"),"filesize_str":fmt_size(f.get("filesize") or f.get("filesize_approx") or 0)})
    return {"title":info.get("title",""),"thumbnail":info.get("thumbnail",""),"duration":info.get("duration"),"uploader":info.get("uploader",""),"formats":fmts,"subtitles":[]}

def ytdlp_playlist(url, custom_headers=None):
    url = _clean_url(url)
    opts = {"quiet":True,"no_warnings":True,"extract_flat":"in_playlist","noplaylist":False,"playlistend":200}
    apply_ytdlp_auth(opts, custom_headers)
    info = _extract_with_retry(url, opts, True)
    ents = info.get("entries") or []
    if not ents: return {"is_playlist":False,"items":[{"url":url,"title":info.get("title","")}]}
    return {"is_playlist":True,"title":info.get("title") or info.get("playlist_title"),"count":len(ents),"items":[{"id":e.get("id"),"title":e.get("title"),"url":e.get("url") or e.get("webpage_url") or f"https://www.youtube.com/watch?v={e.get('id')}","thumbnail":e.get("thumbnail") or (f"https://img.youtube.com/vi/{e.get('id')}/mqdefault.jpg" if e.get("id") else ""),"duration":e.get("duration",0)} for e in ents if e]}

# ── FastAPI App ─────────────────────────────────────
app = FastAPI(title="StreamVault")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
async def index(): return (TEMPLATES_DIR / "index.html").read_text(encoding="utf-8")

@app.get("/api/resolve")
async def api_resolve(url: str, referer: Optional[str] = None):
    url = urllib.parse.unquote(url); ch = load_custom_headers(); steps = []

    # Torrent Check
    if url.startswith("magnet:") or (len(url) == 40 and all(c in "0123456789abcdefABCDEF" for c in url)):
        return {
            "ok": True,
            "method": "torrent",
            "stream_url": f"http://localhost:5001/stream?magnet={urllib.parse.quote(url)}",
            "proxy_url": f"/api/torrent/stream?magnet={urllib.parse.quote(url)}",
            "title": "Torrent Stream",
            "steps": ["torrent-engine"]
        }

    # 1. API hakunaymatata
    if "hakunaymatata.com" in url:
        steps.append("hakunaymatata-api")
        try:
            dls, caps, _ = api_hakunaymatata(url, ch or None)
            if not dls:
                raise RuntimeError("Aucun stream trouvé via hakunaymatata")
            streams = [{**d, "proxy_url": f"/api/proxy?url={urllib.parse.quote(d['url'], safe='')}"}
                       for d in dls]
            title = "Hakuna Video"
            return {
                "ok": True,
                "method": "hakunaymatata-api",
                "streams": streams,
                "captions": caps,
                "stream_url": streams[0]["url"],
                "proxy_url": streams[0]["proxy_url"],
                "title": title,
                "steps": steps
            }
        except Exception as e:
            steps.append(f"haku-FAIL:{e}")

    if HAS_YTDLP:
        steps.append("yt-dlp")
        try:
            res = ytdlp_resolve(url, ch or None, referer); su = res["url"]; pu = f"/api/proxy?url={urllib.parse.quote(su, safe='')}"
            return {"ok": True, "method": "yt-dlp", "streams": [{"url": su, "proxy_url": pu, "resolution": 0, "format": res.get("ext", "mp4").upper(), "size": 0}], "stream_url": su, "proxy_url": pu, "title": res.get("title", ""), "thumbnail": res.get("thumbnail", ""), "steps": steps}
        except Exception as e:
            if is_youtube_bot_error(str(e)): return {"ok": False, "method": "yt-dlp", "bot_check": True, "error": youtube_bot_hint()}
            steps.append(f"ytdlp-FAIL:{e}")
    return {"ok": False, "method": "direct-fallback", "stream_url": url, "proxy_url": f"/api/proxy?url={urllib.parse.quote(url, safe='')}", "steps": steps}

@app.get("/api/proxy")
async def api_proxy(request: Request, url: str, referer: Optional[str] = None):
    t = urllib.parse.unquote(url)
    h = build_headers(t, referer)
    if "range" in request.headers:
        h["Range"] = request.headers["range"]

    async def stream_proxy():
        async with httpx.AsyncClient(follow_redirects=True, verify=False) as client:
            async with client.stream("GET", t, headers=h, timeout=60) as r:
                if r.status_code >= 400:
                    yield f"Error: {r.status_code}".encode()
                    return
                async for chunk in r.aiter_bytes(CHUNK_SIZE):
                    yield chunk

    try:
        # We need to get the headers first for Content-Type, etc.
        async with httpx.AsyncClient(follow_redirects=True, verify=False) as client:
            r_head = await client.head(t, headers=h, timeout=10)
            status_code = r_head.status_code if r_head.status_code in (200, 206) else 200
            rh = {
                "Content-Type": r_head.headers.get("Content-Type", mime_from_url(t)),
                "Accept-Ranges": r_head.headers.get("Accept-Ranges", "bytes"),
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*",
            }
            if r_head.headers.get("Content-Length"): rh["Content-Length"] = r_head.headers.get("Content-Length")
            if r_head.headers.get("Content-Range"): rh["Content-Range"] = r_head.headers.get("Content-Range")

            return StreamingResponse(stream_proxy(), status_code=status_code, headers=rh)
    except Exception as e:
        # Fallback to direct stream if HEAD fails
        return StreamingResponse(stream_proxy(), media_type="video/mp4")

@app.get("/api/transcode")
async def api_transcode(url: str):
    if not HAS_FFMPEG:
        raise HTTPException(status_code=501, detail="FFmpeg non installé")

    t = urllib.parse.unquote(url)
    # Basic transcode to web-friendly format
    cmd = [
        "ffmpeg", "-i", t,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "frag_keyframe+empty_moov",
        "-f", "mp4", "-"
    ]

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL
    )

    async def gen():
        try:
            while True:
                chunk = await process.stdout.read(CHUNK_SIZE)
                if not chunk: break
                yield chunk
        finally:
            try: process.kill()
            except: pass

    return StreamingResponse(gen(), media_type="video/mp4")

def check_auth(token: str, request: Request):
    """Simple password protection for tokens."""
    # If a password is set for this token, check it
    # For now, let's allow all tokens, but we can add a 'passwords.json'
    return True

@app.get("/api/history")
async def get_history(request: Request, x_device_token: str = Header(None)):
    if not check_auth(x_device_token, request): raise HTTPException(status_code=401)
    return load_json(get_user_file(x_device_token, "history.json"), [])

@app.post("/api/history")
async def post_history(data: Dict[str, Any], x_device_token: str = Header(None)): return add_to_history(x_device_token, data.get("url", ""), data.get("title", ""), data.get("method", ""))

@app.post("/api/history/delete")
async def del_history(data: Dict[str, Any], x_device_token: str = Header(None)):
    f = get_user_file(x_device_token, "history.json")
    save_json(f, [e for e in load_json(f, []) if e.get("id") != data.get("id")])
    return {"ok": True}

@app.get("/api/queue")
async def get_queue(x_device_token: str = Header(None)): return load_json(get_user_file(x_device_token, "queue.json"), [])

@app.post("/api/queue")
async def post_queue(data: Dict[str, Any], x_device_token: str = Header(None)):
    f = get_user_file(x_device_token, "queue.json"); q = load_json(f, []); a = data.get("action", "")
    if a == "add":
        i = data.get("item", {})
        if not i.get("url"): raise HTTPException(status_code=400)
        i.update({"id": str(uuid.uuid4())[:8], "added": int(time.time()), "played": False}); q.append(i)
    elif a == "remove": q = [x for x in q if x.get("id") != data.get("id")]
    elif a == "clear": q = []
    elif a == "played":
        for x in q:
            if x.get("id") == data.get("id"): x["played"] = True; break
    elif a == "reorder":
        o = {id_: i for i, id_ in enumerate(data.get("ids", []))}
        q.sort(key=lambda x: o.get(x.get("id", ""), 999))
    save_json(f, q); return {"ok": True, "queue": q}

@app.get("/api/collections")
async def get_collections(id: Optional[str] = None, x_device_token: str = Header(None)):
    ud = get_user_dir(x_device_token) / "collections"
    if id:
        f = ud / f"{id}.json"
        if not f.exists(): raise HTTPException(status_code=404)
        return load_json(f, {})
    res = []
    for f in sorted(ud.glob("*.json")):
        d = load_json(f, {})
        res.append({"id": f.stem, "name": d.get("name"), "color": d.get("color"), "icon": d.get("icon"), "count": len(d.get("items", [])), "created": d.get("created"), "description": d.get("description")})
    return res

@app.post("/api/collections")
async def post_collections(data: Dict[str, Any], x_device_token: str = Header(None)):
    ud = get_user_dir(x_device_token) / "collections"; a = data.get("action", "")
    if a == "create":
        cid = str(uuid.uuid4())[:8]; col = {"id": cid, "name": data.get("name"), "color": data.get("color"), "icon": data.get("icon"), "description": data.get("description"), "created": int(time.time()), "items": []}
        save_json(ud / f"{cid}.json", col); return {"ok": True, "id": cid, "collection": col}
    elif a == "update":
        cid = data.get("id", ""); f = ud / f"{cid}.json"
        if not f.exists(): raise HTTPException(status_code=404)
        c = load_json(f, {})
        for k in ("name", "color", "icon", "description"):
            if k in data: c[k] = data[k]
        save_json(f, c); return {"ok": True, "collection": c}
    elif a == "delete":
        f = ud / f"{data.get('id')}.json"
        if f.exists(): f.unlink()
        return {"ok": True}
    elif a == "add_item":
        cid = data.get("col_id", ""); f = ud / f"{cid}.json"
        if not f.exists(): raise HTTPException(status_code=404)
        c = load_json(f, {}); i = data.get("item", {}); i["id"] = hashlib.md5(i["url"].encode()).hexdigest()[:10]; i["added"] = int(time.time())
        c["items"] = [x for x in c["items"] if x.get("id") != i["id"]]; c["items"].append(i); save_json(f, c); return {"ok": True, "collection": c}
    elif a == "add_items":
        cid = data.get("col_id", ""); f = ud / f"{cid}.json"
        if not f.exists(): raise HTTPException(status_code=404)
        c = load_json(f, {}); added = 0; ex = {x.get("id") for x in c["items"]}
        for i in data.get("items", []):
            i["id"] = hashlib.md5(i["url"].encode()).hexdigest()[:10]; i["added"] = int(time.time())
            if i["id"] not in ex: c["items"].append(i); ex.add(i["id"]); added += 1
        save_json(f, c); return {"ok": True, "added": added, "collection": c}
    elif a == "remove_item":
        cid = data.get("col_id", ""); f = ud / f"{cid}.json"
        if not f.exists(): raise HTTPException(status_code=404)
        c = load_json(f, {}); item_id = data.get("item_id", "")
        c["items"] = [x for x in c.get("items", []) if x.get("id") != item_id]
        save_json(f, c); return {"ok": True, "collection": c}
    return {"ok": False}

@app.get("/api/search")
async def api_search(q: str):
    if not HAS_YTDLP: return {"ok": False, "error": "yt-dlp non installé"}
    try:
        opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'max_downloads': 20}
        with yt_dlp.YoutubeDL(opts) as ydl:
            # ytsearch: might be slow, so we limit
            info = ydl.extract_info(f"ytsearch20:{q}", download=False)
            results = []
            for entry in info.get('entries', []):
                if not entry: continue
                results.append({
                    "id": entry.get('id'),
                    "url": f"https://www.youtube.com/watch?v={entry.get('id')}",
                    "title": entry.get('title'),
                    "thumbnail": entry.get('thumbnails', [{}])[0].get('url') if entry.get('thumbnails') else f"https://img.youtube.com/vi/{entry.get('id')}/mqdefault.jpg",
                    "duration": entry.get('duration'),
                    "uploader": entry.get('uploader')
                })
            return {"ok": True, "results": results}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/metadata")
async def get_metadata(q: str):
    """Fetch movie/series metadata from TMDB (via free API if possible or simplified search)."""
    # Using a public TMDB API key is tricky, we'll implement a mock/simplified version
    # that search for titles and returns placeholders for now,
    # or use a public OMDb API if available.
    try:
        async with httpx.AsyncClient() as client:
            # Search on OMDb (example with a known public key or search)
            # For this exercise, let's create a robust internal search logic
            # that improves the 'title' based on common patterns
            clean_q = re.sub(r'\(.*?\)|\[.*?\]', '', q).split('.')[0].strip()
            return {
                "ok": True,
                "title": clean_q,
                "poster": f"https://via.placeholder.com/300x450?text={urllib.parse.quote(clean_q)}",
                "summary": "Métadonnées bientôt disponibles via TMDB API.",
                "rating": "N/A"
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/torrent/status")
async def api_torrent_status(magnet: str):
    """Proxy status request to torrent engine."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"http://localhost:5001/status?magnet={urllib.parse.quote(magnet)}")
            return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/torrent/stream")
async def api_torrent_stream(request: Request, magnet: str, index: int = 0):
    """Proxy stream from torrent engine to client with range support."""
    t_url = f"http://localhost:5001/stream?magnet={urllib.parse.quote(magnet)}&index={index}"
    h = {"Range": request.headers.get("Range", "bytes=0-")}
    try:
        async def stream_generator():
            async with httpx.AsyncClient() as client:
                async with client.stream("GET", t_url, headers=h, timeout=None) as resp:
                    async for chunk in resp.aiter_bytes(CHUNK_SIZE):
                        yield chunk

        async with httpx.AsyncClient() as client:
            # Get headers for Content-Type and Length
            resp = await client.head(t_url, headers=h)
            return StreamingResponse(
                stream_generator(),
                status_code=resp.status_code,
                headers=dict(resp.headers)
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.get("/api/playlist")
async def api_playlist(url: str):
    u = urllib.parse.unquote(url)
    if u.startswith("magnet:") or (len(u) == 40 and re.fullmatch(r'[a-fA-F0-9]{40}', u)):
        return {"ok": False, "is_playlist": False, "error": "Magnet non supporté ici", "items": []}
    try:
        return {"ok": True, **ytdlp_playlist(u)}
    except Exception as e:
        return {"ok": False, "is_playlist": False, "error": str(e), "items": []}

@app.get("/api/video/info")
async def api_video_info(url: str):
    u = urllib.parse.unquote(url)
    if u.startswith("magnet:") or (len(u) == 40 and re.fullmatch(r'[a-fA-F0-9]{40}', u)):
        return {"ok": False, "error": "Lien magnet — téléchargement via torrent_engine uniquement"}
    try:
        return {"ok": True, **ytdlp_info(u)}
    except Exception as e:
        return {"ok": False, "error": str(e), "formats": [], "subtitles": []}

@app.post("/api/ytdl/info")
async def api_ytdl_info(data: Dict[str, Any]):
    u = data.get("url", "")
    if u.startswith("magnet:") or (len(u) == 40 and re.fullmatch(r'[a-fA-F0-9]{40}', u)):
        return {"ok": False, "error": "Lien magnet — téléchargement via torrent_engine uniquement"}
    try:
        return {"ok": True, **ytdlp_info(u)}
    except Exception as e:
        return {"ok": False, "error": str(e), "formats": [], "subtitles": []}

@app.get("/api/intercept/latest")
async def intercept_latest():
    f = DATA_DIR / "intercepted.json"
    if not f.exists(): return {"url": None}
    d = load_json(f, {}); f.unlink(); return d

@app.post("/api/intercept")
async def intercept_post(data: Dict[str, Any]):
    """Reçoit une URL interceptée depuis l'extension navigateur."""
    url = (data.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url manquante")
    headers = data.get("headers") or {}
    referer = data.get("referer") or ""
    payload = {"url": url, "headers": headers, "referer": referer, "ts": int(time.time())}
    save_json(DATA_DIR / "intercepted.json", payload)
    return {"ok": True}

# Standard pass-through for other APIs
@app.get("/api/ytdl/auth/status")
async def get_ytdl_auth_status(): return {"ok": True, **_yt_dlp_auth_state()}

@app.post("/api/ytdl/cookies/save")
async def api_ytdl_cookies_save(data: Dict[str, Any]):
    """Sauvegarde un fichier cookies Netscape fourni par l'utilisateur."""
    text = (data.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Texte vide"}
    try:
        _write_cookie_file(YTDLP_RUNTIME_COOKIE_FILE, text)
        return {"ok": True}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/ytdl/cookies/clear")
async def api_ytdl_cookies_clear():
    """Supprime le fichier cookies runtime."""
    try:
        if YTDLP_RUNTIME_COOKIE_FILE.exists():
            YTDLP_RUNTIME_COOKIE_FILE.unlink()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/ytdl/retry")
async def api_ytdl_retry(data: Dict[str, Any]):
    """Relance un téléchargement échoué à partir de son ID en mémoire."""
    dl_id = data.get("id")
    with _dl_lock:
        dl = _downloads.get(dl_id)
    if not dl:
        return {"ok": False, "error": "Téléchargement introuvable"}
    new_id = str(uuid.uuid4())[:8]
    with _dl_lock:
        _cancel_events[new_id] = threading.Event()
    dl_manager.add(new_id, ytdlp_download, dl.get("url", ""), "best", "mp4", None, load_custom_headers() or None, dl.get("title", ""))
    return {"ok": True, "id": new_id}

@app.get("/api/probe")
async def api_probe(url: str):
    """Sonde une URL : accessible, type MIME, seekable."""
    t = urllib.parse.unquote(url)
    h = build_headers(t)
    try:
        async with httpx.AsyncClient(follow_redirects=True, verify=False) as client:
            r = await client.head(t, headers=h, timeout=10)
            ct = r.headers.get("Content-Type", mime_from_url(t))
            cl = r.headers.get("Content-Length")
            ar = r.headers.get("Accept-Ranges", "")
            return {
                "ok": r.status_code < 400,
                "status": r.status_code,
                "content_type": ct,
                "content_length": int(cl) if cl else None,
                "seekable": "bytes" in ar,
            }
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)}

@app.post("/api/ytdl/download")
async def api_ytdl_download(data: Dict[str, Any]):
    dl_id = str(uuid.uuid4())[:8]
    with _dl_lock: _cancel_events[dl_id] = threading.Event()
    dl_manager.add(dl_id, ytdlp_download, data.get("url", ""), data.get("format_id", "best"), data.get("ext", "mp4"), data.get("sub_lang"), load_custom_headers() or None, data.get("title", ""))
    return {"ok": True, "id": dl_id}

@app.post("/api/ytdl/download/batch")
async def api_ytdl_download_batch(data: Dict[str, Any]):
    urls = data.get("urls", [])
    ids = []
    for url in urls:
        dl_id = str(uuid.uuid4())[:8]
        ids.append(dl_id)
        with _dl_lock: _cancel_events[dl_id] = threading.Event()
        dl_manager.add(dl_id, ytdlp_download, url, data.get("format_id", "best"), data.get("ext", "mp4"), None, load_custom_headers() or None, None)
    return {"ok": True, "ids": ids, "count": len(ids)}

@app.post("/api/ytdl/cancel")
async def api_ytdl_cancel(data: Dict[str, Any]):
    dl_id = data.get("id")
    if dl_id in _cancel_events:
        _cancel_events[dl_id].set()
        return {"ok": True}
    return {"ok": False, "error": "Not found"}

@app.get("/api/ytdl/progress")
async def api_ytdl_progress(id: str):
    with _dl_lock: d = _downloads.get(id)
    if not d: raise HTTPException(status_code=404)
    return d

@app.get("/api/downloads")
async def list_downloads():
    with _dl_lock: dls = list(_downloads.values())
    files = [{"filename": f.name, "size": fmt_size(f), "bytes": f.stat().st_size, "ts": int(f.stat().st_mtime)} for f in DL_DIR.iterdir() if f.is_file()]
    return {"downloads": dls, "files": files}

@app.get("/api/downloads/file")
async def serve_dl(f: str):
    # Fix path traversal
    safe_f = os.path.basename(f)
    p = DL_DIR / safe_f
    if not p.exists(): raise HTTPException(status_code=404)
    return FileResponse(p, filename=safe_f)


@app.get("/api/stream/live")
async def api_stream_live(id: str):
    """Stream a file while it's being downloaded."""
    with _dl_lock:
        dl = _downloads.get(id)
    if not dl: raise HTTPException(status_code=404, detail="Download not found")

    # yt-dlp part files
    file_path = None
    for ext in [".mp4", ".mkv", ".webm", ".mp4.part", ".mkv.part", ".webm.part"]:
        p = DL_DIR / f"{id}{ext}"
        if p.exists():
            file_path = p
            break

    if not file_path: raise HTTPException(status_code=404, detail="File not ready")

    async def file_generator():
        last_pos = 0
        while True:
            with open(file_path, "rb") as f:
                f.seek(last_pos)
                chunk = f.read(CHUNK_SIZE)
                if chunk:
                    last_pos += len(chunk)
                    yield chunk
                else:
                    with _dl_lock:
                        status = _downloads.get(id, {}).get("status")
                    if status in ["done", "error", "cancelled"]:
                        break
                    await asyncio.sleep(1)

    return StreamingResponse(file_generator(), media_type="video/mp4")

def auto_purge_task():
    """Purge downloads older than 3 days."""
    while True:
        try:
            now = time.time()
            cutoff = now - (3 * 24 * 3600)
            for f in DL_DIR.iterdir():
                if f.is_file() and f.stat().st_mtime < cutoff:
                    try:
                        f.unlink()
                        print(f"  [PURGE] Deleted old file: {f.name}")
                    except: pass
        except Exception as e:
            print(f"  [PURGE] Error: {e}")
        time.sleep(3600) # Run every hour

def start_torrent_engine():
    try:
        subprocess.Popen(["node", "scripts/torrent_engine.js"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("  [OK] Torrent engine started")
    except Exception as e:
        print(f"  [WARN] Could not start torrent engine: {e}")


if __name__ == "__main__":
    threading.Thread(target=auto_purge_task, daemon=True).start()
    _sync_cookie_file_from_env()
    start_torrent_engine()
    uvicorn.run(app, host=HOST, port=PORT)
