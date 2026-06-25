/**
 * StreamVault — Téléchargeur yt-dlp
 * Analyse les formats, lance les téléchargements, affiche la progression
 */

let _dlInfo       = null;
let _dlUrl        = '';
let _dlPollTimers = {};

function renderYtdlAuthStatus(data) {
  const grid = document.getElementById('auth-status-grid');
  if (!grid) return;
  if (!data?.ok) {
    grid.innerHTML = `<div class="auth-status-pill warn">Statut indisponible</div>`;
    return;
  }
  const pills = [
    { label: data.render ? 'Render' : 'Local', type: data.render ? 'warn' : 'ok' },
    { label: data.puppeteer ? 'Puppeteer: ok' : 'Puppeteer: off', type: data.puppeteer ? 'ok' : 'warn' },
    { label: data.cookiefile ? 'Cookie file actif' : 'Pas de cookie file', type: data.cookiefile ? 'ok' : 'warn' },
    { label: data.cookies_from_browser ? `Browser: ${data.cookies_from_browser_value}` : 'Browser: off', type: data.cookies_from_browser ? 'ok' : 'warn' },
    { label: data.visitor_data ? 'Visitor data: ok' : 'Visitor data: absent', type: data.visitor_data ? 'ok' : 'warn' },
    { label: data.po_token_count ? `PO Tokens: ${data.po_token_count}` : 'PO Token: absent', type: data.po_token_count ? 'ok' : 'warn' },
  ];
  grid.innerHTML = pills.map(p => `<div class="auth-status-pill ${p.type}">${esc(p.label)}</div>`).join('');
}

async function refreshYtdlAuthStatus() {
  const data = await API.getYtdlAuthStatus();
  renderYtdlAuthStatus(data);
  return data;
}

async function saveYtdlCookiesFromUi() {
  const textarea = document.getElementById('yt-cookies-input');
  const text = textarea?.value.trim();
  if (!text) { toast('Colle un fichier cookies Netscape', '<i class="fas fa-exclamation-triangle"></i>'); return; }
  const data = await API.saveYtdlCookies(text);
  if (!data.ok) { toast(`Erreur: ${data.error || '?'}`, '<i class="fas fa-times"></i>'); return; }
  await refreshYtdlAuthStatus();
  toast('Cookies sauvegardés', '<i class="fas fa-check"></i>');
}

async function clearYtdlCookiesFromUi() {
  const textarea = document.getElementById('yt-cookies-input');
  const data = await API.clearYtdlCookies();
  if (!data.ok) { toast(`Erreur: ${data.error || '?'}`, '<i class="fas fa-times"></i>'); return; }
  if (textarea) textarea.value = '';
  await refreshYtdlAuthStatus();
  toast('Cookies supprimés', '<i class="fas fa-check"></i>');
}

function extractFirstUrl(text) {
  if (!text) return '';
  const raw = String(text).trim();
  const m = raw.match(/https?:\/\/[^\s<>"']+/i);
  return (m ? m[0] : raw).replace(/[)\]}>.,;'"`]+$/g, '');
}

function normalizeYoutubeDlUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(extractFirstUrl(url));
    const host = u.hostname.replace('www.', '').replace('m.youtube.com', 'youtube.com');
    if (host !== 'youtube.com' && host !== 'youtu.be') return u.href;

    if (host === 'youtube.com' && u.pathname === '/attribution_link') {
      const inner = u.searchParams.get('u');
      if (inner) {
        const decoded = decodeURIComponent(inner);
        const full = decoded.startsWith('/') ? `https://youtube.com${decoded}` : decoded;
        return normalizeYoutubeDlUrl(full);
      }
    }

    let id = '';
    if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
      id = m ? m[1] : '';
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : u.href;
  } catch {
    return extractFirstUrl(url);
  }
}

function setFmtTab(name, btn) {
  document.querySelectorAll('.fmt-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.fmt-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`fmt-${name}`).classList.add('active');
}

function renderDlInfo(info) {
  // Header
  const thumb = document.getElementById('dl-thumb');
  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    thumb.style.display = 'block';
  } else {
    thumb.style.display = 'none';
  }
  document.getElementById('dl-title').textContent = info.title || 'Sans titre';

  const meta = [];
  if (info.uploader)   meta.push('<i class="fas fa-user"></i> ' + esc(info.uploader));
  if (info.duration)   meta.push('<i class="fas fa-clock"></i> ' + fmtDuration(info.duration));
  if (info.view_count) meta.push('<i class="fas fa-eye"></i> ' + info.view_count.toLocaleString());
  document.getElementById('dl-meta').innerHTML = meta.join('  ·  ');

  // Video formats
  const videoFmts = info.formats.filter(f => f.type === 'video+audio' || f.type === 'video');
  const audioFmts = info.formats.filter(f => f.type === 'audio');

  // Add "best" option
  const bestRow = makeFormatRow({
    id:'best', type:'video+audio', ext:'mp4',
    resolution:'Meilleure qualité', note:'Auto (vidéo + audio)', filesize_str:'?',
  }, _dlUrl);

  document.getElementById('formats-video').innerHTML =
    bestRow + videoFmts.map(f => makeFormatRow(f, _dlUrl)).join('');

  document.getElementById('formats-audio').innerHTML =
    '<div class="fmt-row" style="margin-bottom:4px">' +
    '<div class="fmt-badge audio">MP3</div>' +
    '<div class="fmt-info"><div class="fmt-res">Meilleur audio → MP3</div>' +
    '<div class="fmt-detail">192kbps</div></div>' +
    `<div class="fmt-actions">
      <button class="btn-primary" style="font-size:11px;padding:7px 14px"
        onclick="startDownload('${esc(_dlUrl)}','bestaudio','mp3')"><i class="fas fa-download"></i> MP3</button>
      <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
        onclick="startDownload('${esc(_dlUrl)}','bestaudio','m4a')"><i class="fas fa-download"></i> M4A</button>
    </div></div>` +
    audioFmts.map(f => makeFormatRow(f, _dlUrl)).join('');

  // Subtitles
  if (info.subtitles?.length) {
    document.getElementById('formats-subs').innerHTML =
      info.subtitles.map(s => `
        <div class="fmt-row">
          <div class="fmt-badge sub">${s.ext.toUpperCase()}</div>
          <div class="fmt-info">
            <div class="fmt-res">${s.name} ${s.auto ?'<span style="color:var(--muted);font-size:10px">(auto)</span>' : ''}</div>
            <div class="fmt-detail">${s.lang} · ${s.ext}</div>
          </div>
          <div class="fmt-actions">
            <button class="btn-primary" style="font-size:11px;padding:7px 14px"
              onclick="startSubDownload('${esc(_dlUrl)}','${s.lang}','${s.ext}')"><i class="fas fa-download"></i> Télécharger</button>
            <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
              onclick="window.open('/api/proxy?url='+encodeURIComponent('${esc(s.url)}'))"><i class="fas fa-eye"></i> Voir</button>
          </div>
        </div>`).join('');
  } else {
    document.getElementById('formats-subs').innerHTML =
      '<div class="diag-empty">Aucun sous-titre disponible.</div>';
  }
}

function makeFormatRow(f, url) {
  const typeClass = f.type === 'video+audio' ?'both' : f.type === 'audio' ?'audio' : 'video';
  const typeLabel = f.type === 'video+audio' ?'V+A' : f.type === 'audio' ?'AUDIO' : 'VIDÉO';
  const res = f.resolution || 'audio';
  const detail = [
    f.ext?.toUpperCase(),
    f.vcodec && f.vcodec !== 'none' ?f.vcodec.split('.')[0] : null,
    f.acodec && f.acodec !== 'none' ?f.acodec.split('.')[0] : null,
    f.fps ?f.fps + 'fps' : null,
    f.tbr ?Math.round(f.tbr) + 'kbps' : null,
    f.note || null,
  ].filter(Boolean).join(' · ');

  return `
    <div class="fmt-row">
      <div class="fmt-badge ${typeClass}">${typeLabel}</div>
      <div class="fmt-info">
        <div class="fmt-res">${res}</div>
        <div class="fmt-detail">${detail}</div>
      </div>
      <span class="fmt-size">${f.filesize_str||'?'}</span>
      <div class="fmt-actions">
        <button class="btn-primary" style="font-size:11px;padding:7px 14px"
          onclick="startDownload('${esc(url)}','${f.id}','${f.ext||'mp4'}')">
          <i class="fas fa-download"></i> ${f.ext?.toUpperCase()||'DL'}
        </button>
        ${f.type==='video+audio'||f.type==='video' ?`
        <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
          onclick="startDownload('${esc(url)}','${f.id}','mp4')">
          <i class="fas fa-download"></i> MP4
        </button>` : ''}
      </div>
    </div>`;
}

async function startDownload(url, formatId, ext) {
  toast('Démarrage du téléchargement…', '<i class="fas fa-download"></i>');
  try {
    const res = await API.fetch('/api/ytdl/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format_id: formatId, ext }),
    });
    const data = await res.json();
    if (!data.ok) { toast('Erreur : ' + data.error, '<i class="fas fa-times"></i>'); return; }

    toast('<i class="fas fa-download"></i> Téléchargement démarré', '<i class="fas fa-check"></i>');
    trackDownload(data.id);
    refreshDlList();
  } catch (e) {
    toast('Erreur : ' + e.message, '<i class="fas fa-times"></i>');
  }
}

async function startSubDownload(url, lang, ext) {
  toast('Téléchargement sous-titres…', '<i class="fas fa-file-alt"></i>');
  try {
    const res = await API.fetch('/api/ytdl/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format_id: 'bestaudio', ext: 'm4a', sub_lang: lang }),
    });
    const data = await res.json();
    if (data.ok) { toast('Sous-titres en téléchargement', '<i class="fas fa-check"></i>'); trackDownload(data.id); refreshDlList(); }
  } catch (e) { toast('Erreur : ' + e.message, '<i class="fas fa-times"></i>'); }
}

function trackDownload(dlId) {
  if (_dlPollTimers[dlId]) return;
  _dlPollTimers[dlId] = setInterval(async () => {
    try {
      const res  = await API.fetch(`/api/ytdl/progress?id=${dlId}`);
      const data = await res.json();
      updateDlItem(data);
      if (['done','error','cancelled'].includes(data.status)) {
        clearInterval(_dlPollTimers[dlId]);
        delete _dlPollTimers[dlId];
        refreshDlList();
      }
    } catch {
      clearInterval(_dlPollTimers[dlId]);
      delete _dlPollTimers[dlId];
    }
  }, 800);
}

function updateDlItem(dl) {
  const el = document.getElementById(`dl-item-${dl.id}`);
  if (!el) return;
  el.querySelector('.dl-item-status').className = `dl-item-status ${dl.status}`;
  el.querySelector('.dl-item-status').textContent = statusLabel(dl.status);
  el.querySelector('.dl-progress-fill').style.width = dl.progress + '%';
  el.querySelector('.dl-progress-pct').textContent = dl.progress + '%';
  el.querySelector('.dl-progress-speed').textContent = dl.speed || '';
  el.querySelector('.dl-progress-eta').textContent  = dl.eta ?'ETA: ' + dl.eta : '';
  if (dl.title) el.querySelector('.dl-item-title').textContent = dl.title;
  if (dl.status === 'done' && dl.filename) {
    const actionsEl = el.querySelector('.dl-item-actions');
    actionsEl.innerHTML = `
      <a href="/api/downloads/file?f=${encodeURIComponent(dl.filename)}" download
        class="btn-primary" style="font-size:11px;padding:7px 16px;text-decoration:none">
        <i class="fas fa-download"></i> Sauvegarder
      </a>
      <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
        onclick="playDownloaded('${esc(dl.filename)}')"><i class="fas fa-play"></i> Lire</button>`;
  }
}

async function refreshDlList() {
  try {
    const res  = await API.fetch('/api/downloads');
    const data = await res.json();
    renderDlList(data);
  } catch {}
}

function renderDlList(data) {
  const el = document.getElementById('dl-list');
  if (!el) return;

  const allDls = [
    ...Object.values(data.downloads || {}),
    ...((data.files||[]).filter(f =>
      !Object.values(data.downloads||{}).some(d => d.filename === f.filename)
    ).map(f => ({
      id: f.filename, status: 'done', progress: 100,
      filename: f.filename, title: f.filename,
      size: f.size, speed: '', eta: '',
    })))
  ].sort((a,b) => (b.ts||0)-(a.ts||0));

  if (!allDls.length) {
    el.innerHTML = '<div class="diag-empty">Aucun téléchargement.</div>';
    return;
  }

  el.innerHTML = allDls.map(dl => `
    <div class="dl-item" id="dl-item-${dl.id}">
      <div class="dl-item-header">
        <div class="dl-item-title">${esc(dl.title || dl.url || dl.id)}</div>
        <span class="dl-item-status ${dl.status}">${statusLabel(dl.status)}</span>
      </div>
      <div class="dl-progress-bar">
        <div class="dl-progress-fill" style="width:${dl.progress||0}%"></div>
      </div>
      <div class="dl-progress-meta">
        <span class="dl-progress-pct">${dl.progress||0}%</span>
        <span class="dl-progress-speed">${dl.speed||''}</span>
        <span class="dl-progress-eta">${dl.eta?'ETA: '+dl.eta:''}</span>
        <span>${dl.size||''}</span>
      </div>
      ${dl.error ?`<div style="font-size:11px;color:#ff6060;margin-top:6px"><i class="fas fa-times"></i> ${esc(dl.error)}</div>` : ''}
      <div class="dl-item-actions">
        ${dl.status==='done'&&dl.filename ?`
          <a href="/api/downloads/file?f=${encodeURIComponent(dl.filename)}" download
            class="btn-primary" style="font-size:11px;padding:7px 16px;text-decoration:none"><i class="fas fa-download"></i> Sauvegarder</a>
          <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
            onclick="playDownloaded('${esc(dl.filename)}')"><i class="fas fa-play"></i> Lire</button>` : ''}
        ${dl.status==='error' ?`
          <button class="btn-primary" style="font-size:11px;padding:7px 14px"
            onclick="retryDl('${dl.id}')"><i class="fas fa-sync"></i> Réessayer</button>` : ''}
        ${dl.status==='downloading' ?`
          <button class="btn-ghost" style="font-size:11px;padding:7px 14px"
            onclick="cancelDl('${dl.id}')">✕ Annuler</button>` : ''}
      </div>
    </div>`).join('');

  // Resume polling for active downloads
  allDls.filter(d => d.status === 'downloading' || d.status === 'processing')
        .forEach(d => trackDownload(d.id));
}

async function cancelDl(id) {
  await API.fetch('/api/ytdl/cancel', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({id}),
  });
  refreshDlList();
}

async function retryDl(id) {
  toast('Relance du téléchargement...', '<i class="fas fa-sync"></i>');
  const data = await API.retryDownload(id);
  if (data.ok) {
    toast('Relancé !', '<i class="fas fa-check"></i>');
    trackDownload(id);
    refreshDlList();
  } else {
    toast('Erreur: ' + data.error, '<i class="fas fa-times"></i>');
  }
}

function playDownloaded(filename) {
  const url = `/api/downloads/file?f=${encodeURIComponent(filename)}`;
  showPage('player');
  document.getElementById('nav-player-link').style.display = 'block';
  Player.load(url);
}

function statusLabel(s) {
  return {
    starting:'Démarrage', downloading:'Téléchargement',
    processing:'Traitement', done:'Terminé',
    error:'Erreur', cancelled:'Annulé',
  }[s] || s;
}

function fmtDuration(s) {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  if(h) return `${h}h${m.toString().padStart(2,'0')}m`;
  return `${m}m${sec.toString().padStart(2,'0')}s`;
}

function esc(s) {
  return String(s).replace(/'/g,"\\'").replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Auto-refresh downloads list on page open
document.addEventListener('DOMContentLoaded', () => {
  refreshDlList();
  refreshYtdlAuthStatus();
  setInterval(refreshDlList, 5000);
});

// ── Playlist batch downloader ─────────────────────────
let _dlPlaylist = null;
let _selectedItems = new Set();

async function analyzeDl() {
  const raw = document.getElementById('dl-url-input').value.trim();
  if (!raw) { toast('Colle un lien', '<i class="fas fa-exclamation-triangle"></i>'); return; }
  const url = normalizeYoutubeDlUrl(raw);
  document.getElementById('dl-url-input').value = url;
  _dlUrl = url;

  const btn = document.getElementById('dl-analyze-btn');
  btn.disabled = true; btn.textContent = '…';

  document.getElementById('dl-info-panel').style.display     = 'none';
  document.getElementById('dl-playlist-section').style.display = 'none';
  _dlPlaylist = null; _selectedItems.clear();

  toast('Analyse en cours…', '<i class="fas fa-spinner fa-spin"></i>');

  try {
    // Check if playlist first
    const [plRes, infoRes] = await Promise.allSettled([
      API.fetch(`/api/playlist?url=${encodeURIComponent(url)}`).then(r=>r.json()),
      API.fetch('/api/ytdl/info', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ url }),
      }).then(r=>r.json()),
    ]);

    const plData   = plRes.status==='fulfilled' ?plRes.value : null;
    const infoData = infoRes.status==='fulfilled' ?infoRes.value : null;

    if (plData?.ok && plData?.is_playlist && plData?.items?.length > 1) {
      // It's a playlist
      _dlPlaylist = plData;
      renderDlPlaylist(plData);
      document.getElementById('dl-playlist-section').style.display = 'block';
      toast(`<i class="fas fa-check"></i> Playlist : ${plData.count} vidéos`, '<i class="fas fa-check"></i>');
    } else if (infoData?.bot_check) {
      await refreshYtdlAuthStatus();
      toast(infoData.error || 'YouTube demande une vérification anti-bot', '<i class="fas fa-exclamation-triangle"></i>');
    } else if (infoData?.ok) {
      // Single video
      _dlInfo = infoData;
      renderDlInfo(infoData);
      document.getElementById('dl-info-panel').style.display = 'block';
      toast(`<i class="fas fa-check"></i> ${infoData.formats.length} formats`, '<i class="fas fa-check"></i>');
    } else {
      toast('Impossible d\'analyser ce lien', '<i class="fas fa-times"></i>');
    }
  } catch(e) {
    toast('Erreur : ' + e.message, '<i class="fas fa-times"></i>');
  } finally {
    btn.disabled = false; btn.textContent = 'Analyser';
  }
}

function renderDlPlaylist(pl) {
  document.getElementById('dl-playlist-title').textContent = pl.title || 'Playlist';
  document.getElementById('dl-playlist-info').textContent  =
    `${pl.count} vidéos${pl.uploader ?' · ' + pl.uploader : ''}`;

  _selectedItems = new Set(pl.items.map((_,i)=>i));
  updateSelectCount();

  document.getElementById('dl-playlist-items').innerHTML = pl.items.map((item,i) => `
    <div class="dl-pl-item">
      <input type="checkbox" checked data-idx="${i}" onchange="toggleItem(${i},this.checked)">
      <div class="dl-pl-thumb">
        ${item.thumbnail ?`<img src="${item.thumbnail}" loading="lazy" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="dl-pl-info">
        <div class="dl-pl-title">${esc(item.title)}</div>
        <div class="dl-pl-meta">${item.duration?fmtDuration(item.duration):''}</div>
      </div>
      <div class="dl-pl-actions">
        <button class="btn-tiny" onclick="startDownload('${esc(item.url)}','best','mp4')"><i class="fas fa-download"></i></button>
        <button class="btn-tiny" onclick="playPlaylistItemDl(${i})"><i class="fas fa-play"></i></button>
      </div>
    </div>`).join('');
}

function toggleItem(idx, checked) {
  if (checked) _selectedItems.add(idx);
  else _selectedItems.delete(idx);
  updateSelectCount();
}

function toggleSelectAll(checked) {
  if (!_dlPlaylist) return;
  if (checked) {
    _dlPlaylist.items.forEach((_,i) => _selectedItems.add(i));
  } else {
    _selectedItems.clear();
  }
  document.querySelectorAll('#dl-playlist-items input[type=checkbox]')
    .forEach(cb => cb.checked = checked);
  updateSelectCount();
}

function updateSelectCount() {
  const el = document.getElementById('pl-select-count');
  if (el) el.textContent = `${_selectedItems.size} sélectionné(s)`;
}

function getSelectedPlaylistItems() {
  if (!_dlPlaylist) return [];
  return [..._selectedItems].map(i => _dlPlaylist.items[i]).filter(Boolean);
}

async function dlPlaylistAll() {
  if (!_dlPlaylist?.items?.length) return;
  const urls = _dlPlaylist.items.map(i => i.url);
  await batchDownload(urls);
}

async function dlPlaylistSelected() {
  const items = getSelectedPlaylistItems();
  if (!items.length) { toast('Sélectionne au moins une vidéo', '<i class="fas fa-exclamation-triangle"></i>'); return; }
  await batchDownload(items.map(i => i.url));
}

async function batchDownload(urls) {
  toast(`<i class="fas fa-download"></i> ${urls.length} téléchargements démarrés`, '<i class="fas fa-download"></i>');
  const res = await API.fetch('/api/ytdl/download/batch', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ urls, format_id:'best', ext:'mp4' }),
  });
  const data = await res.json();
  if (data.ok) {
    data.ids.forEach(id => trackDownload(id));
    refreshDlList();
    // Update active count
    const cnt = document.getElementById('dl-active-count');
    if (cnt) cnt.textContent = `${data.count} en cours`;
  }
}

async function addPlaylistToQueue() {
  if (!_dlPlaylist?.items?.length) return;
  for (const item of _dlPlaylist.items) {
    await API.fetch('/api/queue', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'add', item:{ url:item.url, title:item.title||item.url } }),
    });
  }
  await loadQueue();
  toast(`${_dlPlaylist.items.length} vidéos → Queue`, '<i class="fas fa-list-ul"></i>');
}

function playPlaylistItemDl(idx) {
  if (!_dlPlaylist?.items?.[idx]) return;
  const item = _dlPlaylist.items[idx];
  showPage('player');
  document.getElementById('nav-player-link').style.display = 'block';
  Player.load(item.url);
}
