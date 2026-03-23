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

  // Scan initial
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanVideos);
  } else {
    scanVideos();
  }

  // Re-scan après un délai (pour les vidéos chargées en JS)
  setTimeout(scanVideos, 2000);
  setTimeout(scanVideos, 5000);

})();
