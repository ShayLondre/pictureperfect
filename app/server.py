"""Picture Perfect — local web app. Run with the launcher; opens in your browser."""
import json
import os
import subprocess
import sys
import threading
import webbrowser

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from library import IS_MAC, ExifTool, Geo, Library, app_dir  # noqa: E402

PORT = int(os.environ.get("PHOTO_ORGANIZER_PORT", "8765"))
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(app_dir(), "config.json")

app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="/static")
ET = ExifTool()
GEO = Geo()
LIB = {"lib": None, "error": None}


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f)


def open_library(path):
    lib = Library(path, ET, GEO)
    LIB["lib"], LIB["error"] = lib, None
    cfg = load_config()
    cfg["library"] = lib.root
    recent = [p for p in cfg.get("recent", []) if p != lib.root]
    cfg["recent"] = [lib.root] + recent[:4]
    save_config(cfg)
    return lib


def lib():
    l = LIB["lib"]
    if l is None:
        abort(409, "Choose your photo folder first.")
    return l


@app.errorhandler(Exception)
def on_error(e):
    code = getattr(e, "code", 500)
    msg = getattr(e, "description", None) or str(e)
    if code == 500:
        import traceback
        traceback.print_exc()
    return jsonify({"error": msg}), code if isinstance(code, int) else 500


@app.route("/")
def index():
    return send_from_directory(os.path.join(HERE, "static"), "index.html")


# ---------------- library + jobs ----------------

@app.route("/api/state")
def state():
    l = LIB["lib"]
    cfg = load_config()
    out = {"library": l.root if l else None, "error": LIB["error"], "exiftool": ET.available,
           "recent": cfg.get("recent", []), "mac": IS_MAC}
    if l:
        if l._dupes is None and not (l.job and not l.job.finished):
            l.dup_groups()
        out["stats"] = l.stats()
        out["job"] = l.job.to_dict() if l.job else None
    return jsonify(out)


@app.route("/api/pick-folder", methods=["POST"])
def pick_folder():
    if not IS_MAC:
        return jsonify({"path": None, "error": "Type the folder path instead."})
    prompt = (request.json or {}).get("prompt", "Choose your photo folder")
    script = 'POSIX path of (choose folder with prompt "%s")' % prompt.replace('"', "")
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return jsonify({"path": None})
    path = r.stdout.strip()
    return jsonify({"path": path.rstrip("/") or None})


@app.route("/api/library", methods=["POST"])
def set_library():
    path = os.path.expanduser((request.json or {}).get("path", "").strip())
    if not path or not os.path.isdir(path):
        abort(400, "I can't find that folder. Is the drive plugged in?")
    l = open_library(path)
    l.start_job("Scanning your photos", l.scan)
    return jsonify({"library": l.root})


@app.route("/api/scan", methods=["POST"])
def scan():
    l = lib()
    l.start_job("Scanning your photos", l.scan)
    return jsonify({"ok": True})


@app.route("/api/import", methods=["POST"])
def import_photos():
    l = lib()
    src = os.path.expanduser((request.json or {}).get("path", "").strip())
    if not src or not os.path.isdir(src):
        abort(400, "I can't find that folder.")
    l.start_job("Checking the new photos against your library", l.check_import, src)
    return jsonify({"ok": True})


@app.route("/api/import/pending")
def import_pending():
    return jsonify(lib().import_view() or {"items": None})


@app.route("/api/import/commit", methods=["POST"])
def import_commit():
    l = lib()
    b = request.json or {}
    l.start_job("Importing your photos", l.commit_import, b.get("include", []), b.get("ratings"),
                (b.get("event") or "").strip() or None, int(b.get("shift") or 0), b.get("album") or None,
                bool(b.get("rename", True)), bool(b.get("delete_source", False)), b.get("names"))
    return jsonify({"ok": True})


@app.route("/api/import/cancel", methods=["POST"])
def import_cancel():
    lib().cancel_import()
    return jsonify({"ok": True})


@app.route("/import-media/<int:idx>")
def import_media(idx):
    path, mime = lib().import_preview(idx)
    if not path or not os.path.exists(path):
        abort(404)
    return send_file(path, mimetype=mime, conditional=True)


@app.route("/import-thumb/<int:idx>")
def import_thumb(idx):
    p = lib().import_thumb(idx)
    if not os.path.exists(p):
        return send_from_directory(os.path.join(HERE, "static"), "placeholder.svg")
    return send_file(p, mimetype="image/jpeg")


@app.route("/api/job/dismiss", methods=["POST"])
def dismiss_job():
    l = lib()
    if l.job and l.job.finished:
        l.job = None
    return jsonify({"ok": True})


# ---------------- browse ----------------

@app.route("/api/search")
def search():
    a = request.args
    return jsonify(lib().search(a.get("place", ""), a.get("year", ""), a.get("name", ""),
                                int(a.get("offset", 0)), min(int(a.get("limit", 120)), 500),
                                a.get("month", ""), a.get("ids") == "1", a.get("rating", "")))


@app.route("/api/unorganized")
def unorganized():
    return jsonify({"count": lib().unorganized_count()})


@app.route("/api/filters")
def filters():
    return jsonify(lib().filters())


@app.route("/api/file/<int:fid>")
def file_info(fid):
    r = lib().get(fid)
    if not r:
        abort(404)
    return jsonify(lib().public(r))


@app.route("/thumb/<int:fid>")
def thumb(fid):
    p = lib().thumb_path(fid)
    if not os.path.exists(p):
        return send_from_directory(os.path.join(HERE, "static"), "placeholder.svg")
    resp = send_file(p, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "max-age=300"
    return resp


@app.route("/media/<int:fid>")
def media(fid):
    path, mime = lib().preview_path(fid)
    if not path or not os.path.exists(path):
        abort(404)
    return send_file(path, mimetype=mime, conditional=True)


@app.route("/api/reveal/<int:fid>", methods=["POST"])
def reveal(fid):
    r = lib().get(fid)
    if r and IS_MAC:
        subprocess.run(["open", "-R", lib().full(r["path"])])
    return jsonify({"ok": True})


@app.route("/api/rename/<int:fid>", methods=["POST"])
def set_title(fid):
    title = (request.json or {}).get("title", "").strip()
    lib().x("UPDATE files SET title=? WHERE id=?", (title or None, fid))
    return jsonify({"ok": True})


@app.route("/api/name-day", methods=["POST"])
def name_day():
    b = request.json or {}
    return jsonify(lib().name_day(b["date"], b.get("title", "")))


# ---------------- inbox / review ----------------

@app.route("/api/review", methods=["POST"])
def review():
    b = request.json or {}
    return jsonify(lib().review_items(b.get("ids"), b.get("day"), bool(b.get("needs"))))


@app.route("/api/edit", methods=["POST"])
def edit():
    b = request.json or {}
    return jsonify(lib().edit(b["ids"], title=b.get("title"), taken=b.get("taken"), shift=b.get("shift"),
                              add_tags=b.get("add_tags"), remove_tags=b.get("remove_tags"),
                              date_only=bool(b.get("date_only")), use_file_date=bool(b.get("use_file_date")),
                              rating=b.get("rating")))


@app.route("/api/groups")
def groups():
    return jsonify(lib().groups())


@app.route("/api/add-to-group", methods=["POST"])
def add_to_group():
    b = request.json or {}
    return jsonify(lib().add_to_group(b["ids"], b["key"], b.get("taken"), bool(b.get("keep_dates"))))


@app.route("/api/matches", methods=["POST"])
def matches():
    b = request.json or {}
    return jsonify(lib().find_matches(b["id"], b.get("name", ""), b.get("year", ""), b.get("place", "")))


@app.route("/api/guess-date", methods=["POST"])
def guess_date():
    b = request.json or {}
    return jsonify(lib().guess_date(b["id"], b.get("name", ""), b.get("year", ""), b.get("place", "")))


@app.route("/api/set-date-only", methods=["POST"])
def set_date_only():
    b = request.json or {}
    return jsonify(lib().set_date_only(b["ids"], b["date"]))


@app.route("/api/copy-details", methods=["POST"])
def copy_details():
    b = request.json or {}
    return jsonify(lib().copy_details(b["to"], b["from"]))


# ---------------- people ----------------

@app.route("/api/people")
def people():
    return jsonify(lib().people_overview())


@app.route("/api/people/setup", methods=["POST"])
def people_setup():
    l = lib()
    l.start_job("Setting up face recognition", l.face_setup)
    return jsonify({"ok": True})


@app.route("/api/people/scan", methods=["POST"])
def people_scan():
    l = lib()
    l.start_job("Finding faces", l.face_scan)
    return jsonify({"ok": True})


@app.route("/api/people/faces", methods=["POST"])
def people_faces():
    b = request.json or {}
    return jsonify(lib().person_faces(b.get("person"), b.get("status", "confirmed"), b.get("cluster")))


@app.route("/api/people/name", methods=["POST"])
def people_name():
    b = request.json or {}
    return jsonify(lib().name_faces(b.get("faces"), b.get("cluster"), b.get("name", "")))


@app.route("/api/people/confirm", methods=["POST"])
def people_confirm():
    b = request.json or {}
    return jsonify(lib().confirm_faces(b.get("faces", []), bool(b.get("yes", True))))


@app.route("/api/people/ignore", methods=["POST"])
def people_ignore():
    b = request.json or {}
    return jsonify(lib().ignore_faces(b.get("faces"), b.get("cluster")))


@app.route("/api/people/rename", methods=["POST"])
def people_rename():
    b = request.json or {}
    return jsonify(lib().rename_person(b["person"], b.get("name", "")))


@app.route("/api/people/forget", methods=["POST"])
def people_forget():
    return jsonify(lib().forget_person((request.json or {})["person"]))


@app.route("/api/file-faces/<int:fid>")
def file_faces(fid):
    return jsonify(lib().faces_in_file(fid))


@app.route("/face/<int:face_id>")
def face_img(face_id):
    p = lib().face_thumb_path(face_id)
    if not os.path.exists(p):
        return send_from_directory(os.path.join(HERE, "static"), "placeholder.svg")
    resp = send_file(p, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "max-age=600"
    return resp


@app.route("/api/pick", methods=["POST"])
def pick():
    return jsonify(lib().pick_set((request.json or {}).get("ids", [])))


@app.route("/api/pick/commit", methods=["POST"])
def pick_commit():
    l = lib()
    b = request.json or {}
    l.start_job("Keeping your best photos", l.pick_commit, b.get("keep", []), b.get("skip", []), b.get("ratings"))
    return jsonify({"ok": True})


@app.route("/api/group-ids", methods=["POST"])
def group_ids():
    key = (request.json or {}).get("key")
    l = lib()
    gm = l.groups()
    g = next((x for x in gm if x["key"] == key), None)
    if not g:
        abort(404, "That group isn't there any more.")
    name = g["name"].lower()
    rows = l.q("SELECT * FROM files WHERE status='active' AND taken BETWEEN ? AND ? ORDER BY taken", (g["start"], g["end"]))
    return jsonify([r["id"] for r in rows if (l.name_part(r) or "").lower() == name])


@app.route("/api/review/done", methods=["POST"])
def review_done():
    return jsonify(lib().mark_reviewed((request.json or {}).get("ids")))


# ---------------- duplicates ----------------

@app.route("/api/dupes")
def dupes():
    groups = lib().dup_groups()
    kind = request.args.get("kind", "")
    if kind:
        groups = [g for g in groups if g["kind"] == kind]
    offset = int(request.args.get("offset", 0))
    exact = sum(1 for g in lib().dup_groups() if g["kind"] == "exact")
    return jsonify({"total": len(groups), "exact": exact,
                    "similar": len(lib().dup_groups()) - exact,
                    "groups": groups[offset:offset + 10]})


@app.route("/api/dupes/resolve", methods=["POST"])
def resolve():
    b = request.json or {}
    return jsonify(lib().resolve_dupes(b["key"], b.get("keep", []), b.get("aside", [])))


@app.route("/api/dupes/auto-exact", methods=["POST"])
def auto_exact():
    l = lib()
    l.start_job("Setting aside exact copies", l.auto_exact)
    return jsonify({"ok": True})


@app.route("/api/dupes/restore", methods=["POST"])
def restore():
    l = lib()
    l.start_job("Putting copies back", l.restore_set_aside)
    return jsonify({"ok": True})


# ---------------- locations ----------------

@app.route("/api/locations")
def locations():
    d = lib().location_days()
    offset = int(request.args.get("offset", 0))
    return jsonify({"total": d["total"], "covered": d["covered"], "days_total": len(d["days"]),
                    "days": d["days"][offset:offset + 15]})


@app.route("/api/locations/accept", methods=["POST"])
def accept():
    ids = (request.json or {}).get("ids")
    return jsonify(lib().accept_suggestions(ids))


@app.route("/api/locations/set", methods=["POST"])
def set_location():
    b = request.json or {}
    return jsonify(lib().set_location(b["ids"], b["lat"], b["lon"], b.get("label"), b.get("name")))


@app.route("/api/locations/skip", methods=["POST"])
def skip_location():
    b = request.json or {}
    return jsonify(lib().skip_location(b["ids"], b.get("skip", True)))


@app.route("/api/places")
def places():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    return jsonify(lib().search_places(q))


# ---------------- organize ----------------

@app.route("/api/organize")
def organize_plan():
    return jsonify(lib().plan_summary())


@app.route("/api/organize/settings", methods=["POST"])
def organize_settings():
    lib().set_settings(request.json or {})
    return jsonify(lib().plan_summary())


@app.route("/api/organize/apply", methods=["POST"])
def organize_apply():
    l = lib()
    ids = (request.json or {}).get("ids")
    if ids:
        l.start_job("Saving and filing %d files" % len(ids), l.apply, ids)
    else:
        l.start_job("Organizing your photos", l.apply)
    return jsonify({"ok": True})


@app.route("/api/highlights", methods=["POST"])
def highlights():
    l = lib()
    l.start_job("Updating your highlights", l.highlights_job)
    return jsonify({"ok": True})


@app.route("/api/organize/undo", methods=["POST"])
def organize_undo():
    l = lib()
    l.start_job("Undoing the last organize", l.undo)
    return jsonify({"ok": True})


def init():
    """Open the last photo folder, if its drive is plugged in."""
    cfg = load_config()
    last = cfg.get("library")
    if last and os.path.isdir(last):
        try:
            open_library(last)
        except Exception as e:
            LIB["error"] = str(e)
    elif last:
        LIB["error"] = "Your photo folder (%s) isn't available. Is the drive plugged in?" % last


def run(port):
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)


def main():
    init()
    url = "http://127.0.0.1:%d/" % PORT
    if os.environ.get("PHOTO_ORGANIZER_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print("\n  Picture Perfect is running at %s" % url)
    print("  Leave this window open while you use it. Close it to quit.\n")
    run(PORT)


if __name__ == "__main__":
    main()
