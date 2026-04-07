/**
 * StreamVault â€” App v4
 * Routing, UI, historique, intercept polling, JSON detection
 */

// â”€â”€ Page routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${name}`);
  if (target) target.classList.add('active');
  
  // Mise Ã  jour de l'Ã©tat actif (inclut le support pour les icÃ´nes sur mobile)
  document.querySelectorAll('.nav-links a[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === name);
  });

  if (name === 'library')     renderLibrary();
  if (name === 'home')        renderHomeRecent();
  if (name === 'queue')       loadQueue();
  if (name === 'downloader')  refreshDlList();
  if (name === 'collections') loadCollections();
  if (name === 'player')      renderSidebarQueue();
  if (name === 'search')      /* already handled by globalSearch */;
}

// â”€â”€ Global Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function globalSearch() {
  const query = document.getElementById('nav-search-input').value.trim();
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

    if (!data.results.length) {
      grid.innerHTML = `<div class="error-msg">Aucun rÃ©sultat pour "${esc(query)}"</div>`;
      return;
    }

    data.results.forEach(v => {
      const card = document.createElement('div');
      card.className = 'video-card';
      const thumb = v.thumbnail
        ? `<img src="${v.thumbnail}" alt="" loading="lazy">`
        : `<span class="card-thumb-icon">??</span>`;
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
            <span class="card-time">${v.duration ? formatDuration(v.duration) : ''}</span>
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
  return (h > 0 h + ':' : '') + (m < 10 && h > 0 '0' : '') + m + ':' + (s < 10 '0' : '') + s;
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function focusInput() {
  showPage('home');
  setTimeout(() => document.getElementById('main-url-input').focus(), 150);
}

// â”€â”€ Input helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function onMainInput() {
  updateClearBtn();
  const val = document.getElementById('main-url-input').value.trim();
  if (!val) { setHint(''); return; }
  
  // DÃ©tection des types de liens
  if (val.startsWith('{') || val.startsWith('[')) {
    setHint('JSON dÃ©tectÃ© â€” Extraction automatique', 'ok'); return;
  }
  if (val.includes('.m3u8')) {
    setHint('Lien HLS/M3U8 dÃ©tectÃ©', 'ok'); return;
  }
  if (/youtu/.test(val)) {
    setHint('Lien YouTube dÃ©tectÃ©', 'ok'); return;
  }
  if (/tiktok\.com/.test(val)) {
    setHint('VidÃ©o TikTok dÃ©tectÃ©e ðŸ“±', 'ok'); return;
  }
  if (/instagram\.com/.test(val)) {
    setHint('Contenu Instagram dÃ©tectÃ© ðŸ“¸', 'ok'); return;
  }
  if (/twitter\.com|x\.com/.test(val)) {
    setHint('VidÃ©o X / Twitter dÃ©tectÃ©e ðŸ¦', 'ok'); return;
  }
  if (/facebook\.com|fb\.watch/.test(val)) {
    setHint('VidÃ©o Facebook dÃ©tectÃ©e ðŸ‘¥', 'ok'); return;
  }
  
  if (val.length > 10 && !val.startsWith('http')) {
    setHint('L\'URL doit commencer par https://', 'error'); return;
  }
  setHint('Lien prÃªt Ã  Ãªtre analysÃ©', 'info');
}

function clearInput() {
  const inp = document.getElementById('main-url-input');
  if (inp) inp.value = '';
  updateClearBtn(); setHint('');
}

function updateClearBtn() {
  const inp = document.getElementById('main-url-input');
  const btn = document.getElementById('input-clear-btn');
  if (btn) btn.classList.toggle('show', !!(inp.value));
}

function setHint(msg, type = '') {
  const h = document.getElementById('input-hint');
  if (!h) return;
  h.textContent = msg;
  h.className = 'input-hint' + (type ' '+type : '');
}

function isValidInput(s) {
  if (!s) return false;
  if (s.startsWith('{') || s.startsWith('[')) return true; // JSON
  try { return /^https:\/\//.test(new URL(s).href); } catch { return false; }
}

// â”€â”€ Load from home â€“ (at bottom of file) â”€â”€

function retryLoad() {
  const url = Player.currentUrl;
  if (url) Player.load(url).catch(() => {});
}

// â”€â”€ Player actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  toast('URL copiÃ©e dans le tÃ©lÃ©chargeur', 'â†“');
}

function openInTab() {
  const url = Player.currentUrl;
  if (url) window.open(url, '_blank');
}

function copyCurrentUrl() {
  const url = Player.currentUrl;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('âŽ˜ URL copiÃ©e !', 'âŽ˜'));
}

function clearDiag() { Player.clearDiag(); }

// â”€â”€ History rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const m = url.match(/(:youtube\.com\/(:watch\v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m m[1] : null;
  } catch { return null; }
}

function makeCardThumb(h) {
  const ytId = getYtIdFromUrl(h.url);
  if (ytId) return `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`;
  return `<span class="card-thumb-icon">ðŸŽž</span>`;
}

function makeVideoCard(h, showDel = false) {
  const ytId = getYtIdFromUrl(h.url);
  const thumb = ytId
    `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="card-thumb-icon">ðŸŽž</span>`;
  const del = showDel
    `<button class="card-del" onclick="deleteAndRefresh(event,'${esc(h.id)}')" title="Supprimer">âœ•</button>` : '';
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
          <span class="card-method">${esc(h.method||'')}</span>
        </div>
      </div>
    </div>`;
}

async function renderHomeRecent(history) {
  if (!history) history = await API.getHistory();
  const section = document.getElementById('home-recent');
  const row     = document.getElementById('home-cards-row');
  if (!section||!row) return;
  if (!history.length) { section.style.display='none'; return; }
  section.style.display = '';
  row.innerHTML = history.slice(0,10).map(h => makeVideoCard(h)).join('');
}

function renderSidebarHistory(history) {
  const el = document.getElementById('sidebar-history');
  if (!el) return;
  if (!history.length) { el.innerHTML='<div class="diag-empty">Aucune vidÃ©o.</div>'; return; }
  el.innerHTML = history.slice(0,12).map(h => {
    const ytId = getYtIdFromUrl(h.url);
    const thumb = ytId
      `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<span class="sh-thumb-icon">ðŸŽž</span>`;
    return `<div class="sh-item" onclick="replayFromHistory('${esc(h.url)}')">
      <div class="sh-thumb">${thumb}</div>
      <div class="sh-info">
        <div class="sh-domain">${esc(getDomain(h.url))}</div>
        <div class="sh-time">${esc(h.method)} Â· ${esc(h.date)}</div>
      </div>
      <button class="sh-del" onclick="deleteAndRefresh(event,'${esc(h.id)}')" title="Supprimer">âœ•</button>
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
    history.filter(h => h.url.toLowerCase().includes(_libFilter) || (h.title||'').toLowerCase().includes(_libFilter))
    : history;
  if (!filtered.length) {
    grid.innerHTML = `<div class="lib-empty">
      <div class="lib-empty-icon">ðŸŽž</div>
      <p>${_libFilter 'Aucun rÃ©sultat pour "'+esc(_libFilter)+'"' : 'Aucune vidÃ©o dans l\'historique'}</p>
      <button class="btn-primary" onclick="showPage('home')">Ajouter une vidÃ©o</button>
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
    toast('â–¶ Relecture', 'âœ“');
  } catch { toast('Lecture impossible', 'âœ—'); }
}

async function deleteAndRefresh(e, id) {
  e.stopPropagation();
  await API.deleteHistory(id);
  await refreshAllHistory();
  if (document.getElementById('page-library').classList.contains('active'))
    renderLibrary(_allHistory);
  toast('SupprimÃ©', 'ðŸ—‘');
}

async function clearAllHistory() {
  if (!confirm('Effacer tout l\'historique ')) return;
  const history = await API.getHistory();
  for (const h of history) await API.deleteHistory(h.id);
  _allHistory = [];
  await refreshAllHistory();
  renderLibrary([]);
  toast('Historique effacÃ©', 'âœ“');
}

// â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _toastTimer;
function toast(msg, icon = 'âœ“') {
  const el = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  document.getElementById('toast-icon').textContent = icon;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// â”€â”€ Intercept polling (from extension) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
setInterval(async () => {
  try {
    const res  = await fetch('/api/intercept/latest');
    const data = await res.json();
    if (data.url) {
      document.getElementById('main-url-input').value    = data.url;
      document.getElementById('sidebar-url-input').value = data.url;
      showPage('player');
      document.getElementById('nav-player-li').style.display = 'block';
      setTimeout(async () => {
        try {
          await Player.load(data.url);
          await refreshAllHistory();
          toast('â–¶ VidÃ©o reÃ§ue via extension', 'ðŸ”Œ');
        } catch { toast('Extension: lecture impossible', 'âœ—'); }
      }, 100);
    }
  } catch {}
}, 2000);

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('DOMContentLoaded', async () => {
  const inp = document.getElementById('main-url-input');
  if (inp) {
    inp.addEventListener('paste', () => setTimeout(() => { updateClearBtn(); onMainInput(); }, 50));
    inp.addEventListener('keydown', e => { if (e.key==='Enter') loadFromHome(); });
    onMainInput(); // Initialisation
  }
  
  refreshAllHistory();
  
  // Polling des tÃ©lÃ©chargements actifs
  setInterval(refreshDlList, 5000);
});

// â”€â”€ Playlist auto-detection on load â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// After player loads, check if URL is a playlist
const _origPlayerLoad = Player.load.bind(Player);
// We hook into showPage to trigger playlist load
const _origShowPage = showPage;

// Override loadFromHome to also load playlist
async function loadFromHome() {
  const url = document.getElementById('main-url-input').value.trim();
  if (!url) { setHint('Colle un lien ou JSON', 'error'); return; }
  if (!isValidInput(url)) { setHint('URL invalide', 'error'); return; }

  setHint('Chargementâ€¦', 'info');
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
      (url.includes('youtube.com') && !url.includes('watchv=') && !url.includes('youtu.be'));

    if (isPlaylistUrl) {
      // For playlists: load playlist first, then play first item
      setHint('DÃ©tection playlistâ€¦', 'info');
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
    toast('â–¶ Lecture dÃ©marrÃ©e', 'âœ“');
  } catch {
    showPage('home');
    setHint('Impossible de lire. VÃ©rifie le lien.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadFromSidebar() {
  const url = document.getElementById('sidebar-url-input').value.trim();
  if (!url || !isValidInput(url)) { toast('Lien invalide', 'âš '); return; }
  window._playlist=null; window._playlistIdx=-1;
  hideNextBar();
  const pb=document.getElementById('playlist-block'); if(pb) pb.style.display='none';
  try {
    await Player.load(url);
    await refreshAllHistory();
    await renderSidebarQueue();
    toast('â–¶ Nouvelle vidÃ©o', 'âœ“');
    loadPlaylist(url).catch(()=>{});
  } catch { toast('Lecture impossible', 'âœ—'); }
}

// â”€â”€ Collections page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// showPage already calls loadCollections() when page=collections via the page handler
