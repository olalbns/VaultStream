/**
 * StreamVault — Queue de lecture
 */

let _queue = [];
let _queueIdx = -1;

async function loadQueue() {
  try {
    const res = await fetch('/api/queue');
    _queue = await res.json();
    renderQueue();
    updateQueueIndicator();
  } catch {}
}

async function addToQueueManual() {
  const inp = document.getElementById('queue-url-input');
  const url = inp?.value.trim();
  if (!url) return;
  await queueAction('add', { item: { url, title: url } });
  if (inp) inp.value = '';
  toast('Ajouté à la queue', '≡');
}

async function addCurrentToQueue() {
  const url = Player.currentUrl;
  if (!url) { toast('Aucune vidéo en cours', '⚠'); return; }
  await queueAction('add', { item: { url, title: url } });
  toast('Ajouté à la queue', '≡');
}

// Called from player page "add to queue" button
function addToQueue() { addCurrentToQueue(); }

async function playNextQueue() {
  const pending = _queue.filter(q => !q.played);
  if (!pending.length) { toast('Queue vide', '⚠'); return; }
  const next = pending[0];
  await queueAction('played', { id: next.id });
  showPage('player');
  document.getElementById('nav-player-li').style.display = 'block';
  await Player.load(next.url);
  toast(`▶ ${getDomain(next.url)}`, '≡');
}

async function shuffleQueue() {
  if (!_queue.length) return;
  const shuffled = [..._queue].sort(() => Math.random() - 0.5);
  const ids = shuffled.map(q => q.id);
  await queueAction('reorder', { ids });
  toast('Queue mélangée', '⇌');
}

async function clearQueue() {
  if (!confirm('Vider la queue ?')) return;
  await queueAction('clear');
  toast('Queue vidée', '✓');
}

async function removeFromQueue(id) {
  await queueAction('remove', { id });
}

async function playQueueItem(id) {
  const item = _queue.find(q => q.id === id);
  if (!item) return;
  await queueAction('played', { id });
  showPage('player');
  document.getElementById('nav-player-li').style.display = 'block';
  await Player.load(item.url);
}

async function queueAction(action, extra = {}) {
  try {
    const res = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    _queue = data.queue || [];
    renderQueue();
    updateQueueIndicator();
  } catch (e) {
    console.error('Queue error:', e);
  }
}

function renderQueue() {
  const list  = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  if (!list) return;

  if (!_queue.length) {
    if (empty) empty.style.display = '';
    list.innerHTML = '';
    list.appendChild(empty || document.createElement('div'));
    return;
  }

  if (empty) empty.style.display = 'none';

  list.innerHTML = _queue.map((q, i) => `
    <div class="queue-item ${q.played ? 'played' : ''}" id="qi-${q.id}">
      <div class="qi-num">${i + 1}</div>
      <div class="qi-icon">${q.played ? '✓' : '🎞'}</div>
      <div class="qi-info">
        <div class="qi-title">${esc(getDomain(q.url))}</div>
        <div class="qi-url">${esc(q.url)}</div>
      </div>
      <div class="qi-actions">
        <button class="btn-primary" style="font-size:11px;padding:6px 12px"
          onclick="playQueueItem('${q.id}')">▶</button>
        <button class="btn-ghost" style="font-size:11px;padding:6px 10px"
          onclick="removeFromQueue('${q.id}')">✕</button>
      </div>
    </div>`).join('');
}

function updateQueueIndicator() {
  const pending = _queue.filter(q => !q.played).length;
  const ind = document.getElementById('queue-indicator');
  const cnt = document.getElementById('queue-count');
  if (!ind) return;
  ind.style.display = pending > 0 ? 'flex' : 'none';
  if (cnt) cnt.textContent = pending;
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url.slice(0, 40); }
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;');
}

// Load queue on startup
document.addEventListener('DOMContentLoaded', loadQueue);
