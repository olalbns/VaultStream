/**
 * StreamVault — App v4
 * Routing, UI, historique, intercept polling, JSON detection
 */

// ── Page routing ──────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${name}`);
  if (target) target.classList.add('active');
  
  // Mise à jour de l'état actif (inclut le support pour les icônes sur mobile)
  document.querySelectorAll('.nav-links a[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === name);
  });

  if (name === 'library')     renderLibrary();
  if (name === 'home')        renderHomeRecent();
  if (name === 'queue')       loadQueue();
  if (name === 'downloader')  { refreshDlList(); if (typeof refreshYtdlAuthStatus === 'function') refreshYtdlAuthStatus(); }
  if (name === 'collections') loadCollections();
  if (name === 'player')      renderSidebarQueue();
  if (name === 'search')      /* already handled by globalSearch */;
}

// ── Global Search ──────────────────────────────────────
async function globalSearch() {
  const query = document.getElementById('nav-search-input')?.value.trim();
  if (!query) return;

  showPage('search');
  document.getElementById('search-query-display').textContent = query;
  const grid = document.getElementById('search-results-grid');
  const loader = document.getElementById('search-loading');

  grid.innerHTML = '';
  loader.style.display = 'block';

  try {
    const data = await API.search(query);
    loader.style.display = 'none';

    if (!data.ok) {
      grid.innerHTML = `<div class="error-msg">Erreur: ${data.error}</div>`;
      return;
    }

    if (!data.results?.length) {
      grid.innerHTML = `<div class="error-msg">Aucun résultat pour "${esc(query)}"</div>`;
      return;
    }

    data.results.forEach(v => {
      const card = document.createElement('div');
      card.className = 'video-card';
      const thumb = v.thumbnail
        ?`<img src="${v.thumbnail}" alt="" loading="lazy">`
        : `<span class="card-thumb-icon">🎞</span>`;
      card.innerHTML = `
        <div class="card-thumb">${thumb}
          <div class="card-play-hover">
            <div class="play-circle-sm">
              <svg viewBox="0 0 24 24" fill="white" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        </div>
        <div class="card-body">
          <div class="card-title">${esc(v.title)}</div>
          <div class="card-domain">${esc(v.uploader || 'YouTube')}</div>
          <div class="card-meta">
            <span class="card-time">${v.duration ?formatDuration(v.duration) : '?'}</span>
          </div>
        </div>`;
      card.onclick = () => {
        document.getElementById('main-url-input').value = v.url;
        loadFromHome();
      };
      grid.appendChild(card);
    });
  } catch (e) {
    loader.style.display = 'none';
    grid.innerHTML = `<div class="error-msg">Une erreur s'est produite.</div>`;
  }
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h > 0 ?h + ':' : '') + (m < 10 && h > 0 ?'0' : '') + m + ':' + (s < 10 ?'0' : '') + s;
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function focusInput() {
  showPage('home');
  setTimeout(() => document.getElementById('main-url-input')?.focus(), 150);
}

// ── Input helpers ──────────────────────────────────────
function onMainInput() {
  updateClearBtn();
  const val = document.getElementById('main-url-input').value.trim();
  if (!val) { setHint(''); return; }
  
  // Détection des types de liens
  if (val.startsWith('{') || val.startsWith('[')) {
    setHint('JSON détecté — Extraction automatique', 'ok'); return;
  }
  if (val.includes('.m3u8')) {
    setHint('Lien HLS/M3U8 détecté', 'ok'); return;
  }
  if (/youtu/.test(val)) {
    setHint('Lien YouTube détecté', 'ok'); return;
  }
  if (/tiktok\.com/.test(val)) {
    setHint('Vidéo TikTok détectée 📱', 'ok'); return;
  }
  if (/instagram\.com/.test(val)) {
    setHint('Contenu Instagram détecté 📸', 'ok'); return;
  }
  if (/twitter\.com|x\.com/.test(val)) {
    setHint('Vidéo X / Twitter détectée 🐦', 'ok'); return;
  }
  if (/facebook\.com|fb\.watch/.test(val)) {
    setHint('Vidéo Facebook détectée 👥', 'ok'); return;
  }
  
  if (val.length > 10 && !val.startsWith('http')) {
    setHint('L\'URL doit commencer par https://', 'error'); return;
  }
  setHint('Lien prêt à être analysé', 'info');
}

function clearInput() {
  const inp = document.getElementById('main-url-input');
  if (inp) inp.value = '';
  updateClearBtn(); setHint('');
}

function updateClearBtn() {
  const inp = document.getElementById('main-url-input');
  const btn = document.getElementById('input-clear-btn');
  if (btn) btn.classList.toggle('show', !!(inp?.value));
}

function setHint(msg, type = '') {
  const h = document.getElementById('input-hint');
  if (!h) return;
  h.textContent = msg;
  h.className = 'input-hint' + (type ?' '+type : '');
}

function isValidInput(s) {
  if (!s) return false;
  if (s.startsWith('{') || s.startsWith('[')) return true; // JSON
  try { return /^https?:\/\//.test(new URL(s).href); } catch { return false; }
}

function normalizeYoutubeUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace('www.', '').replace('m.youtube.com', 'youtube.com');
    if (host !== 'youtube.com' && host !== 'youtu.be') return url;

    if (host === 'youtube.com' && u.pathname === '/attribution_link') {
      const inner = u.searchParams.get('u');
      if (inner) {
        const decoded = decodeURIComponent(inner);
        const full = decoded.startsWith('/') ? `https://youtube.com${decoded}` : decoded;
        return normalizeYoutubeUrl(full);
      }
    }

    let id = '';
    if (host === 'youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] || '';
    } else if (u.pathname === '/watch') {
      id = u.searchParams.get('v') || '';
    } else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
      id = m ? m[1] : '';
    }

    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    return url;
  } catch {
    return url;
  }
}

// ── Load from home – (at bottom of file) ──

function retryLoad() {
  const url = Player.currentUrl;
  if (url) Player.load(url).catch(() => {});
}

// ── Player actions ──────────────────────────────────────
function downloadCurrent() {
  const url = Player.currentUrl;
  if (!url) return;
  // If it's a local download file, serve it
  if (url.startsWith('/api/downloads/')) {
    window.open(url + '&download=1', '_blank'); return;
  }
  // Otherwise open downloader page with URL pre-filled
  document.getElementById('dl-url-input').value = url;
  showPage('downloader');
  toast('URL copiée dans le téléchargeur', '↓');
}

function openInTab() {
  const url = Player.currentUrl;
  if (url) window.open(url, '_blank');
}

function copyCurrentUrl() {
  const url = Player.currentUrl;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('⎘ URL copiée !', '⎘'));
}

function clearDiag() { Player.clearDiag(); }

// ── History rendering ──────────────────────────────────
let _allHistory = [];

async function refreshAllHistory() {
  _allHistory = await API.getHistory();
  renderSidebarHistory(_allHistory);
  renderHomeRecent(_allHistory);
}

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.',''); }
  catch { return url.slice(0,40); }
}

function getYtIdFromUrl(url) {
  try {
    const m = url.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ?m[1] : null;
  } catch { return null; }
}

function makeCardThumb(h) {
  const ytId = getYtIdFromUrl(h.url);
  if (ytId) return `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`;
  return `<span class="card-thumb-icon">🎞</span>`;
}

function makeVideoCard(h, showDel = false) {
  const ytId = getYtIdFromUrl(h.url);
  const thumb = ytId
    ?`<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="card-thumb-icon">🎞</span>`;
  const del = showDel
    ?`<button class="card-del" onclick="deleteAndRefresh(event,'${esc(h.id)}')" title="Supprimer">✕</button>` : '';
  return `
    <div class="video-card" onclick="replayFromHistory('${esc(h.url)}')">
      <div class="card-thumb">${thumb}
        <div class="card-play-hover">
          <div class="play-circle-sm">
            <svg viewBox="0 0 24 24" fill="white" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-domain">${esc(getDomain(h.url))} ${del}</div>
        <div class="card-meta">
          <span class="card-time">${esc(h.date)}</span>
          <span class="card-method">${esc(h.method||'?')}</span>
        </div>
      </div>
    </div>`;
}

async function renderHomeRecent(history) {
  if (!history) history = await API.getHistory();
  const section = document.getElementById('home-recent');
  const row     = document.getElementById('home-cards-row');
  if (!section||!row) return;
  if (!history?.length) { section.style.display='none'; return; }
  section.style.display = '';
  row.innerHTML = history.slice(0,10).map(h => makeVideoCard(h)).join('');
}

function renderSidebarHistory(history) {
  const el = document.getElementById('sidebar-history');
  if (!el) return;
  if (!history?.length) { el.innerHTML='<div class="diag-empty">Aucune vidéo.</div>'; return; }
  el.innerHTML = history.slice(0,12).map(h => {
    const ytId = getYtIdFromUrl(h.url);
    const thumb = ytId
      ?`<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<span class="sh-thumb-icon">🎞</span>`;
    return `<div class="sh-item" onclick="replayFromHistory('${esc(h.url)}')">
      <div class="sh-thumb">${thumb}</div>
      <div class="sh-info">
        <div class="sh-domain">${esc(getDomain(h.url))}</div>
        <div class="sh-time">${esc(h.method)} · ${esc(h.date)}</div>
      </div>
      <button class="sh-del" onclick="deleteAndRefresh(event,'${esc(h.id)}')" title="Supprimer">✕</button>
    </div>`;
  }).join('');
}

let _libFilter = '';
async function renderLibrary(history) {
  if (!history) history = await API.getHistory();
  _allHistory = history;
  const grid = document.getElementById('library-grid');
  if (!grid) return;
  const filtered = _libFilter
    ?history.filter(h => h.url.toLowerCase().includes(_libFilter) || (h.title||'').toLowerCase().includes(_libFilter))
    : history;
  if (!filtered.length) {
    grid.innerHTML = `<div class="lib-empty">
      <div class="lib-empty-icon">🎞</div>
      <p>${_libFilter ?'Aucun résultat pour "'+esc(_libFilter)+'"' : 'Aucune vidéo dans l\'historique'}</p>
      <button class="btn-primary" onclick="showPage('home')">Ajouter une vidéo</button>
    </div>`; return;
  }
  grid.innerHTML = filtered.map(h => makeVideoCard(h, true)).join('');
}

function filterLibrary(val) {
  _libFilter = val.toLowerCase().trim();
  renderLibrary(_allHistory);
}

async function replayFromHistory(url) {
  document.getElementById('main-url-input').value = url;
  document.getElementById('sidebar-url-input').value = url;
  showPage('player');
  document.getElementById('nav-player-li').style.display = 'block';
  try {
    await Player.load(url);
    await refreshAllHistory();
    toast('▶ Relecture', '✓');
  } catch { toast('Lecture impossible', '✗'); }
}

async function deleteAndRefresh(e, id) {
  e.stopPropagation();
  await API.deleteHistory(id);
  await refreshAllHistory();
  if (document.getElementById('page-library').classList.contains('active'))
    renderLibrary(_allHistory);
  toast('Supprimé', '🗑');
}

async function clearAllHistory() {
  if (!confirm('Effacer tout l\'historique ?')) return;
  const history = await API.getHistory();
  for (const h of history) await API.deleteHistory(h.id);
  _allHistory = [];
  await refreshAllHistory();
  renderLibrary([]);
  toast('Historique effacé', '✓');
}

// ── Toast ──────────────────────────────────────────────
let _toastTimer;
function toast(msg, icon = '✓') {
  const el = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  document.getElementById('toast-icon').textContent = icon;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Intercept polling (from extension) ─────────────────
setInterval(async () => {
  try {
    const res  = await fetch('/api/intercept/latest');
    const data = await res.json();
    if (data?.url) {
      document.getElementById('main-url-input').value    = data.url;
      document.getElementById('sidebar-url-input').value = data.url;
      showPage('player');
      document.getElementById('nav-player-li').style.display = 'block';
      setTimeout(async () => {
        try {
          await Player.load(data.url);
          await refreshAllHistory();
          toast('▶ Vidéo reçue via extension', '🔌');
        } catch { toast('Extension: lecture impossible', '✗'); }
      }, 100);
    }
  } catch {}
}, 2000);

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const inp = document.getElementById('main-url-input');
  if (inp) {
    inp.addEventListener('paste', () => setTimeout(() => { updateClearBtn(); onMainInput(); }, 50));
    inp.addEventListener('keydown', e => { if (e.key==='Enter') loadFromHome(); });
    onMainInput(); // Initialisation
  }
  
  refreshAllHistory();
  
  // Polling des téléchargements actifs
  setInterval(refreshDlList, 5000);
});

// ── Playlist auto-detection on load ──────────────────
// After player loads, check if URL is a playlist
const _origPlayerLoad = Player.load.bind(Player);
// We hook into showPage to trigger playlist load
const _origShowPage = showPage;

// Override loadFromHome to also load playlist
async function loadFromHome() {
  const rawUrl = document.getElementById('main-url-input')?.value.trim();
  const url = normalizeYoutubeUrl(rawUrl);
  if (!url) { setHint('Colle un lien ou JSON', 'error'); return; }
  if (!isValidInput(url)) { setHint('URL invalide', 'error'); return; }

  setHint('Chargement…', 'info');
  const btn = document.getElementById('home-load-btn');
  if (btn) btn.disabled = true;

  try {
    showPage('player');
    document.getElementById('nav-player-li').style.display = 'block';
    // Reset playlist state
    window._playlist = null; window._playlistIdx = -1;
    const pb = document.getElementById('playlist-block');
    if (pb) pb.style.display = 'none';
    hideNextBar();

    // Detect if it looks like a playlist URL (before loading)
    const isPlaylistUrl = url.includes('list=') || url.includes('/playlist') || url.includes('/channel') || url.includes('/@') ||
      (url.includes('youtube.com') && !url.includes('watch?v=') && !url.includes('youtu.be'));

    if (isPlaylistUrl) {
      // For playlists: load playlist first, then play first item
      setHint('Détection playlist…', 'info');
      await loadPlaylist(url); // loadPlaylist auto-plays first item
    } else {
      // Single video
      await Player.load(url);
      // Check if it's also a playlist in background
      loadPlaylist(url).catch(()=>{});
    }

    setHint('');
    const sbInp = document.getElementById('sidebar-url-input');
    if (sbInp) sbInp.value = url;
    await refreshAllHistory();
    await renderSidebarQueue();
    toast('▶ Lecture démarrée', '✓');
  } catch {
    showPage('home');
    setHint('Impossible de lire. Vérifie le lien.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadFromSidebar() {
  const rawUrl = document.getElementById('sidebar-url-input')?.value.trim();
  const url = normalizeYoutubeUrl(rawUrl);
  if (!url || !isValidInput(url)) { toast('Lien invalide', '⚠'); return; }
  window._playlist=null; window._playlistIdx=-1;
  hideNextBar();
  const pb=document.getElementById('playlist-block'); if(pb) pb.style.display='none';
  try {
    await Player.load(url);
    await refreshAllHistory();
    await renderSidebarQueue();
    toast('▶ Nouvelle vidéo', '✓');
    loadPlaylist(url).catch(()=>{});
  } catch { toast('Lecture impossible', '✗'); }
}

// ── Collections page ──────────────────────────────────
// showPage already calls loadCollections() when page=collections via the page handler
