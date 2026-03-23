# StreamVault

Lecteur vidéo universel avec proxy CORS intégré.  
Lis n'importe quelle vidéo — CDN signé, MP4 direct, YouTube, Vimeo.

---

## Structure du projet

```
streamvault/
├── server.py              ← Serveur Python (HTTP + proxy)
├── data/
│   └── history.json       ← Historique (créé automatiquement)
├── templates/
│   └── index.html         ← Interface principale
└── static/
    ├── css/
    │   └── main.css        ← Styles
    ├── js/
    │   ├── api.js          ← Client API (communication serveur)
    │   ├── player.js       ← Moteur de lecture (cascade 4 méthodes)
    │   └── app.js          ← Logique UI + routing
    └── icons/
        └── favicon.svg
```

---

## Installation & lancement

### Prérequis
- Python 3.8+ (pas de dépendances externes — stdlib uniquement)

### Lancer le serveur

```bash
cd streamvault
python server.py
```

Puis ouvre : **http://localhost:5000**

---

## Comment ça fonctionne

### Cascade de lecture (4 méthodes)

Pour chaque lien, le lecteur essaie dans cet ordre :

| # | Méthode        | Description |
|---|----------------|-------------|
| 1 | **Natif direct** | Injecte l'URL dans `<video>` — si le CDN le permet |
| 2 | **Proxy serveur** | Python relaie les requêtes, contourne le CORS du navigateur |
| 3 | **Proxy blob** | Serveur télécharge, renvoie en blob, lecture locale |
| 4 | **Blob CORS** | Fetch côté navigateur + lecture blob locale |

### Probe
Avant de lire, le serveur fait une requête HEAD pour vérifier :
- Accessibilité de l'URL
- Type MIME
- Taille du fichier
- Support du seek (Accept-Ranges)

### Proxy serveur
Le serveur Python (`/api/proxy`) :
- Ajoute des headers navigateur réalistes (User-Agent Chrome)
- Supporte la requête `Range` pour le seek dans la vidéo
- Stream en chunks de 64 Ko pour ne pas saturer la mémoire

---

## API

| Route | Méthode | Description |
|-------|---------|-------------|
| `/` | GET | Interface web |
| `/api/proxy?url=...` | GET | Proxy vidéo (streaming) |
| `/api/probe?url=...` | GET | Infos sur une URL |
| `/api/history` | GET | Liste l'historique |
| `/api/history` | POST | Ajoute `{url, title, method}` |
| `/api/history/delete` | POST | Supprime `{id}` |

---

## Cas d'usage typiques

- **Lien CDN signé** : `https://bcdn.exemple.com/video.mp4?sign=xxx&t=xxx`
  → Méthode Proxy serveur ou Proxy blob

- **MP4 public** : `https://exemple.com/film.mp4`
  → Méthode Natif direct (la plus rapide)

- **YouTube** : `https://youtube.com/watch?v=...`
  → Embed YouTube nocookie

- **Vimeo** : `https://vimeo.com/123456789`
  → Embed Vimeo

---

## Notes

- L'historique est sauvegardé dans `data/history.json` (50 dernières vidéos)
- Le serveur tourne sur le port 5000 par défaut (modifiable dans `server.py`)
- Aucune dépendance externe — Python standard library uniquement
