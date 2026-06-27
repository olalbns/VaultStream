#!/usr/bin/env bash
set -e

echo "=== [build] Installation des dépendances Python ==="
pip install -r requirements.txt

echo "=== [build] Installation de Node.js webtorrent ==="
npm install --ignore-scripts 2>/dev/null || true

echo "=== [build] Téléchargement de FFmpeg ==="
FFMPEG_DIR="$HOME/.local/bin"
mkdir -p "$FFMPEG_DIR"

# Télécharger le binaire statique FFmpeg (Linux x86_64)
FFMPEG_URL="https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
curl -L "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp
find /tmp -name "ffmpeg" -type f -exec cp {} "$FFMPEG_DIR/ffmpeg" \;
find /tmp -name "ffprobe" -type f -exec cp {} "$FFMPEG_DIR/ffprobe" \;
chmod +x "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe"
rm -rf /tmp/ffmpeg* /tmp/ffmpeg-master*

# Vérifier
"$FFMPEG_DIR/ffmpeg" -version 2>&1 | head -1 || echo "[WARN] ffmpeg non disponible"

echo "=== [build] Tout est installé ==="
