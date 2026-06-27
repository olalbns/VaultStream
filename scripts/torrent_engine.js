/**
 * VaultStream — Moteur Torrent (torrent-stream 1.2.1, CommonJS)
 * API correcte pour torrent-stream v1.2.1 :
 *   - progression : engine.bitfield (bits à 1 / total pièces)
 *   - downloaded  : engine.swarm.downloaded (bytes)
 *   - vitesse     : engine.swarm.downloadSpeed()
 *   - pairs       : engine.swarm.wires.length
 *   - taille      : engine.torrent.length
 */

'use strict';

const createTorrent = require('torrent-stream');
const http          = require('http');
const path          = require('path');
const fs            = require('fs');

const DL_DIR = path.resolve(__dirname, '..', 'data', 'downloads');
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

// magnet → { engine, torrent, files, error, started }
const active = {};

function isVideo(name) {
  return /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts|wmv)$/i.test(name);
}

function calcProgress(engine) {
  if (!engine || !engine.bitfield || !engine.torrent) return 0;
  const total = engine.torrent.pieces.length;
  if (!total) return 0;
  let done = 0;
  for (let i = 0; i < total; i++) {
    if (engine.bitfield.get(i)) done++;
  }
  return Math.round(done / total * 1000) / 10; // 0.0–100.0
}

function getInfo(key) {
  const t = active[key];
  if (!t) return null;
  const eng    = t.engine;
  const swarm  = eng && eng.swarm;
  const tor    = eng && eng.torrent;

  const progress  = calcProgress(eng);
  const speed     = swarm ? swarm.downloadSpeed() : 0;
  const peers     = swarm && swarm.wires ? swarm.wires.length : 0;
  const downloaded = swarm ? swarm.downloaded : 0;
  const length    = tor ? tor.length : 0;
  const done      = length > 0 && downloaded >= length;

  const files = (eng && eng.files ? eng.files : []).map((f, i) => ({
    index:   i,
    name:    f.name,
    length:  f.length,
    isVideo: isVideo(f.name),
  }));

  return {
    ok:           true,
    name:         tor ? tor.name : null,
    progress,
    downloadSpeed: speed,
    speedHuman:   speed < 1048576 ? (speed/1024).toFixed(1)+' KB/s' : (speed/1048576).toFixed(2)+' MB/s',
    numPeers:     peers,
    downloaded,
    length,
    done,
    ready:        !!t.ready,
    error:        t.error || null,
    files,
  };
}

function addMagnet(magnet, cb) {
  if (active[magnet]) return cb(null, active[magnet]);

  const entry = { engine: null, ready: false, error: null, started: Date.now() };
  active[magnet] = entry;

  const eng = createTorrent(magnet, {
    path: DL_DIR,
    trackers: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.tracker.cl:1337/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://9.rarbg.com:2810/announce',
    ],
  });
  entry.engine = eng;

  eng.on('ready', () => {
    entry.ready = true;
    const tor = eng.torrent;
    // Sélectionner les fichiers vidéo en priorité
    const videos = eng.files.filter(f => isVideo(f.name));
    if (videos.length) videos.forEach(f => f.select());
    else eng.files.forEach(f => f.select());

    console.log(`[torrent] Prêt: ${tor.name} (${eng.files.length} fichier(s), ${(tor.length/1048576).toFixed(1)} Mo)`);
    cb(null, entry);
  });

  eng.on('error', (err) => {
    console.error(`[torrent] Erreur: ${err.message}`);
    entry.error = err.message;
    cb(err);
  });
}

// ── Serveur HTTP ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const u      = new URL(req.url, 'http://127.0.0.1:5001');
  const magnet = decodeURIComponent(u.searchParams.get('magnet') || '');

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── POST /add ─────────────────────────────────────────
  if (u.pathname === '/add' && (req.method === 'POST' || req.method === 'GET')) {
    if (!magnet) return json(400, { ok: false, error: 'magnet manquant' });
    addMagnet(magnet, (err) => {
      if (err) return json(500, { ok: false, error: err.message });
      json(200, getInfo(magnet) || { ok: true });
    });
    // Répondre immédiatement si le torrent est déjà en cours
    if (active[magnet] && !active[magnet].ready) {
      // La réponse sera envoyée dans le callback
    }
    return;
  }

  // ── GET /status ───────────────────────────────────────
  if (u.pathname === '/status') {
    if (!magnet) return json(400, { ok: false, error: 'magnet manquant' });
    const info = getInfo(magnet);
    if (!info) return json(404, { ok: false, error: 'Torrent non trouvé — appelle /add d\'abord' });
    return json(200, info);
  }

  // ── GET /files ────────────────────────────────────────
  if (u.pathname === '/files') {
    const info = getInfo(magnet);
    if (!info) return json(404, { ok: false, error: 'Non trouvé' });
    return json(200, { ok: true, name: info.name, files: info.files });
  }

  // ── GET /list ─────────────────────────────────────────
  if (u.pathname === '/list') {
    const list = Object.keys(active).map(k => {
      const info = getInfo(k);
      return info ? {
        name: info.name, progress: info.progress,
        done: info.done, peers: info.numPeers, ready: info.ready,
      } : { name: null, progress: 0, done: false, peers: 0, ready: false };
    });
    return json(200, { ok: true, torrents: list });
  }

  // ── DELETE /remove ────────────────────────────────────
  if (u.pathname === '/remove') {
    const t = active[magnet];
    if (!t) return json(404, { ok: false, error: 'Non trouvé' });
    if (t.engine) t.engine.destroy(() => {});
    delete active[magnet];
    return json(200, { ok: true });
  }

  // ── GET /stream ───────────────────────────────────────
  if (u.pathname === '/stream') {
    const idx = parseInt(u.searchParams.get('index') || '0', 10);
    const t   = active[magnet];
    if (!t || !t.ready) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Torrent pas encore prêt');
    }
    const videos = t.engine.files.filter(f => isVideo(f.name));
    const file   = videos[idx] || t.engine.files[0];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Aucun fichier vidéo');
    }

    const total = file.length;
    const range = req.headers.range;
    if (range) {
      const [s, e]   = range.replace(/bytes=/, '').split('-');
      const start    = parseInt(s, 10);
      const end      = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkLen,
        'Content-Type':   'video/mp4',
      });
      file.createReadStream({ start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type':   'video/mp4',
        'Content-Length': total,
        'Accept-Ranges':  'bytes',
      });
      file.createReadStream().pipe(res);
    }
    return;
  }

  json(404, { ok: false, error: `Route inconnue: ${u.pathname}` });
});

server.listen(5001, '127.0.0.1', () => {
  console.log('[torrent-engine] En écoute sur http://127.0.0.1:5001');
});

process.on('uncaughtException', (e) => {
  console.error('[torrent-engine] Exception:', e.message);
});
