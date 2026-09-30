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

echo "Map library…"
L=app/static/vendor/leaflet
rm -rf "$L" && mkdir -p "$L"
curl -fsSL https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz -o "$TMP/leaflet.tgz"
tar xzf "$TMP/leaflet.tgz" -C "$TMP"
cp "$TMP/package/dist/leaflet.js" "$TMP/package/dist/leaflet.css" "$TMP/package/LICENSE" "$L/"
cp -R "$TMP/package/dist/images" "$L/images"
ls -la "$L"

echo "Offline maps (map engine, world map, fonts, place search)…"
gh release download map-assets -R "${GITHUB_REPOSITORY:-ShayLondre/pictureperfect}" --pattern map-assets.zip --dir "$TMP" --clobber
mkdir -p "$TMP/ma" && unzip -q -o "$TMP/map-assets.zip" -d "$TMP/ma"
rm -rf app/static/vendor/map && mkdir -p app/static/vendor && cp -R "$TMP/ma/vendor/map" app/static/vendor/map
mkdir -p "$X/maps" "$X/bin"
cp "$TMP/ma/maps/world.pmtiles" "$X/maps/"
cp "$TMP/ma/geo/features.tsv.gz" "$TMP/ma/geo/admin2Codes.txt.gz" "$X/geo/"
cp "$TMP/ma/bin/pmtiles" "$X/bin/pmtiles" && chmod +x "$X/bin/pmtiles"
ls -la "$X/maps" "$X/bin" app/static/vendor/map

echo "Icon…"
python3 packaging/make_icon.py "$X/icon.icns"
