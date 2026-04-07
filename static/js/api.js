/**
 * StreamVault — API Client
 * Toute la communication avec le serveur Python
 */

const API = {
  BASE: window.location.origin,

  /**
   * Probe une URL — vérifie accessibilité + métadonnées
   * @returns {Promise<{ok, status, content_type, content_length, seekable, error}>}
   */
  async probe(url) {
    try {
      const res = await fetch(`${API.BASE}/api/probeurl=${encodeURIComponent(url)}`);
      return await res.json();
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  },

  /**
   * Construit l'URL du proxy pour streamer via le serveur
   * @returns {string}
   */
  proxyUrl(url) {
    return `${API.BASE}/api/proxyurl=${encodeURIComponent(url)}`;
  },

  /**
   * Récupère l'historique complet
   * @returns {Promise<Array>}
   */
  async getHistory() {
    try {
      const res = await fetch(`${API.BASE}/api/history`);
      return await res.json();
    } catch {
      return [];
    }
  },

  /**
   * Sauvegarde une entrée dans l'historique
   */
  async saveHistory(url, title, method) {
    try {
      await fetch(`${API.BASE}/api/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title, method }),
      });
    } catch {
      // Silently fail
    }
  },

  /**
   * Supprime une entrée de l'historique par id
   */
  async deleteHistory(id) {
    try {
      await fetch(`${API.BASE}/api/history/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {}
  },

  /**
   * Effectue une recherche globale via yt-dlp
   */
  async search(query) {
    try {
      const res = await fetch(`${API.BASE}/api/searchq=${encodeURIComponent(query)}`);
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Réessaye un téléchargement échoué
   */
  async retryDownload(id) {
    try {
      const res = await fetch(`${API.BASE}/api/ytdl/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
