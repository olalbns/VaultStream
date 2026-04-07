/**
 * StreamVault Extension — Popup Script
 */

let svUrl   = 'http://localhost:5000';
let videos  = [];
let tabId   = null;

// ── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Charger config
  const cfg = await msg({ type: 'GET_CONFIG' });
  svUrl = cfg.svUrl || 'http://localhost:5000';
  document.getElementById('sv-url-input').value  = svUrl;
  document.getElementById('toggle-auto').checked  = cfg.autoSend !== false;
  document.getElementById('toggle-notif').checked = cfg.notifyEnabled !== false;

  // Vérifier le serveur
  checkServer();

  // Charger les vidéos détectées
  const res = await msg({ type: 'GET_VIDEOS' });
  videos = res.videos || [];
  tabId  = res.tabId;
  renderVideos();

  // Écouter les nouvelles détections
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'VIDEO_DETECTED' && m.tabId === tabId) {
      videos.push(m.entry);
      renderVideos();
    }
  });
});

// ── Tab switching ────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
}

// ── Server check ─────────────────────────────────────────
async function checkServer() {
  const dot   = document.getElementById('server-dot');
  const label = document.getElementById('server-label');
  try {
    const res = await fetch(`${svUrl}/api/history`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      dot.className   = 'dot ok';
      label.textContent = 'Connecté';
      setStatus('Serveur StreamVault actif ✓');
    } else throw new Error();
  } catch {
    dot.className   = 'dot fail';
    label.textContent = 'Hors ligne';
    setStatus('StreamVault hors ligne — lance python server.py');
  }
}

// ── Render videos ─────────────────────────────────────────
function renderVideos() {
  const list  = document.getElementById('video-list');
  const badge = document.getElementById('count-badge');

  badge.textContent = videos.length > 0 ` (${videos.length})` : '';

  if (!videos.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🎬</div>
        Navigue sur une page vidéo.<br>Les liens seront détectés automatiquement.
      </div>`;
    return;
  }

  list.innerHTML = [...videos].reverse().map((v, i) => {
    const ri  = videos.length - 1 - i;
    const url = v.url || v;
    let domain = url;
    try { domain = new URL(url).hostname; } catch {}
    const ago = v.ts Math.round((Date.now() - v.ts) / 1000) + 's' : '';

    return `
      <div class="video-item" onclick="sendVideo(${ri})">
        <div class="vi-icon">🎞</div>
        <div class="vi-body">
          <div class="vi-url" title="${esc(url)}">${esc(domain)}</div>
          <div class="vi-meta">${esc(url.slice(0, 50))}… ${ago '· ' + ago : ''}</div>
        </div>
        <button class="vi-btn ${v.sent 'sent' : ''}" id="vbtn-${ri}"
          onclick="event.stopPropagation();sendVideo(${ri})">
          ${v.sent '✓' : '▶ Lire'}
        </button>
      </div>`;
  }).join('');
}

// ── Send video to StreamVault ────────────────────────────
async function sendVideo(idx) {
  const v = videos[idx];
  if (!v) return;

  const btn = document.getElementById(`vbtn-${idx}`);
  if (btn) btn.textContent = '…';

  const res = await msg({
    type:  'SEND_VIDEO',
    entry: { url: v.url || v, headers: v.headers || {}, referer: v.referer || '' },
  });

  if (res.ok) {
    videos[idx].sent = true;
    renderVideos();
    setStatus('▶ Envoyé à StreamVault');
    // Ouvrir StreamVault
    setTimeout(() => openSV(), 300);
  } else {
    setStatus('Erreur : ' + (res.error || 'impossible d\'envoyer'));
  }
}

// ── Manual send ──────────────────────────────────────────
async function sendManual() {
  const url = document.getElementById('manual-url').value.trim();
  if (!url) return;

  setStatus('Envoi…');
  const res = await msg({ type: 'SEND_URL_MANUAL', url, referer: '' });
  if (res.ok) {
    setStatus('▶ Envoyé à StreamVault');
    setTimeout(() => openSV(), 300);
  } else {
    setStatus('Erreur : ' + (res.error || ''));
  }
}

async function sendPage() {
  const url = document.getElementById('manual-page').value.trim();
  if (!url) return;
  setStatus('Envoi page…');
  const res = await msg({ type: 'SEND_URL_MANUAL', url, referer: url });
  if (res.ok) {
    setStatus('▶ Page envoyée à StreamVault');
    setTimeout(() => openSV(), 300);
  } else {
    setStatus('Erreur : ' + (res.error || ''));
  }
}

// ── Config save ──────────────────────────────────────────
async function saveConfig() {
  svUrl = document.getElementById('sv-url-input').value.trim() || 'http://localhost:5000';
  await msg({
    type:           'SET_CONFIG',
    svUrl:          svUrl,
    autoSend:       document.getElementById('toggle-auto').checked,
    notifyEnabled:  document.getElementById('toggle-notif').checked,
  });
  checkServer();
  setStatus('Paramètres sauvegardés ✓');
}

// ── Open SV ──────────────────────────────────────────────
function openSV() {
  chrome.tabs.create({ url: svUrl });
}

// ── Clear ────────────────────────────────────────────────
async function clearDetected() {
  await msg({ type: 'CLEAR_VIDEOS' });
  videos = [];
  renderVideos();
  setStatus('Liste effacée');
}

// ── Helpers ──────────────────────────────────────────────
function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function msg(data) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(data, (res) => resolve(res || {}));
  });
}
