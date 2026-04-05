"""
StreamVault Server v5 — Fichier unique, tout dans la classe Handler.
Corrections :
  - h_get_collections / h_post_collections dans la classe (plus de monkey-patching)
  - fmt_size() corrigé (accepte Path, int ou None)
  - Nom de fichier téléchargé = titre de la vidéo

Lancer : python server.py
Deps   : pip install yt-dlp
"""

import json, time, hashlib, threading, re, uuid, os, subprocess
import urllib.request, urllib.error, urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

try:
    import yt_dlp
    HAS_YTDLP = True
    print("  [OK] yt-dlp", yt_dlp.version.__version__)
except ImportError:
    HAS_YTDLP = False
    print("  [WARN] yt-dlp absent — pip install yt-dlp")

def check_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except:
        return False

HAS_FFMPEG = check_ffmpeg()
if HAS_FFMPEG: print("  [OK] ffmpeg détecté")
else:          print("  [WARN] ffmpeg absent — transcodage désactivé")

# ── Constantes ──────────────────────────────────────────
PORT       = int(os.environ.get("PORT", 5000))
HOST       = "0.0.0.0"
CHUNK_SIZE = 1024 * 128
MAX_CONCURRENT_DOWNLOADS = 2  # Important pour Render Free (RAM limitée)

BASE_DIR         = Path(__file__).parent
DATA_DIR         = BASE_DIR / "data"
DL_DIR           = DATA_DIR / "downloads"
COLLECTIONS_DIR  = DATA_DIR / "collections"
HISTORY_FILE     = DATA_DIR / "history.json"
HEADERS_FILE     = DATA_DIR / "custom_headers.json"
QUEUE_FILE       = DATA_DIR / "queue.json"
STATIC_DIR       = BASE_DIR / "static"
TEMPLATES_DIR    = BASE_DIR / "templates"

for d in (DATA_DIR, DL_DIR, COLLECTIONS_DIR):
    d.mkdir(parents=True, exist_ok=True)
for f, v in [(HISTORY_FILE,"[]"),(HEADERS_FILE,"{}"),(QUEUE_FILE,"[]")]:
    if not f.exists(): f.write_text(v)

# ── Download Manager (Queue & Retry) ────────────────────
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

# ── State ───────────────────────────────────────────────
_downloads  = {}   # dl_id → progress dict
_dl_lock    = threading.Lock()
_cache      = {}
_cache_lock = threading.Lock()
CACHE_TTL   = 300

# ── Utilitaires globaux ─────────────────────────────────
def load_json(path, default):
    try:    return json.loads(Path(path).read_text(encoding="utf-8"))
    except: return default

def save_json(path, data):
    Path(path).write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def load_history():        return load_json(HISTORY_FILE, [])
def load_custom_headers(): return load_json(HEADERS_FILE, {})
def load_queue():          return load_json(QUEUE_FILE, [])

def fmt_size(x):
    """Accepte un Path, un int, ou None."""
    try:
        if isinstance(x, Path):
            b = x.stat().st_size if x.exists() else 0
        elif x is None:
            return "?"
        else:
            b = int(x)
    except:
        return "?"
    if b <= 0:    return "?"
    if b < 1024:  return f"{b} o"
    if b < 1<<20: return f"{b/1024:.1f} Ko"
    if b < 1<<30: return f"{b/(1<<20):.1f} Mo"
    return f"{b/(1<<30):.2f} Go"

def safe_filename(title, ext="mp4"):
    """Transforme un titre en nom de fichier sûr."""
    if not title:
        return f"video.{ext}"
    # Enlever les caractères interdits sur Windows/Linux
    safe = re.sub(r'[\\/:*?"<>|]', '_', title)
    safe = safe.strip(". ")[:120]   # max 120 chars
    return f"{safe}.{ext}" if safe else f"video.{ext}"

def add_to_history(url, title, method):
    entries = load_history()
    vid_id  = hashlib.md5(url.encode()).hexdigest()[:10]
    entries = [e for e in entries if e.get("url") != url]
    entries.insert(0, {
        "id": vid_id, "url": url, "title": title or url,
        "method": method, "ts": int(time.time()),
        "date": time.strftime("%d %b %Y %H:%M", time.localtime()),
    })
    save_json(HISTORY_FILE, entries[:50])
    return entries[0]

def build_headers(target_url, referer=None, extra=None):
    h = {
        "User-Agent": BROWSER_UA,
        "Accept": "video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
    }
    try:
        p = urllib.parse.urlparse(target_url)
        h["Referer"] = referer or f"{p.scheme}://{p.netloc}/"
        h["Origin"]  = f"{p.scheme}://{p.netloc}"
    except: pass
    saved = load_custom_headers()
    if saved: h.update(saved)
    if extra: h.update(extra)
    return h

def mime_from_url(url, fallback="video/mp4"):
    for ext, mime in MIME_MAP.items():
        if ext in url.lower().split("?")[0] and mime.startswith("video"):
            return mime
    return fallback

# ── API hakunaymatata ───────────────────────────────────
def api_hakunaymatata(page_url, custom_headers=None):
    parsed   = urllib.parse.urlparse(page_url)
    host     = parsed.netloc
    m        = re.search(r'/(?:watch|video|v|episode|e)/([a-zA-Z0-9_-]+)', parsed.path)
    vid_id   = m.group(1) if m else ([s for s in parsed.path.split('/') if s] or [""])[-1]
    print(f"  [HAKU] ID={vid_id}")

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
                print(f"  [HAKU] ✓ {len(dls)} stream(s)")
                return dls, caps, api_url
        except Exception as e:
            print(f"  [HAKU] {api_url[:60]} → {e}")
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

# ── yt-dlp helpers ──────────────────────────────────────
def ytdlp_resolve(url, custom_headers=None, referer=None):
    if not HAS_YTDLP: raise RuntimeError("yt-dlp non installé")
    with _cache_lock:
        c = _cache.get("r:"+url)
        if c and time.time() < c.get("expires",0): return c

    opts = {
        "quiet":True,"no_warnings":True,"extract_flat":False,"noplaylist":True,
        "format":"bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    }
    if referer:        opts["referer"]      = referer
    if custom_headers: opts["http_headers"] = custom_headers

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info: raise RuntimeError("yt-dlp: aucun résultat")

    result_url = info.get("url") or url
    if "formats" in info and info["formats"]:
        best = None
        for f in reversed(info["formats"]):
            if f.get("vcodec") != "none" and f.get("url"):
                if f.get("ext") == "mp4": best = f; break
        if not best:
            for f in reversed(info["formats"]):
                if f.get("url") and f.get("vcodec") != "none": best = f; break
        if best: result_url = best["url"]

    res = {
        "url": result_url, "title": info.get("title",""),
        "ext": info.get("ext","mp4"), "thumbnail": info.get("thumbnail",""),
        "duration": info.get("duration"),
        "headers": info.get("http_headers",{}),
        "expires": time.time() + CACHE_TTL,
    }
    with _cache_lock: _cache["r:"+url] = res
    print(f"  [YTDLP] ✓ → {result_url[:70]}")
    return res

def ytdlp_info(url, custom_headers=None):
    if not HAS_YTDLP: raise RuntimeError("yt-dlp non installé")
    opts = {
        "quiet":True,"no_warnings":True,"extract_flat":False,"noplaylist":True,
        "nocheckcertificate":True, "ignoreerrors":True, "no_color":True
    }
    if custom_headers: opts["http_headers"] = custom_headers

    # Ajout d'un User-Agent mobile pour TikTok/Instagram si nécessaire
    if "tiktok.com" in url or "instagram.com" in url:
        opts["user_agent"] = "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1"

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info: raise RuntimeError("yt-dlp: aucun résultat")

    formats = []
    for f in (info.get("formats") or []):
        vcodec = f.get("vcodec","none"); acodec = f.get("acodec","none")
        has_v  = vcodec and vcodec != "none"
        has_a  = acodec and acodec != "none"
        if has_v and has_a:   ftype = "video+audio"
        elif has_v:           ftype = "video"
        elif has_a:           ftype = "audio"
        else:                 continue
        formats.append({
            "id": f.get("format_id",""), "type": ftype, "ext": f.get("ext","?"),
            "resolution": f.get("resolution") or (f"{f.get('height',0)}p" if f.get("height") else "audio"),
            "fps": f.get("fps"), "vcodec": vcodec if has_v else None,
            "acodec": acodec if has_a else None,
            "filesize": f.get("filesize") or f.get("filesize_approx") or 0,
            "filesize_str": fmt_size(f.get("filesize") or f.get("filesize_approx") or 0),
            "tbr": f.get("tbr"), "abr": f.get("abr"), "note": f.get("format_note",""),
        })

    subs = []
    for lang, entries in {**info.get("subtitles",{}), **info.get("automatic_captions",{})}.items():
        for e in (entries or []):
            if e.get("url"):
                subs.append({"lang":lang,"name":e.get("name",lang),
                             "ext":e.get("ext","vtt"),"url":e.get("url",""),
                             "auto": lang in info.get("automatic_captions",{})}); break

    return {
        "title": info.get("title",""), "thumbnail": info.get("thumbnail",""),
        "duration": info.get("duration"), "uploader": info.get("uploader",""),
        "view_count": info.get("view_count"), "formats": formats, "subtitles": subs,
    }

def ytdlp_playlist(url, custom_headers=None):
    if not HAS_YTDLP: raise RuntimeError("yt-dlp non installé")
    opts = {
        "quiet":True,"no_warnings":True,
        "extract_flat":"in_playlist","noplaylist":False,"playlistend":200,
    }
    if custom_headers: opts["http_headers"] = custom_headers

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info: raise RuntimeError("yt-dlp: aucun résultat")

    entries = info.get("entries")
    if not entries:
        return {
            "is_playlist": False, "title": info.get("title",""),
            "count": 1, "items": [{
                "id": info.get("id",""),
                "title": info.get("title","Sans titre"),
                "url": info.get("webpage_url") or info.get("url") or url,
                "thumbnail": info.get("thumbnail",""), "duration": info.get("duration",0), "idx": 0,
            }],
        }

    items = []
    for i, e in enumerate(entries or []):
        if not e: continue
        vid_url = e.get("url") or e.get("webpage_url","")
        if not vid_url and e.get("id"):
            vid_url = f"https://www.youtube.com/watch?v={e['id']}"
        if not vid_url: continue
        items.append({
            "id": e.get("id",""), "title": e.get("title","Sans titre"),
            "url": vid_url,
            "thumbnail": e.get("thumbnail","") or (
                f"https://img.youtube.com/vi/{e['id']}/mqdefault.jpg" if e.get("id") else ""),
            "duration": e.get("duration",0), "idx": i,
        })

    return {
        "is_playlist": True,
        "title": info.get("title","") or info.get("playlist_title",""),
        "uploader": info.get("uploader","") or info.get("channel",""),
        "count": len(items), "items": items,
    }

def ytdlp_search(query, limit=20, custom_headers=None):
    if not HAS_YTDLP: raise RuntimeError("yt-dlp non installé")
    opts = {
        "quiet":True, "no_warnings":True, "extract_flat":True,
        "playlistend": limit, "noplaylist": True,
    }
    if custom_headers: opts["http_headers"] = custom_headers
    
    # Utiliser l'extracteur ytsearch
    search_query = f"ytsearch{limit}:{query}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(search_query, download=False)
    
    items = []
    for e in info.get("entries", []):
        if not e: continue
        items.append({
            "id": e.get("id"), "title": e.get("title"),
            "url": e.get("url") or f"https://www.youtube.com/watch?v={e.get('id')}",
            "thumbnail": e.get("thumbnail"),
            "duration": e.get("duration"),
            "uploader": e.get("uploader"),
            "view_count": e.get("view_count")
        })
    return items

def ytdlp_download(dl_id, url, format_id, output_ext, sub_lang=None,
                   custom_headers=None, video_title=None):
    """Effectue un téléchargement (appelé par le DownloadManager)."""
    with _dl_lock:
        if dl_id not in _downloads:
            _downloads[dl_id] = {
                "id": dl_id, "url": url, "status": "starting",
                "progress": 0, "speed": "", "eta": "", "size": "",
                "filename": "", "title": video_title or "", "error": "",
                "ts": int(time.time()),
            }
        else:
            _downloads[dl_id].update({"status": "starting", "error": ""})

    # Template de sortie — utilise le titre comme nom de fichier
    out_tpl = str(DL_DIR / f"{dl_id}.%(ext)s")

    def hook(d):
        with _dl_lock:
            dl = _downloads.get(dl_id, {})
            if d["status"] == "downloading":
                total   = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done    = d.get("downloaded_bytes", 0)
                pct     = int(done / total * 100) if total else 0
                t_info  = d.get("info_dict", {})
                dl.update({
                    "status": "downloading", "progress": pct,
                    "speed": d.get("_speed_str","").strip(),
                    "eta":   d.get("_eta_str","").strip(),
                    "size":  fmt_size(total),
                    "title": t_info.get("title","") or dl.get("title",""),
                })
            elif d["status"] == "finished":
                dl.update({"status": "processing", "progress": 99})

    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "outtmpl": out_tpl, "progress_hooks": [hook],
    }

    if format_id == "best":       opts["format"] = "bestvideo+bestaudio/best"
    elif format_id == "bestaudio": opts["format"] = "bestaudio/best"
    else:                          opts["format"] = format_id

    if output_ext in ("mp4","mkv","webm"):
        opts["merge_output_format"] = output_ext
    elif output_ext in ("mp3","m4a","opus"):
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": output_ext, "preferredquality": "192",
        }]

    if sub_lang:
        opts["writesubtitles"]    = True
        opts["subtitleslangs"]    = [sub_lang]
        opts["writeautomaticsub"] = True

    if custom_headers: opts["http_headers"] = custom_headers

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)

        title = (info.get("title","") if info else "") or video_title or ""

        # Trouver le fichier produit (stem = dl_id)
        filename = ""
        for fp in DL_DIR.iterdir():
            if fp.stem == dl_id:
                filename = fp.name
                break

        # Renommer avec le titre de la vidéo
        if filename and title:
            ext_part = Path(filename).suffix.lstrip(".")
            nice_name = safe_filename(title, ext_part)
            new_path  = DL_DIR / nice_name
            # Éviter les collisions
            if new_path.exists() and new_path != DL_DIR / filename:
                base, ext_ = nice_name.rsplit(".",1)
                nice_name  = f"{base}_{dl_id[:4]}.{ext_}"
                new_path   = DL_DIR / nice_name
            try:
                (DL_DIR / filename).rename(new_path)
                filename = nice_name
            except Exception as rename_err:
                print(f"  [DL] Rename impossible : {rename_err}")

        fsize = fmt_size(DL_DIR / filename) if filename else "?"
        with _dl_lock:
            _downloads[dl_id].update({
                "status": "done", "progress": 100,
                "filename": filename, "title": title, "size": fsize,
            })
        print(f"  [DL] ✓ {dl_id} → {filename}")

    except Exception as e:
        with _dl_lock:
            _downloads[dl_id].update({"status":"error","error":str(e)})
        print(f"  [DL] ✗ {dl_id} : {e}")
        raise e


# ── Collections helpers ─────────────────────────────────
def list_collections():
    cols = []
    for f in sorted(COLLECTIONS_DIR.glob("*.json")):
        try:
            d = load_json(f, {})
            cols.append({
                "id": f.stem, "name": d.get("name","Sans nom"),
                "color": d.get("color","#e5091a"), "icon": d.get("icon","🎬"),
                "count": len(d.get("items",[])), "created": d.get("created",0),
                "description": d.get("description",""),
            })
        except: pass
    return cols

def load_collection(col_id):
    f = COLLECTIONS_DIR / f"{col_id}.json"
    return load_json(f, None) if f.exists() else None

def save_collection(col_id, data):
    save_json(COLLECTIONS_DIR / f"{col_id}.json", data)


# ═══════════════════════════════════════════════════════
#  HTTP Handler — TOUTES les méthodes dans la classe
# ═══════════════════════════════════════════════════════
class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  [{time.strftime('%H:%M:%S')}] {fmt % args}")

    def do_OPTIONS(self):
        self.send_response(200); self.cors(); self.end_headers()

    # ── Routing ──────────────────────────────────────
    def do_GET(self):
        p  = urllib.parse.urlparse(self.path)
        pt = p.path
        qs = urllib.parse.parse_qs(p.query)

        routes = {
            "/api/resolve":          lambda: self._resolve(qs),
            "/api/proxy":            lambda: self._proxy(qs),
            "/api/probe":            lambda: self._probe(qs),
            "/api/history":          self._get_history,
            "/api/headers":          self._get_headers,
            "/api/intercept/latest": self._intercept_latest,
            "/api/downloads":        self._list_downloads,
            "/api/downloads/file":   lambda: self._serve_dl(qs),
            "/api/ytdl/progress":    lambda: self._ytdl_progress(qs),
            "/api/queue":            self._get_queue,
            "/api/playlist":         lambda: self._get_playlist(qs),
            "/api/video/info":       lambda: self._video_info(qs),
            "/api/collections":      lambda: self._get_collections(qs),
            "/api/search":           lambda: self._search(qs),
            "/api/transcode":        lambda: self._transcode(qs),
        }
        if pt in routes:             routes[pt]()
        elif pt == "/":              self._static(TEMPLATES_DIR/"index.html")
        elif pt.startswith("/static/"): self._static(STATIC_DIR/pt[8:])
        else:                        self.json(404, {"error":"Route inconnue"})

    def do_POST(self):
        pt = urllib.parse.urlparse(self.path).path
        routes = {
            "/api/intercept":              self._intercept,
            "/api/history":               self._post_history,
            "/api/history/delete":         self._del_history,
            "/api/headers":               self._save_headers,
            "/api/headers/clear":         self._clear_headers,
            "/api/ytdl/info":             self._ytdl_info,
            "/api/ytdl/download":         self._ytdl_download,
            "/api/ytdl/download/batch":   self._ytdl_batch,
            "/api/ytdl/cancel":           self._ytdl_cancel,
            "/api/ytdl/retry":            self._ytdl_retry,
            "/api/queue":                 self._post_queue,
            "/api/collections":           self._post_collections,
        }
        if pt in routes: routes[pt]()
        else:            self.json(404, {"error":"Route inconnue"})

    # ── /api/resolve ─────────────────────────────────
    def _resolve(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        url     = urllib.parse.unquote(url_list[0])
        referer = urllib.parse.unquote(qs.get("referer",[""])[0]) or None
        print(f"\n  [RESOLVE] {url[:80]}")
        ch = load_custom_headers(); steps = []

        # 1. API hakunaymatata
        if "hakunaymatata.com" in url:
            steps.append("hakunaymatata-api")
            try:
                dls, caps, _ = api_hakunaymatata(url, ch or None)
                streams = [{**d,"proxy_url":"/api/proxy?url="+urllib.parse.quote(d["url"],safe="")}
                           for d in dls]
                self.json(200,{"ok":True,"method":"hakunaymatata-api",
                    "streams":streams,"captions":caps,
                    "stream_url":streams[0]["url"],"proxy_url":streams[0]["proxy_url"],
                    "steps":steps}); return
            except Exception as e:
                steps.append(f"haku-FAIL:{e}")

        # 2. yt-dlp
        if HAS_YTDLP:
            steps.append("yt-dlp")
            try:
                res = ytdlp_resolve(url, ch or None, referer)
                su  = res["url"]
                pu  = "/api/proxy?url="+urllib.parse.quote(su,safe="")
                self.json(200,{"ok":True,"method":"yt-dlp",
                    "streams":[{"url":su,"proxy_url":pu,"resolution":0,
                                "format":res.get("ext","mp4").upper(),"size":0}],
                    "stream_url":su,"proxy_url":pu,
                    "title":res.get("title",""),"thumbnail":res.get("thumbnail",""),
                    "steps":steps}); return
            except Exception as e:
                steps.append(f"ytdlp-FAIL:{e}")

        # 3. Fallback
        steps.append("direct-fallback")
        pu = "/api/proxy?url="+urllib.parse.quote(url,safe="")
        self.json(200,{"ok":False,"method":"direct-fallback",
            "streams":[{"url":url,"proxy_url":pu,"resolution":0,"format":"MP4","size":0}],
            "stream_url":url,"proxy_url":pu,"steps":steps,
            "error":"Extraction échouée — tentative proxy direct"})

    # ── /api/proxy ───────────────────────────────────
    def _proxy(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        target  = urllib.parse.unquote(url_list[0])
        referer = urllib.parse.unquote(qs.get("referer",[""])[0]) or None
        print(f"  [PROXY] → {target[:80]}")

        headers = build_headers(target, referer)
        if "Range" in self.headers:
            headers["Range"] = self.headers["Range"]

        try:
            with urllib.request.urlopen(
                urllib.request.Request(target, headers=headers), timeout=30
            ) as resp:
                ct = mime_from_url(target, resp.headers.get("Content-Type","video/mp4"))
                cl = resp.headers.get("Content-Length","")
                cr = resp.headers.get("Content-Range","")
                ar = resp.headers.get("Accept-Ranges","bytes")
                st = resp.status

                self.send_response(st if st in (200,206) else 200)
                self.cors()
                self.send_header("Content-Type", ct)
                self.send_header("Accept-Ranges", ar)
                self.send_header("Cache-Control", "no-cache")
                if cl: self.send_header("Content-Length", cl)
                if cr: self.send_header("Content-Range", cr)
                self.end_headers()

                sent = 0
                while True:
                    chunk = resp.read(CHUNK_SIZE)
                    if not chunk: break
                    try:    self.wfile.write(chunk); sent += len(chunk)
                    except: break
                print(f"  [PROXY] ✓ {sent:,}b")

        except urllib.error.HTTPError as e:
            self.json(e.code, {"error":f"HTTP {e.code} {e.reason}"})
        except Exception as e:
            self.json(502, {"error":str(e)})

    # ── /api/probe ───────────────────────────────────
    def _probe(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        target = urllib.parse.unquote(url_list[0])
        h = build_headers(target)
        try:
            with urllib.request.urlopen(
                urllib.request.Request(target,headers=h,method="HEAD"),timeout=10
            ) as r:
                self.json(200,{"ok":True,"status":r.status,
                    "content_type":r.headers.get("Content-Type",""),
                    "content_length":int(r.headers.get("Content-Length",0) or 0),
                    "seekable":r.headers.get("Accept-Ranges")=="bytes",
                    "cors":r.headers.get("Access-Control-Allow-Origin","absent")})
        except urllib.error.HTTPError as e:
            self.json(200,{"ok":False,"status":e.code,"error":e.reason})
        except Exception as e:
            self.json(200,{"ok":False,"status":0,"error":str(e)})

    # ── /api/playlist ────────────────────────────────
    def _get_playlist(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        url = urllib.parse.unquote(url_list[0])
        print(f"  [PLAYLIST] {url[:80]}")
        if not HAS_YTDLP:
            self.json(200,{"ok":False,"error":"yt-dlp non installé"}); return
        try:
            ch = load_custom_headers()
            self.json(200,{"ok":True,**ytdlp_playlist(url, ch or None)})
        except Exception as e:
            print(f"  [PLAYLIST] {e}")
            self.json(200,{"ok":False,"error":str(e)})

    # ── /api/ytdl/info ───────────────────────────────
    def _ytdl_info(self):
        b = self.body()
        if b is None: return
        url = b.get("url","")
        if not url: self.json(400,{"error":"url manquant"}); return
        print(f"  [YTDL-INFO] {url[:80]}")
        try:
            ch = load_custom_headers()
            self.json(200,{"ok":True,**ytdlp_info(url, ch or None)})
        except Exception as e:
            self.json(200,{"ok":False,"error":str(e)})

    # ── /api/ytdl/download ───────────────────────────
    def _ytdl_download(self):
        b = self.body()
        if b is None: return
        url       = b.get("url","")
        format_id = b.get("format_id","best")
        ext       = b.get("ext","mp4")
        sub_lang  = b.get("sub_lang")
        title     = b.get("title","")
        if not url: self.json(400,{"error":"url manquant"}); return
        dl_id = str(uuid.uuid4())[:8]
        ch    = load_custom_headers()
        dl_manager.add(dl_id, ytdlp_download, url, format_id, ext, sub_lang, ch or None, title)
        print(f"  [QUEUE] Ajouté {dl_id} fmt={format_id}")
        self.json(200,{"ok":True,"id":dl_id})

    # ── /api/ytdl/download/batch ─────────────────────
    def _ytdl_batch(self):
        b = self.body()
        if b is None: return
        urls      = b.get("urls",[])
        format_id = b.get("format_id","best")
        ext       = b.get("ext","mp4")
        sub_lang  = b.get("sub_lang")
        if not urls: self.json(400,{"error":"urls manquant"}); return
        ids = []
        ch  = load_custom_headers()
        for url in urls[:50]:
            dl_id = str(uuid.uuid4())[:8]
            dl_manager.add(dl_id, ytdlp_download, url, format_id, ext, sub_lang, ch or None)
            ids.append(dl_id)
        print(f"  [BATCH] {len(ids)} DLs en queue")
        self.json(200,{"ok":True,"ids":ids,"count":len(ids)})

    # ── /api/ytdl/retry ──────────────────────────────
    def _ytdl_retry(self):
        b = self.body()
        if b is None: return
        dl_id = b.get("id","")
        with _dl_lock:
            dl = _downloads.get(dl_id)
        if not dl: self.json(404, {"error": "Inconnu"}); return
        
        ch = load_custom_headers()
        # On suppose que les paramètres sont stockés ou on les récupère du dict dl
        dl_manager.add(dl_id, ytdlp_download, dl["url"], "best", "mp4", None, ch or None, dl.get("title"))
        self.json(200, {"ok": True})

    # ── /api/search ──────────────────────────────────
    def _search(self, qs):
        q = qs.get("q", [""])[0]
        if not q: self.json(400, {"error": "Recherche vide"}); return
        print(f"  [SEARCH] {q}")
        try:
            ch = load_custom_headers()
            results = ytdlp_search(q, 20, ch or None)
            self.json(200, {"ok": True, "results": results})
        except Exception as e:
            self.json(200, {"ok": False, "error": str(e)})

    # ── /api/ytdl/progress ───────────────────────────
    def _ytdl_progress(self, qs):
        dl_id = qs.get("id",[""])[0]
        with _dl_lock:
            dl = _downloads.get(dl_id)
        if not dl: self.json(404,{"error":"id inconnu"}); return
        self.json(200, dl)

    # ── /api/ytdl/cancel ────────────────────────────
    def _ytdl_cancel(self):
        b = self.body()
        if b is None: return
        with _dl_lock:
            dl = _downloads.get(b.get("id",""))
            if dl: dl["status"] = "cancelled"
        self.json(200,{"ok":True})

    # ── /api/downloads ───────────────────────────────
    def _list_downloads(self):
        with _dl_lock:
            dls = list(_downloads.values())
        files = []
        for f in DL_DIR.iterdir():
            if f.is_file():
                files.append({
                    "filename": f.name,
                    "size":     fmt_size(f),
                    "bytes":    f.stat().st_size,
                    "ts":       int(f.stat().st_mtime),
                })
        self.json(200,{"downloads":dls,"files":files})

    # ── /api/downloads/file ──────────────────────────
    def _serve_dl(self, qs):
        fname = qs.get("f",[""])[0]
        if not fname or ".." in fname or "/" in fname or "\\" in fname:
            self.json(400,{"error":"filename invalide"}); return
        path = DL_DIR / fname
        if not path.exists():
            self.json(404,{"error":"Fichier introuvable"}); return

        size = path.stat().st_size
        ct   = MIME_MAP.get(path.suffix.lower(),"application/octet-stream")
        range_hdr = self.headers.get("Range","")

        if range_hdr:
            m = re.match(r'bytes=(\d*)-(\d*)', range_hdr)
            if m:
                start  = int(m.group(1) or 0)
                end    = int(m.group(2)) if m.group(2) else size-1
                length = end - start + 1
                self.send_response(206); self.cors()
                self.send_header("Content-Type", ct)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(path,"rb") as f:
                    f.seek(start); rem = length
                    while rem:
                        chunk = f.read(min(CHUNK_SIZE,rem))
                        if not chunk: break
                        self.wfile.write(chunk); rem -= len(chunk)
                return

        self.send_response(200); self.cors()
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        # Nom de fichier propre pour le téléchargement
        safe_fn = fname.encode("ascii","replace").decode()
        self.send_header("Content-Disposition", f'attachment; filename="{safe_fn}"')
        self.end_headers()
        with open(path,"rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk: break
                self.wfile.write(chunk)

    # ── /api/queue ───────────────────────────────────
    def _get_queue(self):
        self.json(200, load_queue())

    def _post_queue(self):
        b = self.body()
        if b is None: return
        action = b.get("action","")
        queue  = load_queue()

        if action == "add":
            item = b.get("item",{})
            if not item.get("url"): self.json(400,{"error":"url manquant"}); return
            item["id"]    = hashlib.md5(item["url"].encode()).hexdigest()[:8]
            item["added"] = int(time.time())
            item["played"]= False
            queue.append(item)
        elif action == "remove":
            queue = [q for q in queue if q.get("id") != b.get("id")]
        elif action == "clear":
            queue = []
        elif action == "played":
            for q in queue:
                if q.get("id") == b.get("id"): q["played"] = True; break
        elif action == "reorder":
            order = {id_:i for i,id_ in enumerate(b.get("ids",[]))}
            queue.sort(key=lambda q: order.get(q.get("id",""),999))

        save_json(QUEUE_FILE, queue)
        self.json(200,{"ok":True,"queue":queue})

    # ── /api/video/info — formats+subs for current video ──
    def _video_info(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        url = urllib.parse.unquote(url_list[0])
        if not HAS_YTDLP:
            self.json(200,{"ok":False,"error":"yt-dlp non installé"}); return
        try:
            ch = load_custom_headers()
            self.json(200,{"ok":True,**ytdlp_info(url, ch or None)})
        except Exception as e:
            self.json(200,{"ok":False,"error":str(e)})

    # ── /api/collections ─────────────────────────────
    def _get_collections(self, qs):
        col_id = qs.get("id",[""])[0]
        if col_id:
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Collection introuvable"}); return
            self.json(200, col)
        else:
            self.json(200, list_collections())

    def _post_collections(self):
        b = self.body()
        if b is None: return
        action = b.get("action","")

        if action == "create":
            col_id = str(uuid.uuid4())[:8]
            data = {
                "id": col_id, "name": b.get("name","Nouvelle collection"),
                "color": b.get("color","#e5091a"), "icon": b.get("icon","🎬"),
                "description": b.get("description",""),
                "created": int(time.time()), "items": [],
            }
            save_collection(col_id, data)
            self.json(200,{"ok":True,"id":col_id,"collection":data})

        elif action == "update":
            col_id = b.get("id","")
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Introuvable"}); return
            for k in ("name","color","icon","description"):
                if k in b: col[k] = b[k]
            save_collection(col_id, col)
            self.json(200,{"ok":True,"collection":col})

        elif action == "delete":
            col_id = b.get("id","")
            f = COLLECTIONS_DIR / f"{col_id}.json"
            if f.exists(): f.unlink()
            self.json(200,{"ok":True})

        elif action == "add_item":
            col_id = b.get("col_id","")
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Introuvable"}); return
            item = b.get("item",{})
            if not item.get("url"): self.json(400,{"error":"url manquant"}); return
            item["id"]    = hashlib.md5(item["url"].encode()).hexdigest()[:10]
            item["added"] = int(time.time())
            col["items"]  = [i for i in col["items"] if i.get("id") != item["id"]]
            col["items"].append(item)
            save_collection(col_id, col)
            self.json(200,{"ok":True,"collection":col})

        elif action == "add_items":
            col_id    = b.get("col_id","")
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Introuvable"}); return
            new_items = b.get("items",[])
            existing  = {i.get("id") for i in col["items"]}
            added = 0
            for item in new_items:
                if not item.get("url"): continue
                item["id"]    = hashlib.md5(item["url"].encode()).hexdigest()[:10]
                item["added"] = int(time.time())
                if item["id"] not in existing:
                    col["items"].append(item); existing.add(item["id"]); added += 1
            save_collection(col_id, col)
            self.json(200,{"ok":True,"added":added,"collection":col})

        elif action == "remove_item":
            col_id  = b.get("col_id","")
            item_id = b.get("item_id","")
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Introuvable"}); return
            col["items"] = [i for i in col["items"] if i.get("id") != item_id]
            save_collection(col_id, col)
            self.json(200,{"ok":True,"collection":col})

        elif action == "reorder_items":
            col_id = b.get("col_id","")
            col = load_collection(col_id)
            if not col: self.json(404,{"error":"Introuvable"}); return
            order = {id_:i for i,id_ in enumerate(b.get("ids",[]))}
            col["items"].sort(key=lambda x: order.get(x.get("id",""),999))
            save_collection(col_id, col)
            self.json(200,{"ok":True,"collection":col})

        else:
            self.json(400,{"error":f"Action inconnue: {action}"})

    # ── /api/intercept ───────────────────────────────
    def _intercept(self):
        b = self.body()
        if b is None: return
        url     = b.get("url","")
        headers = b.get("headers",{})
        referer = b.get("referer","")
        if not url: self.json(400,{"error":"url manquant"}); return
        print(f"  [INTERCEPT] ← {url[:80]}")
        if headers:
            useful   = ["Cookie","cookie","Authorization","authorization",
                        "Referer","referer","Origin","x-token","x-auth","x-session"]
            existing = load_custom_headers()
            merged   = {**existing}
            for k,v in headers.items():
                if any(u.lower()==k.lower() for u in useful): merged[k] = v
            if referer and "Referer" not in merged: merged["Referer"] = referer
            HEADERS_FILE.write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        (DATA_DIR/"intercepted.json").write_text(
            json.dumps({"url":url,"referer":referer,"ts":int(time.time())},
                       ensure_ascii=False), encoding="utf-8")
        self.json(200,{"ok":True,"url":url})

    def _intercept_latest(self):
        f = DATA_DIR/"intercepted.json"
        if not f.exists(): self.json(200,{"url":None}); return
        try:
            data = json.loads(f.read_text(encoding="utf-8")); f.unlink()
            self.json(200, data)
        except: self.json(200,{"url":None})

    # ── History ───────────────────────────────────────
    def _get_history(self):   self.json(200, load_history())
    def _post_history(self):
        b = self.body()
        if b is None: return
        self.json(200, add_to_history(b.get("url",""),b.get("title",""),b.get("method","?")))
    def _del_history(self):
        b = self.body()
        if b is None: return
        save_json(HISTORY_FILE, [e for e in load_history() if e.get("id") != b.get("id")])
        self.json(200,{"ok":True})

    # ── Headers ───────────────────────────────────────
    def _get_headers(self):    self.json(200, load_custom_headers())
    def _save_headers(self):
        b = self.body()
        if b is None: return
        if not isinstance(b,dict): self.json(400,{"error":"dict attendu"}); return
        HEADERS_FILE.write_text(json.dumps(b,ensure_ascii=False,indent=2),encoding="utf-8")
        self.json(200,{"ok":True,"count":len(b)})
    def _clear_headers(self):
        HEADERS_FILE.write_text("{}",encoding="utf-8"); self.json(200,{"ok":True})

    # ── /api/transcode ───────────────────────────────
    def _transcode(self, qs):
        url_list = qs.get("url",[])
        if not url_list: self.json(400,{"error":"url manquant"}); return
        target = urllib.parse.unquote(url_list[0])
        print(f"  [TRANSCODE] → {target[:80]}")

        if not HAS_FFMPEG:
            self.send_response(500); self.cors()
            self.end_headers()
            self.wfile.write(b"ffmpeg non disponible")
            return

        # Headers pour le streaming MP4 fragmenté
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        # Commande ffmpeg pour sortir du MP4 fragmenté sur stdout
        cmd = [
            "ffmpeg", "-re", "-i", target,
            "-f", "mp4",
            "-vcodec", "libx264", "-preset", "ultrafast",
            "-acodec", "aac", "-b:a", "128k",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "pipe:1"
        ]

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            while True:
                chunk = proc.stdout.read(CHUNK_SIZE)
                if not chunk: break
                try:    self.wfile.write(chunk)
                except: break
            proc.kill()
        except Exception as e:
            print(f"  [TRANSCODE] Erreur: {e}")

    # ── Static files ──────────────────────────────────
    def _static(self, path: Path):
        if not path.exists():
            self.json(404,{"error":f"Introuvable: {path.name}"}); return
        data = path.read_bytes()
        ct   = MIME_MAP.get(path.suffix.lower(),"application/octet-stream")
        self.send_response(200); self.cors()
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    # ── CORS + JSON helpers ───────────────────────────
    def cors(self):
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers",
                         "Content-Length, Content-Range, Content-Type, Accept-Ranges")

    def json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self.cors()
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length",0))
        if not n: self.json(400,{"error":"Corps vide"}); return None
        try:    return json.loads(self.rfile.read(n))
        except: self.json(400,{"error":"JSON invalide"}); return None


# ── Entry point ─────────────────────────────────────────
if __name__ == "__main__":
    server = HTTPServer((HOST,PORT), Handler)
    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║       StreamVault  v5  —  Serveur            ║")
    print(f"  ║  yt-dlp  : {'✓ '+yt_dlp.version.__version__ if HAS_YTDLP else '✗ pip install yt-dlp'}{'':>24}║")
    print("  ║  Routes  : resolve·proxy·playlist·collections║")
    print("  ╚══════════════════════════════════════════════╝")
    print(f"\n  ▶  http://localhost:{PORT}\n\n  Arrêter : Ctrl+C\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Arrêté."); server.server_close()
