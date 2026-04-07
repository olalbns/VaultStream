/**
 * StreamVault — Collections v1
 * Dossiers/playlists persistants pour organiser les vidéos
 */

let _collections = [];
let _currentColId = null;
let _currentCol   = null;
let _editingColId = null;
let _pendingItems = null; // items to add after creating collection

// ── Load ──────────────────────────────────────────────
async function loadCollections() {
  try {
    const res = await fetch('/api/collections');
    _collections = await res.json();
    renderCollectionGrid();
  } catch {}
}

// ── Grid view ─────────────────────────────────────────
function renderCollectionGrid() {
  const grid  = document.getElementById('col-grid');
  const empty = document.getElementById('col-empty');
  if (!grid) return;

  if (!_collections.length) {
    grid.innerHTML = '';
    if (empty) grid.appendChild(empty);
    return;
  }
  if (empty) empty.remove();

  grid.innerHTML = _collections.map(col => `
    <div class="col-card" onclick="openCollection('${col.id}')">
      <div class="col-card-top" style="background:${col.color}22;border-bottom:2px solid ${col.color}44">
        <span style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3))">${col.icon||'🎬'}</span>
        <span class="col-card-count">${col.count} vidéo${col.count!==1?'s':''}</span>
      </div>
      <div class="col-card-body">
        <div class="col-card-name">${esc(col.name)}</div>
        <div class="col-card-desc">${esc(col.description||'')}</div>
      </div>
      <div class="col-card-actions" onclick="event.stopPropagation()">
        <button class="btn-tiny" onclick="playCollectionById('${col.id}')">▶ Lire</button>
        <button class="btn-tiny" onclick="addColToQueueById('${col.id}')">+ Queue</button>
        <button class="btn-tiny" onclick="editCollectionById('${col.id}')">✏</button>
        <button class="btn-tiny" style="color:var(--muted)" onclick="deleteCollectionById('${col.id}')">🗑</button>
      </div>
    </div>`).join('');
}

// ── Detail view ───────────────────────────────────────
async function openCollection(id) {
  try {
    const res = await fetch(`/api/collections?id=${id}`);
    _currentCol   = await res.json();
    _currentColId = id;

    document.getElementById('col-list-view').style.display   = 'none';
    document.getElementById('col-detail-view').style.display = '';
    document.getElementById('col-detail-icon').textContent   = _currentCol.icon || '🎬';
    document.getElementById('col-detail-name').textContent   = _currentCol.name;
    document.getElementById('col-detail-meta').textContent   =
      `${_currentCol.items?.length||0} vidéo${(_currentCol.items?.length||0)!==1?'s':''} · Créée le ${fmtDate(_currentCol.created)}`;

    renderColDetail(_currentCol);
  } catch(e) { toast('Erreur chargement collection','✗'); }
}

function closeCollectionDetail() {
  _currentColId = null; _currentCol = null;
  document.getElementById('col-list-view').style.display   = '';
  document.getElementById('col-detail-view').style.display = 'none';
  loadCollections();
}

function renderColDetail(col) {
  const grid = document.getElementById('col-detail-grid');
  if (!grid) return;
  if (!col.items?.length) {
    grid.innerHTML = `<div class="lib-empty">
      <div class="lib-empty-icon">🎬</div>
      <p>Aucune vidéo dans cette collection</p>
    </div>`; return;
  }

  grid.innerHTML = col.items.map(item => {
    const ytId = getYtId(item.url);
    const thumb = ytId
      ? `<img src="https://img.youtube.com/vi/${ytId}/mqdefault.jpg" loading="lazy" onerror="this.style.display='none'">`
      : (item.thumbnail ? `<img src="${item.thumbnail}" loading="lazy" onerror="this.style.display='none'">` : `<span class="card-thumb-icon">🎞</span>`);
    return `
      <div class="video-card" onclick="playFromCollection('${esc(item.url)}')">
        <div class="card-thumb" style="position:relative">
          ${thumb}
          <div class="card-play-hover">
            <div class="play-circle-sm">
              <svg viewBox="0 0 24 24" fill="white" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <button class="col-detail-card-del"
            onclick="event.stopPropagation();removeFromCol('${esc(_currentColId)}','${esc(item.id)}')"
            title="Retirer">✕</button>
        </div>
        <div class="card-body">
          <div class="card-domain">${esc(getDomain(item.url))}</div>
          <div class="card-meta">
            <span class="card-time">${item.title ? esc(item.title.slice(0,30)) : ''}</span>
            ${item.duration ? `<span class="card-method">${fmtDur(item.duration)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

async function addToCurrentCollection() {
  const inp = document.getElementById('col-add-url');
  const url = inp?.value.trim();
  if (!url || !_currentColId) return;

  let title = url;
  try { title = new URL(url).hostname; } catch {}

  await colAction('add_item', {
    col_id: _currentColId,
    item: { url, title },
  });
  if (inp) inp.value = '';
  toast('Ajouté à la collection', '✓');
}

async function removeFromCol(colId, itemId) {
  await colAction('remove_item', { col_id: colId, item_id: itemId });
  // Refresh detail
  if (_currentColId === colId) openCollection(colId);
}

// ── Collection actions ────────────────────────────────
async function playFromCollection(url) {
  showPage('player');
  document.getElementById('nav-player-li').style.display = 'block';
  await Player.load(url);
}

async function playCollectionAll() {
  if (!_currentCol?.items?.length) return;
  // Add all to queue then play first
  for (const item of _currentCol.items) {
    await fetch('/api/queue', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'add', item: { url:item.url, title:item.title||item.url } })
    });
  }
  await loadQueue();
  playNextQueue();
}

async function playCollectionById(id) {
  const res = await fetch(`/api/collections?id=${id}`);
  const col = await res.json();
  if (!col?.items?.[0]) return;
  showPage('player');
  document.getElementById('nav-player-li').style.display = 'block';
  await Player.load(col.items[0].url);
  toast(`▶ ${col.name}`, '🎬');
}

async function addCollectionToQueue() {
  if (!_currentCol?.items?.length) return;
  for (const item of _currentCol.items) {
    await fetch('/api/queue', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'add', item:{ url:item.url, title:item.title||item.url } })
    });
  }
  await loadQueue();
  toast(`${_currentCol.items.length} vidéo(s) ajoutée(s) à la queue`, '≡');
}

async function addColToQueueById(id) {
  const res = await fetch(`/api/collections?id=${id}`);
  const col = await res.json();
  if (!col?.items?.length) return;
  for (const item of col.items) {
    await fetch('/api/queue', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'add', item:{ url:item.url, title:item.title||item.url } })
    });
  }
  await loadQueue();
  toast(`${col.items.length} vidéo(s) → Queue`, '≡');
}

async function dlCollectionAll() {
  if (!_currentCol?.items?.length) return;
  const urls = _currentCol.items.map(i => i.url);
  await fetch('/api/ytdl/download/batch', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ urls, format_id:'best', ext:'mp4' }),
  });
  toast(`${urls.length} téléchargements lancés`, '↓');
  showPage('downloader');
  setTimeout(refreshDlList, 500);
}

// ── Create / Edit / Delete ────────────────────────────
function openCreateCollection(pendingItems) {
  _editingColId = null;
  _pendingItems = pendingItems || null;
  document.getElementById('modal-col-title').textContent = 'Nouvelle collection';
  document.getElementById('col-form-name').value  = '';
  document.getElementById('col-form-desc').value  = '';
  document.getElementById('col-form-icon').value  = '🎬';
  document.getElementById('col-form-color').value = '#e5091a';
  document.querySelectorAll('.cp-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.cp-btn[data-color="#e5091a"]')?.classList.add('active');
  openModal('modal-collection');
}

function editCollectionModal() {
  if (!_currentCol) return;
  editCollectionById(_currentColId);
}

async function editCollectionById(id) {
  const res = await fetch(`/api/collections?id=${id}`);
  const col = await res.json();
  _editingColId = id;
  document.getElementById('modal-col-title').textContent = 'Modifier la collection';
  document.getElementById('col-form-name').value  = col.name || '';
  document.getElementById('col-form-desc').value  = col.description || '';
  document.getElementById('col-form-icon').value  = col.icon || '🎬';
  document.getElementById('col-form-color').value = col.color || '#e5091a';
  document.querySelectorAll('.cp-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.color === col.color));
  openModal('modal-collection');
}

async function submitCollectionForm() {
  const name  = document.getElementById('col-form-name').value.trim();
  const desc  = document.getElementById('col-form-desc').value.trim();
  const icon  = document.getElementById('col-form-icon').value.trim() || '🎬';
  const color = document.getElementById('col-form-color').value || '#e5091a';
  if (!name) { toast('Donne un nom à la collection', '⚠'); return; }

  if (_editingColId) {
    await colAction('update', { id:_editingColId, name, description:desc, icon, color });
    toast('Collection modifiée', '✓');
    if (_currentColId === _editingColId) {
      document.getElementById('col-detail-icon').textContent = icon;
      document.getElementById('col-detail-name').textContent = name;
    }
  } else {
    const res  = await fetch('/api/collections', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'create', name, description:desc, icon, color }),
    });
    const data = await res.json();
    toast('Collection créée', '✓');

    // If we have pending items to add
    if (_pendingItems?.length && data.id) {
      await fetch('/api/collections', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'add_items', col_id:data.id, items:_pendingItems }),
      });
      toast(`${_pendingItems.length} vidéo(s) ajoutée(s)`, '✓');
    }
  }

  closeModal('modal-collection');
  await loadCollections();
  _editingColId = null; _pendingItems = null;
}

async function deleteCurrentCollection() {
  if (!_currentColId || !confirm(`Supprimer "${_currentCol?.name}" ?`)) return;
  await deleteCollectionById(_currentColId);
  closeCollectionDetail();
}

async function deleteCollectionById(id) {
  const col = _collections.find(c => c.id === id);
  if (!confirm(`Supprimer "${col?.name||id}" ?`)) return;
  await colAction('delete', { id });
  await loadCollections();
  toast('Collection supprimée', '🗑');
}

// ── Add to collection modal ───────────────────────────
function openAddToColModal(items) {
  _pendingItems = items;
  const list = document.getElementById('add-to-col-list');
  if (!list) return;

  if (!_collections.length) {
    list.innerHTML = '<div class="diag-empty">Aucune collection. Crée-en une.</div>';
  } else {
    list.innerHTML = _collections.map(col => `
      <div class="add-to-col-item" onclick="addItemsToExistingCol('${col.id}')">
        <div class="add-to-col-icon">${col.icon||'🎬'}</div>
        <div class="add-to-col-info">
          <div class="add-to-col-name">${esc(col.name)}</div>
          <div class="add-to-col-count">${col.count} vidéo${col.count!==1?'s':''}</div>
        </div>
      </div>`).join('');
  }
  openModal('modal-add-to-col');
}

async function addItemsToExistingCol(colId) {
  if (!_pendingItems?.length) return;
  const res = await fetch('/api/collections', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'add_items', col_id:colId, items:_pendingItems }),
  });
  const data = await res.json();
  closeModal('modal-add-to-col');
  toast(`${data.added||0} vidéo(s) ajoutée(s)`, '✓');
  _pendingItems = null;
  await loadCollections();
}

// From queue page
async function saveQueueAsCollection() {
  const res = await fetch('/api/queue');
  const queue = await res.json();
  if (!queue.length) { toast('Queue vide', '⚠'); return; }
  const items = queue.map(q => ({ url:q.url, title:q.title||q.url }));
  openCreateCollection(items);
  showPage('collections');
}

// From player playlist panel
function addPlaylistToCollection() {
  if (typeof _playlist !== 'undefined' && _playlist?.items?.length) {
    const items = _playlist.items.map(i => ({ url:i.url, title:i.title }));
    loadCollections().then(() => openAddToColModal(items));
  }
}

// From downloader playlist section
function addPlaylistToColl() {
  const items = getSelectedPlaylistItems();
  if (!items.length) { toast('Aucun élément sélectionné', '⚠'); return; }
  loadCollections().then(() => openAddToColModal(items));
}

// ── API helper ────────────────────────────────────────
async function colAction(action, data = {}) {
  const res = await fetch('/api/collections', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action, ...data }),
  });
  return res.json();
}

// ── Modal helpers ─────────────────────────────────────
function openModal(id)  { document.getElementById(id).style.display='flex'; }
function closeModal(id) { document.getElementById(id).style.display='none'; }

function setColColor(color, btn) {
  document.getElementById('col-form-color').value = color;
  document.querySelectorAll('.cp-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Init icon picker clicks
document.addEventListener('DOMContentLoaded', () => {
  const picker = document.getElementById('icon-picker');
  if (picker) {
    // Convert text to clickable spans
    const icons = picker.textContent.trim().split(/\s+/);
    picker.innerHTML = icons.map(i =>
      `<span onclick="document.getElementById('col-form-icon').value='${i}';this.parentElement.querySelectorAll('span').forEach(s=>s.style.background='');this.style.background='var(--s3)'">${i}</span>`
    ).join('');
  }
  loadCollections();
});

// ── Shared utils ──────────────────────────────────────
function getYtId(url) {
  try {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  } catch { return null; }
}

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.',''); } catch { return url.slice(0,40); }
}

function fmtDur(s) {
  if (!s) return '';
  const m=Math.floor(s/60), sec=s%60;
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts*1000).toLocaleDateString('fr-FR',{day:'2-digit',month:'short',year:'numeric'});
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
