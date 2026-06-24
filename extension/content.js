/**
 * StreamVault Extension — Content Script
 *
 * Tourne dans chaque page web.
 * Détecte les éléments <video> et les sources vidéo dans le DOM.
 * Complément à webRequest pour les vidéos chargées via JS.
 */

(function () {
  'use strict';

  // Éviter double injection
  if (window.__svDetectorActive) return;
  window.__svDetectorActive = true;

  const found = new Set();

  function reportUrl(url, referer) {
    if (!url || found.has(url)) return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;

    try { new URL(url); } catch { return; }

    found.add(url);

    chrome.runtime.sendMessage({
      type:    'VIDEO_DETECTED_DOM',
      url:     url,
      referer: referer || window.location.href,
    }).catch(() => {});
  }

  // ── Scanner les éléments <video> ──────────────────────
  function scanVideos() {
    document.querySelectorAll('video').forEach(v => {
      if (v.src && !v.src.startsWith('blob:')) reportUrl(v.src, window.location.href);
      v.querySelectorAll('source').forEach(s => {
        if (s.src) reportUrl(s.src, window.location.href);
      });
      // currentSrc (URL réelle après sélection du format)
      if (v.currentSrc && !v.currentSrc.startsWith('blob:')) {
        reportUrl(v.currentSrc, window.location.href);
      }
    });
  }

  // ── Observer les changements DOM ──────────────────────
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO') {
          if (node.src) reportUrl(node.src, window.location.href);
          if (node.currentSrc) reportUrl(node.currentSrc, window.location.href);
        }
        // Chercher dans les enfants aussi
        node.querySelectorAll?.('video').forEach(v => {
          if (v.src) reportUrl(v.src, window.location.href);
          if (v.currentSrc) reportUrl(v.currentSrc, window.location.href);
        });
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true, subtree: true,
  });

  // ── Injection de boutons ─────────────────────────────
  function injectButtons() {
    const host = window.location.hostname;

    if (host.includes('youtube.com')) {
      const v = document.querySelector('.ytd-video-primary-info-renderer');
      if (v && !document.getElementById('sv-yt-btn')) {
        const btn = document.createElement('button');
        btn.id = 'sv-yt-btn';
        btn.innerText = '▶ StreamVault';
        btn.style.cssText = 'background:#f00;color:#fff;border:none;padding:10px 20px;border-radius:2px;font-weight:bold;cursor:pointer;margin:10px;';
        btn.onclick = () => reportUrl(window.location.href);
        v.appendChild(btn);
      }
    }

    // Generic detector for video players
    document.querySelectorAll('video').forEach(v => {
      const container = v.parentElement;
      if (container && !container.querySelector('.sv-inject-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sv-inject-btn';
        btn.innerText = '🎬 StreamVault';
        btn.style.cssText = 'position:absolute;top:10px;right:10px;z-index:9999;background:rgba(0,0,0,0.7);color:#0ff;border:1px solid #0ff;padding:5px 10px;border-radius:4px;font-size:12px;cursor:pointer;';
        btn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          reportUrl(window.location.href);
        };
        container.style.position = 'relative';
        container.appendChild(btn);
      }
    });
  }

  // Scan initial
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { scanVideos(); injectButtons(); });
  } else {
    scanVideos();
    injectButtons();
  }

  // Re-scan après un délai (pour les vidéos chargées en JS)
  setTimeout(scanVideos, 2000);
  setTimeout(scanVideos, 5000);

})();
