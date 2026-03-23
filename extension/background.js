/**
 * StreamVault Extension — Background Service Worker
 *
 * Fonctionne exactement comme IDM :
 *  1. Écoute TOUTES les requêtes réseau du navigateur (webRequest)
 *  2. Filtre celles qui ressemblent à des vidéos
 *  3. Capture les headers complets (cookies, referer, token...)
 *  4. Les envoie à StreamVault via localhost:5000
 */

// ── Configuration ──────────────────────────────────────
const DEFAULT_SV_URL = "http://localhost:5000";

// Extensions et types MIME vidéo à intercepter
const VIDEO_EXTENSIONS = [
  '.mp4', '.webm', '.mkv', '.m4v', '.ogv', '.ogg',
  '.mov', '.avi', '.flv', '.wmv', '.ts', '.m2ts',
  '.m3u8', '.mpd',
];

const VIDEO_MIME_TYPES = [
  'video/', 'application/vnd.apple.mpegurl',
  'application/x-mpegurl', 'application/dash+xml',
];

// Patterns d'URL CDN/streaming connus
const CDN_PATTERNS = [
  /\.(mp4|webm|mkv|m4v|ogv|ts|m3u8|mpd)(\?|#|$)/i,
  /\/(resource|stream|video|media|cdn|vod|hls|bt)\//i,
  /[?&](sign|token|t|expires|key|auth)=[a-f0-9]+/i,
];

// Domaines à ignorer (analytics, pubs, etc.)
const IGNORE_DOMAINS = [
  'google-analytics.com', 'doubleclick.net', 'facebook.com',
  'twitter.com', 'googleapis.com', 'gstatic.com', 'youtube.com',
  'googlevideo.com', // YouTube gère ses propres embeds
];

// ── État ───────────────────────────────────────────────
let svUrl          = DEFAULT_SV_URL;
let detectedVideos = {}; // tabId → [{url, headers, ts, referer}]
let autoSend       = true;
let notifyEnabled  = true;

// Charger la config sauvegardée
chrome.storage.local.get(['svUrl', 'autoSend', 'notifyEnabled'], (data) => {
  if (data.svUrl)          svUrl          = data.svUrl;
  if (data.autoSend       !== undefined) autoSend       = data.autoSend;
  if (data.notifyEnabled  !== undefined) notifyEnabled  = data.notifyEnabled;
});

// ── webRequest — intercepte les requêtes ───────────────
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const url = details.url;

    // Ignorer les requêtes non-video et les domaines blacklistés
    if (!isVideoUrl(url)) return;
    if (isIgnoredDomain(url)) return;
    if (details.type === 'main_frame') return; // Pas les navigations de page

    // Reconstruire les headers sous forme d'objet
    const headers = {};
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        headers[h.name] = h.value;
      }
    }

    const entry = {
      url:      url,
      headers:  headers,
      referer:  headers['Referer'] || headers['referer'] || '',
      tabId:    details.tabId,
      ts:       Date.now(),
      sent:     false,
    };

    // Stocker par tab
    if (!detectedVideos[details.tabId]) {
      detectedVideos[details.tabId] = [];
    }

    // Dédupliquer (même URL dans les 10 dernières secondes)
    const existing = detectedVideos[details.tabId];
    const isDup = existing.some(e => e.url === url && (Date.now() - e.ts) < 10000);
    if (isDup) return;

    existing.push(entry);
    // Garder max 20 par tab
    if (existing.length > 20) existing.shift();

    console.log(`[SV] Vidéo détectée : ${url.slice(0, 80)}`);

    // Mettre à jour le badge
    updateBadge(details.tabId);

    // Notifier le popup
    chrome.runtime.sendMessage({
      type:  'VIDEO_DETECTED',
      entry: { url, referer: entry.referer, ts: entry.ts },
      tabId: details.tabId,
    }).catch(() => {}); // Popup peut ne pas être ouvert

    // Auto-envoi si activé
    if (autoSend) {
      sendToStreamVault(entry);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// ── Nettoyage quand on ferme un tab ────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedVideos[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // Nouvelle navigation — reset les vidéos détectées
    detectedVideos[tabId] = [];
    updateBadge(tabId);
  }
});

// ── Fonctions utilitaires ──────────────────────────────
function isVideoUrl(url) {
  try {
    const u     = new URL(url);
    const path  = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    const full  = (path + query).toLowerCase();

    // Extension vidéo dans le path
    if (VIDEO_EXTENSIONS.some(ext => path.endsWith(ext))) return true;

    // Pattern CDN/streaming
    if (CDN_PATTERNS.some(p => p.test(url))) return true;

    return false;
  } catch {
    return false;
  }
}

function isIgnoredDomain(url) {
  try {
    const host = new URL(url).hostname;
    return IGNORE_DOMAINS.some(d => host.includes(d));
  } catch { return false; }
}

function updateBadge(tabId) {
  const count = (detectedVideos[tabId] || []).length;
  chrome.action.setBadgeText({
    text:  count > 0 ? String(count) : '',
    tabId: tabId,
  });
  chrome.action.setBadgeBackgroundColor({ color: '#e5091a' });
}

// ── Envoi à StreamVault ────────────────────────────────
async function sendToStreamVault(entry) {
  try {
    const body = JSON.stringify({
      url:     entry.url,
      headers: entry.headers,
      referer: entry.referer,
    });

    const res = await fetch(`${svUrl}/api/intercept`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    body,
    });

    if (res.ok) {
      entry.sent = true;
      console.log(`[SV] Envoyé → ${entry.url.slice(0, 60)}`);

      if (notifyEnabled) {
        showNotification(entry.url);
      }

      // Ouvrir StreamVault si pas déjà ouvert
      openStreamVault(entry.url);
    }
  } catch (e) {
    console.warn(`[SV] Impossible d'envoyer à StreamVault (serveur démarré ?) : ${e.message}`);
  }
}

function showNotification(url) {
  let domain = url;
  try { domain = new URL(url).hostname; } catch {}

  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title:   'StreamVault — Vidéo détectée',
    message: `Lecture lancée depuis ${domain}`,
  });
}

async function openStreamVault(videoUrl) {
  try {
    // Chercher si un onglet StreamVault est déjà ouvert
    const tabs = await chrome.tabs.query({ url: `${svUrl}/*` });
    if (tabs.length > 0) {
      // Recharger avec la nouvelle URL
      await chrome.tabs.update(tabs[0].id, { active: true });
    }
    // StreamVault s'actualisera via le push (voir /api/intercept)
  } catch {}
}

// ── Messages depuis le popup ───────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'GET_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      sendResponse({
        videos: detectedVideos[tabId] || [],
        tabId:  tabId,
      });
    });
    return true; // async
  }

  if (msg.type === 'SEND_VIDEO') {
    sendToStreamVault(msg.entry)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'SEND_URL_MANUAL') {
    // Envoi manuel depuis le popup (URL tapée à la main)
    const entry = {
      url:     msg.url,
      headers: {},
      referer: msg.referer || '',
      ts:      Date.now(),
    };
    sendToStreamVault(entry)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'SET_CONFIG') {
    if (msg.svUrl !== undefined) {
      svUrl = msg.svUrl;
      chrome.storage.local.set({ svUrl });
    }
    if (msg.autoSend !== undefined) {
      autoSend = msg.autoSend;
      chrome.storage.local.set({ autoSend });
    }
    if (msg.notifyEnabled !== undefined) {
      notifyEnabled = msg.notifyEnabled;
      chrome.storage.local.set({ notifyEnabled });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_CONFIG') {
    sendResponse({ svUrl, autoSend, notifyEnabled });
    return true;
  }

  if (msg.type === 'CLEAR_VIDEOS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        detectedVideos[tabId] = [];
        updateBadge(tabId);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});
