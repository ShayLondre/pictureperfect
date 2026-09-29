#!/bin/bash
# Gathers what the app carries inside it: ExifTool, the face model, place names, and the icon.
set -euo pipefail
cd "$(dirname "$0")/.."
X=build_extra
rm -rf "$X" && mkdir -p "$X/exiftool" "$X/models" "$X/geo"
TMP="$(mktemp -d)"

echo "ExifTool…"
VER="$(curl -fsSL https://exiftool.org/ver.txt || true)"
if [ -n "$VER" ] && curl -fsSL "https://exiftool.org/Image-ExifTool-$VER.tar.gz" -o "$TMP/et.tgz"; then :; else
  curl -fsSL https://github.com/exiftool/exiftool/archive/refs/heads/master.tar.gz -o "$TMP/et.tgz"; fi
tar xzf "$TMP/et.tgz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -name exiftool -type f | head -1)"
cp "$SRC" "$X/exiftool/exiftool" && cp -R "$(dirname "$SRC")/lib" "$X/exiftool/lib"
chmod +x "$X/exiftool/exiftool"
perl "$X/exiftool/exiftool" -ver

echo "Face model…"
curl -fsSL https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip -o "$TMP/m.zip"
unzip -o -q -j "$TMP/m.zip" "*det_500m.onnx" "*w600k_mbf.onnx" -d "$X/models"
ls -la "$X/models"

echo "Place names…"
for f in cities500.zip admin1CodesASCII.txt countryInfo.txt; do
  curl -fsSL "https://download.geonames.org/export/dump/$f" -o "$X/geo/$f"
done
ls -la "$X/geo"

echo "Icon…"
python3 packaging/make_icon.py "$X/icon.icns"
