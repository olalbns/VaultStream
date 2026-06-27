/**
 * VaultStream — Moteur Torrent (torrent-stream, CommonJS)
 * Compatible Node 18-22 sans binaires natifs.
 *
 * Endpoints:
 *   POST /add?magnet=...          Ajoute et démarre un torrent
 *   GET  /status?magnet=...       Progression + liste des fichiers
 *   GET  /files?magnet=...        Liste les fichiers uniquement
 *   GET  /stream?magnet=...&index=N  Stream range-aware d'un fichier vidéo
 *   DELETE /remove?magnet=...     Arrête et retire un torrent
 *   GET  /list                    Liste tous les torrents actifs
 */

'use strict';

const createTorrent = require('torrent-stream');
const http          = require('http');
const path          = require('path');
const fs            = require('fs');

const DL_DIR = path.resolve(__dirname, '..', 'data', 'downloads');
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

// magnet → { engine, files, progress, speed, peers, done, name, started }
const torrents = {};

function isVideo(name) {
  return /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts|wmv)$/i.test(name);
}

function humanSpeed(bps) {
  if (bps < 1024) return bps + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

function torrentInfo(key) {
  const t = torrents[key];
  if (!t) return null;
  const files = (t.files || []).map((f, i) => ({
    index:    i,
    name:     f.name,
    length:   f.length,
    progress: t.done ? 100 : Math.round((f.downloaded || 0) / (f.length || 1) * 1000) / 10,
    isVideo:  isVideo(f.name),
    path:     f.path,
  }));
  return {
    ok:        true,
    name:      t.name || key.slice(0, 40),
    progress:  t.progress || 0,
    downloadSpeed: t.speed || 0,
    speedHuman:    humanSpeed(t.speed || 0),
    numPeers:  t.peers || 0,
    ready:     !!t.ready,
    done:      !!t.done,
    downloaded: t.downloaded || 0,
    length:    t.length || 0,
    files,
  };
}

function addTorrent(magnet, onReady, onError) {
  if (torrents[magnet]) { onReady(torrents[magnet]); return; }

  torrents[magnet] = {
    name: null, files: [], progress: 0, speed: 0, peers: 0,
    ready: false, done: false, engine: null,
    downloaded: 0, length: 0, started: Date.now(),
  };

  const engine = createTorrent(magnet, {
    path: DL_DIR,
    trackers: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.tracker.cl:1337/announce',
      'udp://9.rarbg.com:2810/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'wss://tracker.btorrent.xyz',
      'wss://tracker.openwebtorrent.com',
    ],
  });

  torrents[magnet].engine = engine;

  engine.on('ready', () => {
    const t = torrents[magnet];
    if (!t) { engine.destroy(); return; }
    t.name   = engine.torrent.name || null;
    t.length = engine.torrent.length || 0;
    t.files  = engine.files;
    t.ready  = true;

    // Sélectionner uniquement les fichiers vidéo pour téléchargement prioritaire
    engine.files.forEach(f => {
      if (isVideo(f.name)) f.select();
      else f.deselect();
    });
    // Si aucun fichier vidéo, tout sélectionner
    if (!engine.files.some(f => isVideo(f.name))) {
      engine.files.forEach(f => f.select());
    }

    console.log(`[torrent] Prêt: ${t.name} (${engine.files.length} fichier(s))`);
    onReady(t);
  });

  engine.on('download', () => {
    const t = torrents[magnet];
    if (!t) return;
    const total = engine.torrent.length || 1;
    const dl    = engine.files.reduce((s, f) => s + (f.downloaded || 0), 0);
    t.downloaded = dl;
    t.progress   = Math.round(dl / total * 1000) / 10;
  });

  engine.on('upload', () => {});

  // Poll vitesse/pairs toutes les secondes
  const statsTimer = setInterval(() => {
    const t = torrents[magnet];
    if (!t || !t.engine) { clearInterval(statsTimer); return; }
    const swarm = engine.swarm;
    if (swarm) {
      t.speed = swarm.downloadSpeed();
      t.peers = swarm.wires ? swarm.wires.length : 0;
    }
    // Vérifier si terminé
    const total = engine.torrent ? engine.torrent.length : 0;
    if (total > 0 && t.downloaded >= total) {
      t.done = true;
      t.progress = 100;
      clearInterval(statsTimer);
      console.log(`[torrent] Terminé: ${t.name}`);
    }
  }, 1000);

  engine.on('error', (err) => {
    console.error(`[torrent] Erreur: ${err.message}`);
    if (torrents[magnet]) torrents[magnet].error = err.message;
    onError(err);
  });
}

// ── Serveur HTTP ──────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const u      = new URL(req.url, 'http://localhost:5001');
  const magnet = u.searchParams.get('magnet') || '';

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── POST /add ──────────────────────────────────────
  if (u.pathname === '/add') {
    if (!magnet) return json(400, { ok: false, error: 'magnet manquant' });
    if (torrents[magnet] && torrents[magnet].ready) {
      return json(200, torrentInfo(magnet));
    }
    addTorrent(magnet,
      ()  => json(200, torrentInfo(magnet)),
      (e) => json(500, { ok: false, error: e.message })
    );
    // Si le torrent n'est pas encore prêt, répondre immédiatement avec l'état pending
    if (!torrents[magnet] || !torrents[magnet].ready) {
      // La réponse est envoyée dans les callbacks ci-dessus
    }
    return;
  }

  // ── GET /status ────────────────────────────────────
  if (u.pathname === '/status') {
    if (!magnet) return json(400, { ok: false, error: 'magnet manquant' });
    const info = torrentInfo(magnet);
    if (!info) return json(404, { ok: false, error: 'Torrent non trouvé — appelle /add d\'abord' });
    return json(200, info);
  }

  // ── GET /files ─────────────────────────────────────
  if (u.pathname === '/files') {
    const info = torrentInfo(magnet);
    if (!info) return json(404, { ok: false, error: 'Non trouvé' });
    return json(200, { ok: true, name: info.name, files: info.files });
  }

  // ── GET /list ──────────────────────────────────────
  if (u.pathname === '/list') {
    const list = Object.keys(torrents).map(k => {
      const t = torrents[k];
      return { name: t.name, progress: t.progress, done: t.done, peers: t.peers, ready: t.ready };
    });
    return json(200, { ok: true, torrents: list });
  }

  // ── DELETE /remove ─────────────────────────────────
  if (u.pathname === '/remove') {
    const t = torrents[magnet];
    if (!t) return json(404, { ok: false, error: 'Non trouvé' });
    if (t.engine) t.engine.destroy(() => {});
    delete torrents[magnet];
    return json(200, { ok: true });
  }

  // ── GET /stream ────────────────────────────────────
  if (u.pathname === '/stream') {
    const idx   = parseInt(u.searchParams.get('index') || '0', 10);
    const t     = torrents[magnet];
    if (!t || !t.ready) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Torrent pas encore prêt — réessaie dans quelques secondes');
    }
    const videos = t.files.filter(f => isVideo(f.name));
    const file   = videos[idx] || t.files[0];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Aucun fichier vidéo trouvé');
    }

    const total = file.length;
    const range = req.headers.range;
    if (range) {
      const [s, e]  = range.replace(/bytes=/, '').split('-');
      const start   = parseInt(s, 10);
      const end     = e ? parseInt(e, 10) : total - 1;
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
  console.error('[torrent-engine] Exception non catchée:', e.message);
});
