# Picture Perfect — notes for whoever works on this next

Read this first, then README.md (what the app does, from the user's side).

## What it is
A personal Mac app for organizing a big photo library on an external exFAT drive (24 TB, shared with Windows).
Owner: Shay (GitHub: ShayLondre). She is not a programmer: explain things in plain words, show results, publish releases for her.

## How it's built
- `app/library.py` — the engine: catalog (SQLite at `<library>/.photo-organizer/catalog.db`, rollback journal kept, saves batched),
  scanning, import (copy from a card, check duplicates, rename, file), naming/filing (`plan`/`apply`/`undo`), metadata writing
  via one ExifTool `-stay_open` process (+ a small pool for RAW previews), duplicates (dhash + sha256), Prune (quality + taste model),
  faces (InsightFace ONNX, `app/faces.py`), Places (offline place names from GeoNames, My Places, geotagging, map regions), Tidy Up.
- `app/server.py` — Flask routes; `app/static/` — plain HTML/JS/CSS UI (`app.js` has one section per screen).
- `app/updater.py` — self-update: checks GitHub releases on start, downloads, "Restart to update" swaps the app in place.
- `packaging/` — PyInstaller recipe (`PicturePerfect.spec`), `desktop.py` (pywebview window + `--self-test`),
  `fetch_bundled.sh` (ExifTool, face model, GeoNames, map pieces), `make_icon.py`, `build_places.py` (offline place list).

## File naming rules (the owner's choices)
`YYYY.MM.DD HHMM Event.ext` inside `YYYY.MM/YYYY.MM Event/`. Same-minute clashes get " 2", " 3" at the end.
RAW+JPEG pairs travel together (the RAW row has `pair_of` = JPEG id). Exact GPS is never overwritten silently.
Nothing is ever deleted without the Trash or a `_Set aside` folder; the source card is never changed (except optional move-to-Trash after copying).

## Maps
Online when there's internet (OpenFreeMap "liberty" style, Esri satellite, Nominatim address search on request);
offline otherwise: built-in world map (Protomaps PMTiles, zoom 0–6) + regions saved to the drive with the bundled `pmtiles` tool.
The map pieces come from the "map-assets" release, made by `.github/workflows/map-assets.yml`.

## Publishing a new version
GitHub Actions → "Build the Mac app" (`build-mac-app.yml`, run by workflow_dispatch with input `version`, e.g. 1.7.8).
It builds on macOS, runs `--self-test`, and publishes Picture-Perfect-Mac.zip as a release. Installed apps (1.7.5+)
update themselves from the newest release. Always test before publishing and bump the version.

## Testing
- Headless browser tests (Playwright) against `app/server.py` with small sample libraries; ExifTool needed.
- GitHub test workflows: `test-map-download.yml`, `test-online-map.yml` (screenshots with internet), `test-updater.yml` (update on a real Mac).
  Their results are uploaded to the "map-test" pre-release.

## Latest version when these notes were written: 1.7.7
Recent work: automatic updates; Duplicates compare (side by side + Flip); RAW previews upright; Prune shows RAW+JPEG pairs once;
import previews never reused between imports; Date & Time box moves only ticked photos; online/offline map; Places screen;
Tidy Up find & replace, bulk location change/removal; coordinates in any format.
