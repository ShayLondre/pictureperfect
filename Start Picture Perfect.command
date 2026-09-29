#!/bin/bash
# Double-click this file to start Picture Perfect.
# The first run sets things up (takes a few minutes); later runs start in seconds.

cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
SUPPORT="$HOME/Library/Application Support/PhotoOrganizer"
mkdir -p "$SUPPORT"

echo ""
echo "  Picture Perfect"
echo "  ---------------"

# 1. Python
PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo ""
  echo "  Python isn't set up on this Mac yet."
  echo "  A window should pop up asking to install the 'command line developer tools'."
  echo "  Click Install, wait for it to finish, then double-click Start Picture Perfect again."
  xcode-select --install 2>/dev/null
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

# 2. App libraries (in a private folder, nothing system-wide)
VENV="$SUPPORT/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "  Setting up (first run only)…"
  "$PY" -m venv "$VENV" || { echo "  Couldn't set up Python."; read -n 1 -s -r; exit 1; }
fi
REQ_HASH="$(cat "$HERE/app/requirements.txt" "$HERE/app/requirements-faces.txt" | shasum | cut -d' ' -f1)"
if [ "$(cat "$SUPPORT/.req" 2>/dev/null)" != "$REQ_HASH" ]; then
  echo "  Installing what the app needs…"
  "$VENV/bin/python" -m pip install -q --upgrade pip >/dev/null 2>&1
  if "$VENV/bin/python" -m pip install -q -r "$HERE/app/requirements.txt"; then
    # face recognition is optional: if it can't install, everything else still works
    "$VENV/bin/python" -m pip install -q -r "$HERE/app/requirements-faces.txt" >/dev/null 2>&1 \
      || echo "  (Face recognition couldn't be installed on this Mac — everything else works.)"
    echo "$REQ_HASH" > "$SUPPORT/.req"
  else
    echo "  Couldn't install (are you online?). Try again when you have internet."
    read -n 1 -s -r -p "  Press any key to close."; exit 1
  fi
fi

# 3. ExifTool (reads and writes photo dates and locations)
if command -v exiftool >/dev/null 2>&1; then
  export EXIFTOOL="$(command -v exiftool)"
elif [ -f "$SUPPORT/exiftool/exiftool" ]; then
  export EXIFTOOL="$SUPPORT/exiftool/exiftool"
else
  echo "  Downloading ExifTool…"
  TMP="$(mktemp -d)"
  VER="$(curl -fsSL https://exiftool.org/ver.txt 2>/dev/null)"
  if [ -n "$VER" ] && curl -fsSL "https://exiftool.org/Image-ExifTool-$VER.tar.gz" | tar xz -C "$TMP" 2>/dev/null; then
    :
  else
    curl -fsSL https://github.com/exiftool/exiftool/archive/refs/heads/master.tar.gz | tar xz -C "$TMP"
  fi
  SRC="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)"
  if [ -n "$SRC" ] && [ -f "$SRC/exiftool" ]; then
    rm -rf "$SUPPORT/exiftool"; mv "$SRC" "$SUPPORT/exiftool"
    chmod +x "$SUPPORT/exiftool/exiftool"
    export EXIFTOOL="$SUPPORT/exiftool/exiftool"
  else
    echo "  Couldn't download ExifTool (are you online?). Try again when you have internet."
    read -n 1 -s -r -p "  Press any key to close."; exit 1
  fi
  rm -rf "$TMP"
fi

# 4. Go
exec "$VENV/bin/python" "$HERE/app/server.py"
