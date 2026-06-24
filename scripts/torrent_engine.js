const WebTorrent = require('webtorrent');
const http = require('http');
const client = new WebTorrent();

const torrents = {};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const magnet = url.searchParams.get('magnet');

    if (url.pathname === '/add') {
        if (!magnet) { res.writeHead(400); return res.end('Missing magnet'); }
        if (torrents[magnet]) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, infoHash: torrents[magnet].infoHash }));
        }
        client.add(magnet, { path: './data/downloads' }, (torrent) => {
            torrents[magnet] = torrent;
            console.log('Torrent added:', torrent.infoHash);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, infoHash: torrent.infoHash }));
        });
        return;
    }

    if (url.pathname === '/status') {
        const torrent = client.get(magnet);
        if (!torrent) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Not found' })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            progress: torrent.progress,
            downloadSpeed: torrent.downloadSpeed,
            numPeers: torrent.numPeers,
            ready: torrent.ready,
            files: torrent.files.map(f => ({ name: f.name, length: f.length }))
        }));
        return;
    }

    if (url.pathname === '/stream') {
        const fileIndex = parseInt(url.searchParams.get('index') || '0');
        const torrent = client.get(magnet);
        if (!torrent) { res.writeHead(404); return res.end('Not found'); }

        const file = torrent.files.filter(f => f.name.match(/\.(mp4|mkv|webm|avi)$/i))[fileIndex] || torrent.files[0];
        if (!file) { res.writeHead(404); return res.end('No video file found'); }

        const range = req.headers.range;
        if (!range) {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': file.length, 'Accept-Ranges': 'bytes' });
            file.createReadStream().pipe(res);
        } else {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${file.length}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': (end - start) + 1,
                'Content-Type': 'video/mp4'
            });
            file.createReadStream({ start, end }).pipe(res);
        }
        return;
    }

    res.writeHead(404); res.end('Not found');
});

server.listen(5001, () => { console.log('Torrent engine on 5001'); });
