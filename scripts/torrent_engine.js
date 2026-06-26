/**
 * VaultStream — Moteur WebTorrent
 * Gère l'ajout, le suivi et le streaming de torrents via magnets.
 * Endpoints:
 *   POST /add?magnet=...         Ajoute un torrent
 *   GET  /status?magnet=...      Progression + liste des fichiers
 *   GET  /stream?magnet=...&index=N  Stream d'un fichier vidéo (range support)
 *   GET  /files?magnet=...       Liste les fichiers disponibles
 *   DELETE /remove?magnet=...    Retire un torrent
 *   GET  /list                   Liste tous les torrents actifs
 */

const WebTorrent = require('webtorrent');
const http = require('http');
const path = require('path');
const fs = require('fs');

const client = new WebTorrent();
const torrents = {}; // magnet → torrent instance
const DL_DIR = path.join(__dirname, '..', 'data', 'downloads');

if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

function isVideo(name) {
  return /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts|wmv)$/i.test(name);
}

function torrentInfo(torrent) {
  return {
    ok: true,
    infoHash: torrent.infoHash,
    name: torrent.name,
    progress: Math.round(torrent.progress * 1000) / 10, // 0.0–100.0
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    ready: torrent.ready,
    done: torrent.done,
    timeRemaining: torrent.timeRemaining,
    downloaded: torrent.downloaded,
    length: torrent.length,
    files: (torrent.files || []).map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      progress: Math.round(f.progress * 1000) / 10,
      isVideo: isVideo(f.name),
      path: f.path,
    })),
  };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, `http://localhost:5001`);
  const magnet = url.searchParams.get('magnet') || '';

  // ── POST /add ─────────────────────────────────────────
  if (url.pathname === '/add') {
    if (!magnet) {
      res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'magnet manquant' }));
    }
    // Déjà en cours ?
    if (torrents[magnet]) {
      res.writeHead(200); return res.end(JSON.stringify(torrentInfo(torrents[magnet])));
    }
    try {
      client.add(magnet, { path: DL_DIR }, (torrent) => {
        torrents[magnet] = torrent;
        console.log(`[torrent] Ajouté: ${torrent.name} (${torrent.infoHash})`);
        torrent.on('done', () => console.log(`[torrent] Terminé: ${torrent.name}`));
        torrent.on('error', (err) => console.error(`[torrent] Erreur: ${err.message}`));
        res.writeHead(200); res.end(JSON.stringify(torrentInfo(torrent)));
      });
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── GET /status ───────────────────────────────────────
  if (url.pathname === '/status') {
    if (!magnet) {
      res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'magnet manquant' }));
    }
    const torrent = torrents[magnet] || client.get(magnet);
    if (!torrent) {
      res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Torrent non trouvé — appelle /add d\'abord' }));
    }
    res.writeHead(200); return res.end(JSON.stringify(torrentInfo(torrent)));
  }

  // ── GET /files ────────────────────────────────────────
  if (url.pathname === '/files') {
    const torrent = torrents[magnet] || client.get(magnet);
    if (!torrent) {
      res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Non trouvé' }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true,
      name: torrent.name,
      files: (torrent.files || []).map((f, i) => ({
        index: i, name: f.name, length: f.length, isVideo: isVideo(f.name),
      }))
    }));
  }

  // ── GET /list ─────────────────────────────────────────
  if (url.pathname === '/list') {
    const list = Object.values(torrents).map(t => ({
      infoHash: t.infoHash, name: t.name,
      progress: Math.round(t.progress * 1000) / 10,
      done: t.done, numPeers: t.numPeers,
    }));
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, torrents: list }));
  }

  // ── DELETE /remove ────────────────────────────────────
  if (url.pathname === '/remove') {
    const torrent = torrents[magnet];
    if (!torrent) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Non trouvé' })); }
    torrent.destroy(() => {
      delete torrents[magnet];
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── GET /stream ───────────────────────────────────────
  if (url.pathname === '/stream') {
    res.setHeader('Content-Type', 'video/mp4'); // override JSON default
    const fileIndex = parseInt(url.searchParams.get('index') || '0');
    const torrent = torrents[magnet] || client.get(magnet);
    if (!torrent) {
      res.writeHead(404); return res.end('Torrent non trouvé');
    }
    const videoFiles = torrent.files.filter(f => isVideo(f.name));
    const file = videoFiles[fileIndex] || torrent.files[0];
    if (!file) { res.writeHead(404); return res.end('Aucun fichier vidéo'); }

    const total = file.length;
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkLen,
        'Content-Type': 'video/mp4',
      });
      file.createReadStream({ start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
      });
      file.createReadStream().pipe(res);
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Route inconnue' }));
});

server.listen(5001, '127.0.0.1', () => {
  console.log('[torrent-engine] En écoute sur http://127.0.0.1:5001');
});

process.on('uncaughtException', (e) => console.error('[torrent-engine] uncaught:', e.message));
