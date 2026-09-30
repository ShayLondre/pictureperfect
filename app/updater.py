"""Keeps the Mac app up to date from the GitHub Releases page.

On start it looks for a newer release; if there is one it downloads and unpacks it in the
background, then the app offers "Restart to update". Installing swaps the app in place once
this copy has quit (so macOS never finds the app busy) and opens the new one."""
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

REPO = "ShayLondre/pictureperfect"
ASSET = "Picture-Perfect-Mac.zip"
UA = "PicturePerfect-updater"
STATE = {"current": None, "latest": None, "status": "idle", "progress": 0, "error": None, "notes": ""}
_lock = threading.Lock()


def app_bundle():
    """Path of 'Picture Perfect.app' when running as the packaged app, else None."""
    if not getattr(sys, "frozen", False):
        return None
    p = os.path.abspath(sys.executable)
    while p and p != "/" and not p.endswith(".app"):
        p = os.path.dirname(p)
    return p if p.endswith(".app") else None


def current_version():
    b = app_bundle()
    if b:
        try:
            with open(os.path.join(b, "Contents", "Info.plist"), "rb") as f:
                return plistlib.load(f).get("CFBundleShortVersionString")
        except Exception:
            pass
    return os.environ.get("APP_VERSION")


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3]) or (0,)


def cache_dir():
    d = os.path.expanduser("~/Library/Caches/Picture Perfect/update")
    os.makedirs(d, exist_ok=True)
    return d


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)


def check_and_download():
    """Find the newest release; download and unpack it if it's newer than this app."""
    with _lock:
        if STATE["status"] in ("checking", "downloading", "ready", "installing"):
            return STATE
        STATE.update(status="checking", error=None, current=current_version())
    try:
        with _get("https://api.github.com/repos/%s/releases/latest" % REPO) as r:
            rel = json.load(r)
        latest = (rel.get("tag_name") or "").lstrip("v")
        STATE.update(latest=latest, notes=(rel.get("body") or "")[:2000])
        if not STATE["current"] or vtuple(latest) <= vtuple(STATE["current"]):
            STATE.update(status="up_to_date")
            return STATE
        if not app_bundle():
            STATE.update(status="available")   # running from source: just say so
            return STATE
        asset = next((a for a in rel.get("assets", []) if a.get("name") == ASSET), None)
        if not asset:
            STATE.update(status="up_to_date")
            return STATE
        d = cache_dir()
        target = os.path.join(d, "v" + latest)
        app = os.path.join(target, "Picture Perfect.app")
        if not os.path.isdir(app):
            STATE.update(status="downloading", progress=0)
            zpath = os.path.join(d, "v%s.zip.part" % latest)
            total = asset.get("size") or 0
            with _get(asset["browser_download_url"], timeout=120) as r, open(zpath, "wb") as f:
                done = 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    STATE["progress"] = int(done * 100 / total) if total else 0
            if total and os.path.getsize(zpath) != total:
                raise RuntimeError("the download was incomplete")
            shutil.rmtree(target, ignore_errors=True)
            os.makedirs(target)
            subprocess.run(["ditto", "-x", "-k", zpath, target], check=True, timeout=600)
            os.remove(zpath)
            if not os.path.isdir(app):
                raise RuntimeError("the download didn't contain the app")
        # clean up older downloads
        for x in os.listdir(d):
            if x.startswith("v") and x != "v" + latest:
                shutil.rmtree(os.path.join(d, x), ignore_errors=True)
        STATE.update(status="ready", progress=100, new_app=app)
    except Exception as e:
        STATE.update(status="error", error=str(e)[:300])
    return STATE


def install_and_restart():
    """Swap in the downloaded app after this copy quits, then open it."""
    old = app_bundle()
    new = STATE.get("new_app")
    if STATE.get("status") != "ready" or not old or not new or not os.path.isdir(new):
        raise RuntimeError("There's no update ready to install.")
    if not os.access(os.path.dirname(old), os.W_OK):
        raise RuntimeError("Picture Perfect can't replace itself in %s. Drag the new version there yourself." % os.path.dirname(old))
    script = os.path.join(cache_dir(), "install.sh")
    with open(script, "w") as f:
        f.write('''#!/bin/bash
# wait for Picture Perfect to quit completely
while kill -0 %(pid)d 2>/dev/null; do sleep 0.3; done
sleep 1
OLD="%(old)s"; NEW="%(new)s"
rm -rf "$OLD.previous"
if mv "$OLD" "$OLD.previous" && mv "$NEW" "$OLD"; then
  xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
  rm -rf "$OLD.previous"
else
  [ -d "$OLD" ] || mv "$OLD.previous" "$OLD"
fi
open "$OLD"
''' % {"pid": os.getpid(), "old": old.replace('"', '\\"'), "new": new.replace('"', '\\"')})
    os.chmod(script, 0o755)
    subprocess.Popen(["/bin/bash", script], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    STATE["status"] = "installing"
    threading.Timer(0.8, lambda: os._exit(0)).start()   # quit; the script takes over
    return {"ok": True}


def start_background_checks():
    def loop():
        time.sleep(5)
        while True:
            check_and_download()
            if STATE["status"] in ("ready", "installing"):
                return
            time.sleep(6 * 3600)
    threading.Thread(target=loop, daemon=True).start()
