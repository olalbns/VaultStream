#!/usr/bin/env bash
set -e

echo "=== [build] Installation des dépendances Python ==="
pip install -r requirements.txt

echo "=== [build] Installation de torrent-stream (Node.js) ==="
npm install --ignore-scripts

echo "=== [build] Téléchargement de FFmpeg ==="
FFMPEG_DIR="$HOME/.local/bin"
mkdir -p "$FFMPEG_DIR"

# Vérifier si ffmpeg est déjà disponible
if command -v ffmpeg &>/dev/null; then
  echo "[OK] ffmpeg déjà disponible: $(which ffmpeg)"
else
  echo "[FFMPEG] Téléchargement pour linux..."
  FFMPEG_URL="https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
  curl -L --retry 3 "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz
  tar -xf /tmp/ffmpeg.tar.xz -C /tmp
  find /tmp -maxdepth 3 -name "ffmpeg" -type f -exec cp {} "$FFMPEG_DIR/ffmpeg" \; 2>/dev/null || true
  find /tmp -maxdepth 3 -name "ffprobe" -type f -exec cp {} "$FFMPEG_DIR/ffprobe" \; 2>/dev/null || true
  chmod +x "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" 2>/dev/null || true
  rm -rf /tmp/ffmpeg* 2>/dev/null || true
  "$FFMPEG_DIR/ffmpeg" -version 2>&1 | head -1 && echo "[OK] ffmpeg installé" || echo "[WARN] ffmpeg non disponible"
fi

echo "=== [build] Build terminé ==="
