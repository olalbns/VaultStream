/**
 * StreamVault — API Client
 * Toute la communication avec le serveur Python
 */

const API = {
  BASE: window.location.origin,

  getDeviceToken() {
    let token = localStorage.getItem('sv_device_token');
    if (!token) {
      token = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('sv_device_token', token);
    }
    return token;
  },

  async fetch(url, options = {}) {
    options.headers = options.headers || {};
    options.headers['X-Device-Token'] = this.getDeviceToken();
    return fetch(url, options);
  },

  /**
   * Probe une URL — vérifie accessibilité + métadonnées
   * @returns {Promise<{ok, status, content_type, content_length, seekable, error}>}
   */
  async probe(url) {
    try {
      const res = await this.fetch(`${API.BASE}/api/probe?url=${encodeURIComponent(url)}`);
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
    return `${API.BASE}/api/proxy?url=${encodeURIComponent(url)}`;
  },

  /**
   * Récupère l'historique complet
   * @returns {Promise<Array>}
   */
  async getHistory() {
    try {
      const res = await this.fetch(`${API.BASE}/api/history`);
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
      await this.fetch(`${API.BASE}/api/history`, {
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
      await this.fetch(`${API.BASE}/api/history/delete`, {
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
      const res = await this.fetch(`${API.BASE}/api/search?q=${encodeURIComponent(query)}`);
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async getMetadata(query) {
    try {
      const res = await this.fetch(`${API.BASE}/api/metadata?q=${encodeURIComponent(query)}`);
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
      const res = await this.fetch(`${API.BASE}/api/ytdl/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async getYtdlAuthStatus() {
    try {
      const res = await this.fetch(`${API.BASE}/api/ytdl/auth/status`);
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async saveYtdlCookies(text) {
    try {
      const res = await this.fetch(`${API.BASE}/api/ytdl/cookies/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async clearYtdlCookies() {
    try {
      const res = await this.fetch(`${API.BASE}/api/ytdl/cookies/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
