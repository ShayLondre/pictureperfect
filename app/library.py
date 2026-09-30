"""Picture Perfect engine: catalog, scanning, duplicates, locations, organizing.

Everything here runs locally. The catalog lives in a hidden `.photo-organizer`
folder inside the photo library, so it travels with the drive.
Written for Python 3.9+ (the version that ships with macOS developer tools).
"""
import bisect
import contextlib
import csv
import gzip
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from PIL import Image, ImageFilter, ImageOps, ImageStat
    Image.MAX_IMAGE_PIXELS = None
except ImportError:  # pragma: no cover
    Image = ImageFilter = ImageOps = ImageStat = None
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

IS_MAC = sys.platform == "darwin"

PHOTO_EXT = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".tif", ".tiff", ".gif",
             ".webp", ".bmp", ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf",
             ".orf", ".rw2"}
RAW_EXT = {".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2"}
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".avi", ".3gp", ".mts", ".m2ts", ".mkv"}
WEB_OK = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

DATA_DIR = ".photo-organizer"
SET_ASIDE = "_Set aside"
INBOX = "_Drive Preview"
USER_AGENT = "PhotoOrganizer/1.0 (personal photo library tool)"

NEARBY_WINDOW = 2 * 3600      # borrow a location from a photo taken within 2 hours
DAY_CLUSTER_KM = 25           # date-only photos borrow a day's location if that day stayed within this
SIMILAR_MAX_BITS = 3          # look-alike threshold (out of 64)


def app_dir():
    if IS_MAC:
        base = os.path.expanduser("~/Library/Application Support/PhotoOrganizer")
    else:
        base = os.path.expanduser("~/.photo-organizer-app")
    os.makedirs(base, exist_ok=True)
    return base


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})")


def parse_iso(value):
    """Return 'YYYY-MM-DDTHH:MM:SS' if value is a real date, else None."""
    if not value or not isinstance(value, str):
        return None
    m = ISO_RE.match(value.strip())
    if not m:
        return None
    try:
        d = dt.datetime(*[int(x) for x in m.groups()])
    except ValueError:
        return None
    if d.year < 1900 or d.year > dt.datetime.now().year + 1:
        return None
    return d.strftime("%Y-%m-%dT%H:%M:%S")


FN_DATE_RE = re.compile(
    r"(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])"
    r"(?:[ _T-]?([01]\d|2[0-3])[.:_-]?([0-5]\d)(?:[.:_-]?([0-5]\d))?)?(?!\d)")


def date_from_filename(name):
    """Find a date (and maybe time) in a filename. Returns (iso, has_time, span)."""
    for m in FN_DATE_RE.finditer(name):
        y, mo, d, hh, mi, ss = m.groups()
        try:
            when = dt.datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0))
        except ValueError:
            continue
        if when.year > dt.datetime.now().year + 1:
            continue
        return when.strftime("%Y-%m-%dT%H:%M:%S"), hh is not None, m.span()
    return None, False, None


UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
NOISE_TAIL_RE = re.compile(
    r"(?:[\s_-]*(?:\(\d+\)|~\d+|copy(?:\s\d+)?|edited|bearbeitet|modifi[eé]|effects|collage|"
    r"animation|MP|COVER|burst\d*|\d{3,}))+$", re.I)
JUNK_RE = re.compile(
    r"^(?:img|dsc[nf]?|pxl|vid|mvimg|pano|mov|gopr|gh\d\d|dji|_?mg|image|photo|picture|"
    r"pic|p|mvi|snapchat|signal|whatsapp image|whatsapp video|received|fb_img|"
    r"original|export|untitled|scan|scanned|screenshot|screen shot|image\d*|dcim)?[\s_\-.]*[\d\s_\-.]*$", re.I)
BAD_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


CAMERA_NO_RE = re.compile(r"(?:(?<=\s)|(?<=^)|(?<=[_\-]))(?:_?[A-Z]{2,5}_?|(?:img|dsc[nf]?|pxl|vid|mvimg|gopr|dji)_?)\d{3,6}(?=$|[\s_\-.(])",
                          0)
CAMERA_NO_CI_RE = re.compile(r"(?:(?<=\s)|(?<=^)|(?<=[_\-]))(?:img|dsc[nf]?|pxl|vid|mvimg|gopr|dji|_mg)_?\d{3,6}(?=$|[\s_\-.(])", re.I)


OWN_NAME_RE = re.compile(r"^(?:19|20)\d{2}\.\d{2}\.\d{2}(?: \d{4})? .+ \d{1,2}$")


def extract_name(filename):
    """Pull the human part out of a filename: '20190312 Tobago Cays.jpg' -> 'Tobago Cays'."""
    stem = os.path.splitext(filename)[0]
    if OWN_NAME_RE.match(stem):
        stem = re.sub(r" \d{1,2}$", "", stem)   # our own " 2", " 3" for photos taken in the same minute
    _, _, span = date_from_filename(stem)
    if span:
        stem = stem[:span[0]] + " " + stem[span[1]:]
    else:
        # a short date at the start, like "250515 Miami" (YYMMDD)
        m = re.match(r"^\s*(\d{2})(\d{2})(\d{2})(?=[\s_\-.]|$)", stem)
        if m:
            try:
                dt.date(2000 + int(m.group(1)), int(m.group(2)), int(m.group(3)))
                stem = stem[m.end():]
            except ValueError:
                pass
    stem = UUID_RE.sub(" ", stem)
    stem = re.sub(r"\bat \d{1,2}[.:]\d{2}(?:[.:]\d{2})?(?:\s?[AP]M)?", " ", stem, flags=re.I)   # Mac screenshots
    # the camera's own file number, e.g. JAPN2382, IMG_4321, DSC_0412, _MG_1234, DSCF0001
    stem = CAMERA_NO_RE.sub(" ", stem)
    stem = CAMERA_NO_CI_RE.sub(" ", stem)
    stem = NOISE_TAIL_RE.sub("", stem.strip())
    stem = BAD_CHARS_RE.sub(" ", stem).replace("_", " ")
    stem = re.sub(r"\s+", " ", stem).strip(" _-.,")
    if not stem or JUNK_RE.match(stem):
        return ""
    return stem[:80].strip()


def split_tags(value):
    if not value:
        return []
    return [t.strip() for t in str(value).split(",") if t.strip()]


def short_place(place):
    if not place:
        return ""
    first = place.split(",")[0].strip()
    if first.lower().startswith("near "):
        first = first[5:]
    return BAD_CHARS_RE.sub(" ", first).strip()


def norm_ext(ext):
    ext = ext.lower()
    return ".jpg" if ext == ".jpeg" else ext


def km_between(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2 +
         math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(min(1.0, math.sqrt(a)))


def iso_to_ts(iso):
    return time.mktime(time.strptime(iso, "%Y-%m-%dT%H:%M:%S"))


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def popcount(x):
    return bin(x).count("1")


def dhash_of(img):
    g = img.convert("L").resize((9, 8), Image.BILINEAR)
    px = list(g.getdata())
    v = 0
    for r in range(8):
        for c in range(8):
            v = (v << 1) | (1 if px[r * 9 + c] > px[r * 9 + c + 1] else 0)
    return "%016x" % v


def _rating(v):
    try:
        v = int(float(v))
    except (TypeError, ValueError):
        return None
    return v if 1 <= v <= 5 else None


def quality_of(img):
    """Sharpness, exposure, colour and composition measured from a preview.
    Sharpness is taken from the most detailed part of the picture, so a crisp boat on a smooth
    sea still counts as sharp."""
    g = img.convert("L")
    lap = g.filter(ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128))
    lap = lap.crop((2, 2, lap.size[0] - 2, lap.size[1] - 2))   # the filter leaves the edge pixels untouched
    w, h = lap.size
    best = 0.0
    for ty in range(4):
        for tx in range(4):
            box = (tx * w // 4, ty * h // 4, (tx + 1) * w // 4, (ty + 1) * h // 4)
            best = max(best, ImageStat.Stat(lap.crop(box)).var[0])

    # busyness: share of the picture covered by strong edges
    lh = lap.histogram()
    edges = (sum(lh[:108]) + sum(lh[149:])) / float(sum(lh) or 1)
    # calm space and where the detail sits (8 x 8 grid of detail energy)
    energy, calm = [], 0
    for ty in range(8):
        for tx in range(8):
            box = (tx * w // 8, ty * h // 8, (tx + 1) * w // 8, (ty + 1) * h // 8)
            v = ImageStat.Stat(lap.crop(box)).var[0]
            energy.append((tx, ty, v))
            if v < 12:
                calm += 1
    tot = sum(v for _, _, v in energy) or 1.0
    top = sorted((v for _, _, v in energy), reverse=True)
    concentration = sum(top[:16]) / tot                      # 1.0 = all the detail in a quarter of the frame
    cx = sum((tx + 0.5) / 8 * v for tx, _, v in energy) / tot
    cy = sum((ty + 0.5) / 8 * v for _, ty, v in energy) / tot
    thirds = min(math.hypot(cx - a, cy - b) for a in (1 / 3.0, 2 / 3.0) for b in (1 / 3.0, 2 / 3.0))
    centered = math.hypot(cx - 0.5, cy - 0.5)

    # colour: vividness (Hasler & Suesstrunk) and how simple the palette is
    small = img.convert("RGB").resize((96, 72))
    rg, yb = [], []
    for r, gg, b in small.getdata():
        rg.append(r - gg)
        yb.append(0.5 * (r + gg) - b)
    def _ms(a):
        m = sum(a) / len(a)
        return m, math.sqrt(sum((x - m) ** 2 for x in a) / len(a))
    (mrg, srg), (myb, syb) = _ms(rg), _ms(yb)
    colorful = (math.hypot(srg, syb) + 0.3 * math.hypot(mrg, myb)) / 100.0
    hsv = small.convert("HSV")
    bins = [0.0] * 18
    for hh, ss, vv in hsv.getdata():
        if ss > 40 and vv > 40:
            bins[hh * 18 // 256] += ss
    bt = sum(bins)
    if bt:
        ent = -sum((b / bt) * math.log(b / bt) for b in bins if b) / math.log(18)
    else:
        ent = 0.0
    sat = ImageStat.Stat(img.convert("HSV").split()[1]).mean[0] / 255.0

    hist = g.histogram()
    total = float(sum(hist)) or 1.0
    mean = sum(i * c for i, c in enumerate(hist)) / total
    dark = sum(hist[:25]) / total
    bright = sum(hist[248:]) / total
    return {"sharp": round(best, 1), "mean": round(mean, 1), "dark": round(dark, 3), "bright": round(bright, 3),
            "sat": round(sat, 3), "portrait": 1 if h > w else 0,
            "busy": round(edges, 3), "calm": round(calm / 64.0, 3), "focus": round(concentration, 3),
            "thirds": round(thirds, 3), "centered": round(centered, 3),
            "colorful": round(colorful, 3), "palette": round(ent, 3)}


def scene_sig(img):
    """A compact 'look' of a photo: its colour mix plus a coarse colour layout. Photos from the
    same occasion (same place, light, clothes) tend to have similar signatures."""
    small = img.convert("RGB").resize((64, 48))
    hsv = small.convert("HSV")
    bins = [0] * 54
    for hh, ss, vv in hsv.getdata():
        bins[(hh * 6 // 256) * 9 + (ss * 3 // 256) * 3 + (vv * 3 // 256)] += 1
    total = float(sum(bins)) or 1.0
    hist = [min(255, int(round(b / total * 255 * 4))) for b in bins]
    lay = small.resize((4, 4), Image.BILINEAR)
    layout = [c for px in lay.getdata() for c in px]
    return bytes(hist + layout).hex()


def scene_similarity(a, b):
    """0..1: colour-mix overlap (70%) and layout closeness (30%)."""
    ba, bb = bytes.fromhex(a), bytes.fromhex(b)
    ha, hb = ba[:54], bb[:54]
    inter = sum(min(x, y) for x, y in zip(ha, hb)) / float(max(1, min(sum(ha), sum(hb))))
    la, lb = ba[54:], bb[54:]
    dist = math.sqrt(sum((x - y) ** 2 for x, y in zip(la, lb)) / len(la)) / 255.0
    return 0.7 * min(1.0, inter) + 0.3 * max(0.0, 1 - dist * 2.5)


def appeal_of(q):
    """A starting guess at the photos you'll love, from what you said you like:
    not busy, good colour, a clear well-placed subject. Learning from your choices refines it."""
    if not q or "busy" not in q:
        return None, []
    parts = {
        "Simple": (1 - min(1.0, q["busy"] / 0.35)) * 0.6 + q["calm"] * 0.4,
        "Colorful": min(1.0, q["colorful"] / 0.9),
        "Harmonious colors": (1 - q["palette"]) if q["colorful"] > 0.25 else 0.4,
        "Nice composition": max(0.0, 1 - q["thirds"] / 0.2) * 0.6 + max(0.0, (q["focus"] - 0.4) / 0.6) * 0.4,
    }
    score = (0.35 * parts["Simple"] + 0.25 * parts["Colorful"] + 0.15 * parts["Harmonious colors"]
             + 0.25 * parts["Nice composition"])
    reasons = [k for k, v in sorted(parts.items(), key=lambda kv: -kv[1]) if v >= 0.6][:2]
    return round(score, 3), reasons


def find_sidecar(full):
    """Google Takeout writes a .json next to each photo with date and location."""
    d, fn = os.path.split(full)
    stem = os.path.splitext(fn)[0]
    for cand in (fn + ".json", fn + ".supplemental-metadata.json", stem + ".json"):
        p = os.path.join(d, cand)
        if os.path.isfile(p):
            return p
    return None


def read_sidecar(full):
    p = find_sidecar(full)
    if not p:
        return None, None, None
    try:
        with open(p, encoding="utf-8") as f:
            j = json.load(f)
    except Exception:
        return None, None, None
    taken = None
    ts = (j.get("photoTakenTime") or {}).get("timestamp")
    try:
        if ts:
            taken = dt.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%dT%H:%M:%S")
    except (ValueError, OSError):
        taken = None
    lat = lon = None
    for key in ("geoDataExif", "geoData"):
        g = j.get(key) or {}
        try:
            la, lo = float(g.get("latitude", 0)), float(g.get("longitude", 0))
        except (TypeError, ValueError):
            continue
        if abs(la) > 0.0001 or abs(lo) > 0.0001:
            lat, lon = la, lo
            break
    return parse_iso(taken), lat, lon


def valid_coords(lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None, None
    if abs(lat) > 90 or abs(lon) > 180 or (abs(lat) < 0.0001 and abs(lon) < 0.0001):
        return None, None
    return round(lat, 6), round(lon, 6)


def unique_path(full):
    """Add ' 2', ' 3'... before the extension until the path is free."""
    if not os.path.exists(full):
        return full
    base, ext = os.path.splitext(full)
    n = 2
    while os.path.exists("%s %d%s" % (base, n, ext)):
        n += 1
    return "%s %d%s" % (base, n, ext)


def move_file(src, dst):
    """Rename/move a file, never replacing a different file that's already there."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if src.lower() == dst.lower() and src != dst:   # only the capitals change (exFAT/APFS ignore case)
        tmp = "%s.renaming-%d" % (dst, os.getpid())
        n = 0
        while os.path.exists(tmp):
            n += 1
            tmp = "%s.renaming-%d-%d" % (dst, os.getpid(), n)
        os.rename(src, tmp)
        try:
            os.rename(tmp, dst)
        except OSError:
            os.rename(tmp, src)
            raise
        return
    if os.path.exists(dst):
        try:
            same = os.path.samefile(src, dst)
        except OSError:
            same = False
        if not same:
            raise OSError("A file named %s is already there." % os.path.basename(dst))
    os.rename(src, dst)


# --------------------------------------------------------------------------- #
# ExifTool (kept running in the background for speed)
# --------------------------------------------------------------------------- #

class ExifTool:
    def __init__(self):
        self.path = os.environ.get("EXIFTOOL") or shutil.which("exiftool")
        local = os.path.join(app_dir(), "exiftool", "exiftool")
        if not self.path and os.path.exists(local):
            self.path = local
        self.proc = None
        self.lock = threading.Lock()
        self.err_buf = ""
        self.err_cond = threading.Condition()

    @property
    def available(self):
        return bool(self.path)

    def _start(self):
        if not self.path:
            raise RuntimeError("ExifTool isn't installed. Start the app with the launcher so it can set it up.")
        cmd = [self.path, "-stay_open", "True", "-@", "-", "-common_args", "-charset", "filename=utf8"]
        if self.path.endswith(".pl") or not os.access(self.path, os.X_OK):
            cmd = ["perl"] + cmd
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        threading.Thread(target=self._drain_err, args=(self.proc,), daemon=True).start()

    def _drain_err(self, proc):
        for line in iter(proc.stderr.readline, b""):
            with self.err_cond:
                self.err_buf += line.decode("utf-8", "replace")
                self.err_cond.notify_all()

    def _kill(self):
        try:
            if self.proc:
                self.proc.kill()
        except Exception:
            pass
        self.proc = None

    def run(self, args, binary=False, timeout=180):
        import select
        with self.lock:
            if not self.proc or self.proc.poll() is not None:
                self._start()
            self.seq = getattr(self, "seq", 0) + 1
            n = self.seq
            with self.err_cond:
                self.err_buf = ""
            payload = "\n".join(list(args) + ["-echo4", "{done%d}" % n, "-execute%d" % n]) + "\n"
            try:
                self.proc.stdin.write(payload.encode("utf-8"))
                self.proc.stdin.flush()
            except OSError:
                self._kill()
                raise RuntimeError("ExifTool stopped unexpectedly")
            out = b""
            fd = self.proc.stdout.fileno()
            marker = b"{ready%d}" % n
            deadline = time.time() + timeout
            while True:
                left = deadline - time.time()
                if left <= 0 or not select.select([fd], [], [], left)[0]:
                    self._kill()   # a stuck file: start fresh next time instead of freezing the app
                    raise RuntimeError("ExifTool took too long on %s" % os.path.basename(str(args[-1])))
                chunk = os.read(fd, 1 << 16)
                if not chunk:
                    self.proc = None
                    raise RuntimeError("ExifTool stopped unexpectedly")
                out += chunk
                if out[-40:].rstrip().endswith(marker):
                    break
            out = out[:out.rstrip().rfind(marker)]
            done = "{done%d}" % n
            deadline = time.time() + 15
            with self.err_cond:
                while done not in self.err_buf and time.time() < deadline:
                    self.err_cond.wait(0.25)
                err = re.sub(r"\{done\d+\}", "", self.err_buf).strip()
                self.err_buf = ""
            if binary:
                return out, err
            return out.decode("utf-8", "replace"), err

    def read(self, paths):
        if not paths:
            return {}
        args = ["-json", "-fast", "-d", "%Y-%m-%dT%H:%M:%S", "-api", "QuickTimeUTC=1",
                "-DateTimeOriginal", "-CreationDate", "-CreateDate", "-MediaCreateDate",
                "-Composite:GPSLatitude#", "-Composite:GPSLongitude#",
                "-ImageWidth#", "-ImageHeight#", "-Orientation#", "-Make", "-Model",
                "-XMP-dc:Subject", "-IPTC:Keywords", "-XMP-xmp:Rating#"] + list(paths)
        out, _ = self.run(args)
        result = {}
        out = out.strip()
        if not out:
            return result
        try:
            for item in json.loads(out):
                result[item.get("SourceFile")] = item
        except ValueError:
            pass
        return result

    def preview(self, path):
        """The JPEG a RAW file carries inside it. Several helper ExifTools share this work,
        so previews for many photos are made at the same time."""
        if not hasattr(self, "_pool"):
            with self.lock:
                if not hasattr(self, "_pool"):
                    import queue
                    self._pool = queue.Queue()
                    self._pool_n = 0
                    self._pool_lock = threading.Lock()
                    self._tag_for = {}
        import queue
        try:
            et = self._pool.get_nowait()
        except queue.Empty:
            with self._pool_lock:
                grow = self._pool_n < 3
                if grow:
                    self._pool_n += 1
            et = ExifTool() if grow else self._pool.get()
            et.path = self.path
        try:
            ext = os.path.splitext(path)[1].lower()
            tags = ["-JpgFromRaw", "-PreviewImage"]
            if self._tag_for.get(ext) == "-PreviewImage":
                tags.reverse()
            for tag in tags:
                data, _ = et.run(["-b", tag, path], binary=True)
                if data and data[:2] == b"\xff\xd8":
                    self._tag_for[ext] = tag
                    return data
            return None
        finally:
            self._pool.put(et)

    def write(self, path, args):
        out, err = self.run(["-overwrite_original", "-m"] + args + [path])
        ok = ("1 image files updated" in out) or ("1 image files unchanged" in out)
        return ok, (err or out).strip()


# --------------------------------------------------------------------------- #
# Offline place names (GeoNames, downloaded once, ~12 MB)
# --------------------------------------------------------------------------- #

def fold(text):
    """Lower-case and drop accents, so 'cote' finds 'Côte'."""
    import unicodedata
    t = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in t if not unicodedata.combining(c)).lower().strip()


def fmt_bytes(n):
    n = float(n or 0)
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return ("%d %s" if unit == "bytes" else "%.1f %s") % (n, unit)
        n /= 1000.0


def pmtiles_tool():
    for d in (os.environ.get("PO_BIN_DIR"), os.path.join(app_dir(), "bin")):
        if d and os.path.exists(os.path.join(d, "pmtiles")):
            return os.path.join(d, "pmtiles")
    return shutil.which("pmtiles")


def latest_map_build():
    """Newest worldwide OpenStreetMap map from Protomaps (only needed to download a region)."""
    req = urllib.request.Request("https://build-metadata.protomaps.dev/builds.json", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            builds = json.load(r)
    except Exception as e:
        raise RuntimeError("Downloading maps needs an internet connection (%s)." % e)
    key = sorted(b["key"] for b in builds)[-1]
    return "https://build.protomaps.com/" + key


# west, south, east, north
MAP_PRESETS = [
    {"name": "Eastern Caribbean", "bbox": [-65.6, 10.0, -59.3, 18.8]},
    {"name": "Grenada & the Grenadines", "bbox": [-61.9, 11.9, -61.1, 13.45]},
    {"name": "Virgin Islands", "bbox": [-65.2, 17.6, -64.2, 18.8]},
    {"name": "Bahamas", "bbox": [-79.6, 20.8, -72.6, 27.4]},
    {"name": "California", "bbox": [-124.5, 32.5, -114.1, 42.05]},
    {"name": "Lake Tahoe area", "bbox": [-120.35, 38.75, -119.8, 39.35]},
    {"name": "Florida", "bbox": [-87.7, 24.4, -79.9, 31.1]},
    {"name": "New York City", "bbox": [-74.3, 40.45, -73.65, 40.95]},
    {"name": "Italy", "bbox": [6.6, 35.4, 18.6, 47.1]},
    {"name": "France", "bbox": [-5.2, 41.3, 9.7, 51.2]},
    {"name": "Spain & Portugal", "bbox": [-9.6, 35.9, 4.4, 43.9]},
    {"name": "Greece", "bbox": [19.3, 34.7, 29.7, 41.8]},
    {"name": "United Kingdom & Ireland", "bbox": [-10.7, 49.8, 1.9, 60.9]},
    {"name": "Mexico", "bbox": [-118.5, 14.5, -86.7, 32.8]},
    {"name": "United States (very large)", "bbox": [-125.0, 24.4, -66.9, 49.4]},
]


FEATURE_KIND = {"LK": "Lake", "LKS": "Lakes", "RSV": "Reservoir", "BAY": "Bay", "BAYS": "Bays", "COVE": "Cove",
                "ANCH": "Anchorage", "HBR": "Harbour", "MAR": "Marina", "ISL": "Island", "ISLS": "Islands",
                "ATOL": "Atoll", "RF": "Reef", "BCH": "Beach", "MT": "Mountain", "MTS": "Mountains", "PK": "Peak",
                "VLC": "Volcano", "PRK": "Park", "RESN": "Nature reserve", "ADM1": "State / region",
                "ADM2": "County / region", "PCLI": "Country", "PCLD": "Country", "TERR": "Territory",
                "RGN": "Region", "VAL": "Valley", "CAPE": "Cape", "PEN": "Peninsula", "GLCR": "Glacier",
                "FLLS": "Waterfall", "STM": "River", "SEA": "Sea", "STRT": "Strait", "GULF": "Gulf",
                "HTL": "Hotel", "RSRT": "Resort", "AIRP": "Airport", "MUS": "Museum", "CSTL": "Castle",
                "CH": "Church", "MNMT": "Monument", "HSTS": "Historic site", "RUIN": "Ruins", "PAL": "Palace",
                "ZOO": "Zoo", "SQR": "Square", "BDG": "Bridge", "LTHSE": "Lighthouse", "UNIV": "University",
                "STDM": "Stadium", "AMUS": "Theme park", "VIN": "Vineyard", "DAM": "Dam", "LGN": "Lagoon"}
FEATURE_WEIGHT = {"PCLI": 5000000, "PCLD": 3000000, "TERR": 2000000, "ADM1": 1000000, "SEA": 800000,
                  "RGN": 400000, "ISLS": 150000, "LK": 120000, "ISL": 100000, "MTS": 90000, "BAY": 80000,
                  "GULF": 80000, "ADM2": 60000, "PRK": 60000, "MT": 50000, "PK": 50000, "VLC": 50000}
FEATURE_ZOOM = {"PCLI": 5, "PCLD": 5, "TERR": 7, "ADM1": 6, "ADM2": 9, "SEA": 5, "RGN": 7, "ISLS": 11,
                "LK": 10, "BAY": 11, "GULF": 7, "MTS": 8, "ISL": 12, "PRK": 11, "ANCH": 14, "MAR": 15,
                "HTL": 16, "RSRT": 15, "BCH": 15, "COVE": 14, "HBR": 14, "MUS": 16, "CSTL": 16, "CH": 16}


class Geo:
    SOURCES = {
        "cities500.zip": "https://download.geonames.org/export/dump/cities500.zip",
        "admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
        "countryInfo.txt": "https://download.geonames.org/export/dump/countryInfo.txt",
    }

    def __init__(self):
        self.dir = os.path.join(app_dir(), "geo")
        bundled = os.environ.get("PO_GEO_DIR")   # the Mac app carries the place names inside it
        if bundled and all(os.path.exists(os.path.join(bundled, n)) for n in self.SOURCES):
            self.dir = bundled
        self.grid = None
        self.names = None
        self.lock = threading.Lock()
        self.error = None

    def ready(self):
        return all(os.path.exists(os.path.join(self.dir, n)) for n in self.SOURCES)

    def ensure(self, job=None):
        os.makedirs(self.dir, exist_ok=True)
        for name, url in self.SOURCES.items():
            dest = os.path.join(self.dir, name)
            if os.path.exists(dest):
                continue
            if job:
                job.message = "Downloading place names (one time only)…"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest + ".part", "wb") as f:
                shutil.copyfileobj(r, f)
            os.rename(dest + ".part", dest)

    def load(self, job=None):
        with self.lock:
            if self.grid is not None:
                return True
            try:
                self.ensure(job)
            except Exception as e:
                self.error = "Couldn't download place names (%s). They'll be added next time you're online." % e
                return False
            if job:
                job.message = "Loading place names…"
            countries = {}
            with open(os.path.join(self.dir, "countryInfo.txt"), encoding="utf-8") as f:
                for line in f:
                    if line.startswith("#"):
                        continue
                    p = line.rstrip("\n").split("\t")
                    if len(p) > 4:
                        countries[p[0]] = p[4]
            admin1 = {}
            with open(os.path.join(self.dir, "admin1CodesASCII.txt"), encoding="utf-8") as f:
                for line in f:
                    p = line.rstrip("\n").split("\t")
                    if len(p) > 1:
                        admin1[p[0]] = p[1]
            grid = defaultdict(list)
            names = []
            with zipfile.ZipFile(os.path.join(self.dir, "cities500.zip")) as z:
                with z.open("cities500.txt") as raw:
                    for bline in raw:
                        p = bline.decode("utf-8", "replace").rstrip("\n").split("\t")
                        if len(p) < 15:
                            continue
                        try:
                            lat, lon, pop = float(p[4]), float(p[5]), int(p[14] or 0)
                        except ValueError:
                            continue
                        if p[7] in ("PPLH", "PPLQ", "PPLW"):
                            continue   # historical, abandoned or destroyed places
                        cc = p[8]
                        entry = (lat, lon, p[1], admin1.get(cc + "." + p[10], ""),
                                 countries.get(cc, cc), pop, p[7] == "PPLX", cc, p[10], p[11])
                        grid[(int(math.floor(lat)), int(math.floor(lon)))].append(entry)
                        names.append(entry)
            self.grid = grid
            self.names = names
            self.error = None
            return True

    def nearest(self, lat, lon):
        if self.grid is None:
            return None, None
        gy, gx = int(math.floor(lat)), int(math.floor(lon))
        for r in (1, 2, 3):
            best, best_d = None, None
            for y in range(gy - r, gy + r + 1):
                for x in range(gx - r, gx + r + 1):
                    for e in self.grid.get((y, x), ()):
                        d = km_between(lat, lon, e[0], e[1])
                        if best_d is None or d < best_d:
                            best, best_d = e, d
            if best is not None and best_d <= r * 100:
                return best, best_d
        return None, None

    def main_place(self, lat, lon, radius=12):
        """The biggest town or city within `radius` km, so a stay in New York is 'New York City',
        not a different neighbourhood for every photo."""
        if self.grid is None:
            return None, None
        gy, gx = int(math.floor(lat)), int(math.floor(lon))
        best, best_d = None, None
        for y in (gy - 1, gy, gy + 1):
            for x in (gx - 1, gx, gx + 1):
                for e in self.grid.get((y, x), ()):
                    if e[6]:
                        continue   # a neighbourhood is never "the city"
                    d = km_between(lat, lon, e[0], e[1])
                    if d <= radius and (best is None or e[5] > best[5]):
                        best, best_d = e, d
        return best, best_d

    def city(self, lat, lon):
        """The town or city a photo belongs to — used for folder and file names."""
        e, d = self.main_place(lat, lon)
        if e is None:
            e, d = self.nearest(lat, lon)
        if e is None or d > 150:
            return "At sea"
        return e[2] if d <= 15 else "Near " + e[2]

    def label(self, lat, lon):
        """The exact place: the nearest named place, even a neighbourhood."""
        e, d = self.nearest(lat, lon)
        if e is None:
            return "At sea"
        name, adm, country = e[2], e[3], e[4]
        if d <= 15:
            parts = []
            for x in (name, adm, country):
                if x and x not in parts:
                    parts.append(x)
            return ", ".join(parts)
        if d <= 150:
            return "Near %s, %s" % (name, country)
        return "At sea"

    def label_with(self, name, lat, lon):
        """Label for a place the user picked by name: keep their name, add region/country."""
        e, d = self.nearest(lat, lon)
        parts = [name]
        if e is not None and d <= 60:
            if e[3] and e[3] != name:
                parts.append(e[3])
            if e[4] != name:
                parts.append(e[4])
        return ", ".join(parts)

    # ---------- richer offline place info (for the Places page) ----------
    def _extra_file(self, name):
        for d in (self.dir, os.environ.get("PO_GEO_DIR") or "", os.path.join(app_dir(), "geo")):
            if d and os.path.exists(os.path.join(d, name)):
                return os.path.join(d, name)
        return None

    def _admin2(self):
        if getattr(self, "_a2", None) is None:
            a2 = {}
            path = self._extra_file("admin2Codes.txt.gz") or self._extra_file("admin2Codes.txt")
            if path:
                opener = gzip.open if path.endswith(".gz") else open
                with opener(path, "rt", encoding="utf-8") as f:
                    for line in f:
                        p = line.rstrip("\n").split("\t")
                        if len(p) > 1:
                            a2[p[0]] = p[1]
            self._a2 = a2
        return self._a2

    def details(self, lat, lon):
        """Country, state, county/region and nearest town for a point — all offline."""
        self.load()
        out = {"country": None, "state": None, "region": None, "city": None, "city_km": None}
        e, d = self.nearest(lat, lon)
        if e is None or d > 250:
            return out
        out["country"], out["state"] = e[4] or None, e[3] or None
        if len(e) > 9 and e[9]:
            out["region"] = self._admin2().get("%s.%s.%s" % (e[7], e[8], e[9]))
        out["city"], out["city_km"] = e[2], round(d, 1)
        return out

    def _features(self):
        """Lakes, islands, bays, anchorages, mountains, parks, regions… (from GeoNames) for offline
        search, kept compact: the rows as text plus one search string of their folded names."""
        if getattr(self, "_feat", None) is None:
            rows, index = [], []
            path = self._extra_file("features.tsv.gz")
            if path:
                with gzip.open(path, "rt", encoding="utf-8") as f:
                    for line in f:
                        p = line.split("\t", 2)
                        if len(p) < 3:
                            continue
                        names = [p[0]] + [x for x in p[1].split("|") if x]
                        rows.append(line.rstrip("\n"))
                        index.append("|" + "|".join(fold(x).replace("|", " ").replace("\n", " ") for x in names) + "|")
            text = "\n".join(index) + "\n"
            starts = [0]
            for k in range(len(index) - 1):
                starts.append(starts[-1] + len(index[k]) + 1)
            self._feat = (rows, text, starts)
        return self._feat

    def _feature_hits(self, ql, cap=400):
        rows, text, starts = self._features()
        found = {}
        for rank, needle in ((0, "|" + ql + "|"), (1, "|" + ql), (2, " " + ql)):
            pos, n = 0, 0
            while n < cap:
                pos = text.find(needle, pos)
                if pos < 0:
                    break
                k = bisect.bisect_right(starts, pos) - 1
                if k not in found:
                    found[k] = rank
                    n += 1
                pos = starts[k + 1] if k + 1 < len(starts) else len(text)   # next row
        out = []
        for k, rank in found.items():
            p = rows[k].split("\t")
            if len(p) < 9:
                continue
            try:
                lat, lon, pop = float(p[2]), float(p[3]), int(p[7] or 0)
            except ValueError:
                continue
            out.append((rank, k, {"name": p[0], "lat": lat, "lon": lon, "kind": FEATURE_KIND.get(p[4], "Place"),
                                  "label": ", ".join(x for x in (p[0], p[5], p[6]) if x),
                                  "zoom": FEATURE_ZOOM.get(p[4], 11), "imp": pop + FEATURE_WEIGHT.get(p[4], 20000)}))
        return out

    def search_all(self, q, limit=12):
        """Offline search: towns and cities plus natural places and regions."""
        self.load()
        ql = fold(q)
        if len(ql) < 2:
            return []
        hits = []

        def rank(key):
            if key == ql:
                return 0
            if key.startswith(ql):
                return 1
            if (" " + ql) in key:
                return 2
            return None
        for r, k, h in self._feature_hits(ql):
            hits.append((r, -h.pop("imp") - (200000 - min(k, 200000)) * 0.001, h))   # earlier rows are better known
        if self.names is not None:
            folded = getattr(self, "_names_folded", None)
            if folded is None or len(folded) != len(self.names):
                folded = self._names_folded = [fold(e[2]) for e in self.names]
            for key, e in zip(folded, self.names):
                r = rank(key)
                if r is not None:   # real towns before districts or provinces of the same name
                    hits.append((r, -(e[5] + (2000000 if e[5] >= 50000 else 0)), {"name": e[2], "lat": e[0], "lon": e[1],
                                            "kind": "Neighbourhood" if e[6] else "Town",
                                            "label": ", ".join(x for x in (e[2], e[3], e[4]) if x),
                                            "zoom": 13 if e[5] < 100000 else 11}))
        hits.sort(key=lambda h: (h[0], h[1]))
        out, seen = [], set()
        for _, _, h in hits:
            k = (h["name"].lower(), round(h["lat"], 1), round(h["lon"], 1))
            if k not in seen:
                seen.add(k)
                out.append(h)
            if len(out) >= limit:
                break
        return out

    def warm_up(self):
        """Load the offline place list in the background so the first search is quick."""
        if getattr(self, "_feat", None) is None and not getattr(self, "_warming", False):
            self._warming = True
            threading.Thread(target=lambda: (self.load(), self._features()), daemon=True).start()

    def search_offline(self, q, limit=8):
        if self.names is None:
            return []
        ql = q.lower().strip()
        hits = [e for e in self.names if e[2].lower().startswith(ql)]
        hits.sort(key=lambda e: -e[5])
        return [{"name": e[2], "label": ", ".join([x for x in (e[2], e[3], e[4]) if x]),
                 "lat": e[0], "lon": e[1]} for e in hits[:limit]]


def search_places_online(q, limit=8):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "jsonv2", "limit": limit, "addressdetails": 1})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode("utf-8"))
    out = []
    for item in data:
        addr = item.get("address") or {}
        name = item.get("name") or item.get("display_name", "").split(",")[0]
        region = addr.get("island") or addr.get("state") or addr.get("county") or ""
        country = addr.get("country", "")
        parts = [name]
        for x in (region, country):
            if x and x not in parts:
                parts.append(x)
        out.append({"name": name, "label": ", ".join(parts),
                    "detail": item.get("display_name", ""),
                    "lat": float(item["lat"]), "lon": float(item["lon"])})
    return out


# --------------------------------------------------------------------------- #
# Background jobs
# --------------------------------------------------------------------------- #

FEATURES = 14


def pick_features(it):
    q = it["q"]
    b = it.get("burst")
    return [math.log1p(q["sharp"]) / 6.0, q["mean"] / 255.0, q["dark"], q["bright"], q.get("sat", 0.3),
            q.get("portrait", 0), 1.0 if (b and not b["best"]) else 0.0, min((b or {}).get("size", 1), 10) / 10.0,
            q.get("busy", 0.2), q.get("calm", 0.3), q.get("focus", 0.5), q.get("thirds", 0.15),
            q.get("colorful", 0.4), q.get("palette", 0.5)]


class Taste:
    """A small logistic model: what makes you keep a photo. Trained on your own choices only."""

    def __init__(self, w, b, mu, sd):
        self.w, self.b, self.mu, self.sd = w, b, mu, sd

    @classmethod
    def train(cls, data, epochs=400, lr=0.3, l2=0.01):
        n = len(data[0][0])
        cols = list(zip(*[x for x, _, _ in data]))
        mu = [sum(c) / len(c) for c in cols]
        sd = [max(1e-6, math.sqrt(sum((v - m) ** 2 for v in c) / len(c))) for c, m in zip(cols, mu)]
        xs = [[(v - m) / s for v, m, s in zip(x, mu, sd)] for x, _, _ in data]
        ys = [y for _, y, _ in data]
        ws = [wt for _, _, wt in data]
        tw = sum(ws)
        w, b = [0.0] * n, 0.0
        for _ in range(epochs):
            gw, gb = [0.0] * n, 0.0
            for x, y, wt in zip(xs, ys, ws):
                z = b + sum(a * c for a, c in zip(w, x))
                p = 1.0 / (1.0 + math.exp(-max(-30, min(30, z))))
                e = (p - y) * wt
                gb += e
                for k in range(n):
                    gw[k] += e * x[k]
            b -= lr * gb / tw
            w = [wk - lr * (g / tw + l2 * wk) for wk, g in zip(w, gw)]
        return cls(w, b, mu, sd)

    def predict(self, x):
        z = self.b + sum(a * (v - m) / s for a, v, m, s in zip(self.w, x, self.mu, self.sd))
        return 1.0 / (1.0 + math.exp(-max(-30, min(30, z))))



def _trash_dir_for(path):
    """The Trash folder macOS uses for files on this path's drive."""
    mount = os.path.abspath(path)
    while not os.path.ismount(mount):
        mount = os.path.dirname(mount)
    if mount == "/":
        d = os.path.expanduser("~/.Trash")
    else:
        d = os.path.join(mount, ".Trashes", str(os.getuid()))
    try:
        os.makedirs(d, exist_ok=True)
        return d
    except OSError:
        return None


def trash_files(files):
    """Move files to the Mac Trash quickly. Uses macOS's own trash call when available,
    otherwise moves them into the drive's Trash folder, and only as a last resort asks Finder."""
    if not IS_MAC or not files:
        return
    left = list(files)
    try:
        from Foundation import NSFileManager, NSURL
        fm = NSFileManager.defaultManager()
        for f in left:
            try:
                fm.trashItemAtURL_resultingItemURL_error_(NSURL.fileURLWithPath_(f), None, None)
            except Exception:
                pass
        left = [f for f in left if os.path.exists(f)]
    except ImportError:
        pass
    for f in list(left):
        d = _trash_dir_for(f)
        if not d:
            continue
        base, ext = os.path.splitext(os.path.basename(f))
        dest, n = os.path.join(d, base + ext), 2
        while os.path.exists(dest):
            dest, n = os.path.join(d, "%s %d%s" % (base, n, ext)), n + 1
        try:
            os.rename(f, dest)
        except OSError:
            pass
    left = [f for f in left if os.path.exists(f)]
    for k in range(0, len(left), 40):
        items = ", ".join('POSIX file "%s"' % f.replace("\\", "\\\\").replace('"', '\\"') for f in left[k:k + 40])
        try:
            subprocess.run(["osascript", "-e", 'tell application "Finder" to delete {%s}' % items],
                           capture_output=True, timeout=300)
        except Exception:
            pass


class Job:
    _next = [0]

    def __init__(self, name):
        Job._next[0] += 1
        self.id = "%d-%d" % (int(time.time()), Job._next[0])
        self.name = name
        self.phase = ""
        self.done = 0
        self.total = 0
        self.message = ""
        self.error = None
        self.finished = False
        self.result = None

    def step(self, phase, total=0):
        self.phase, self.done, self.total, self.message = phase, 0, total, ""

    def to_dict(self):
        return {"id": self.id, "name": self.name, "phase": self.phase, "done": self.done, "total": self.total,
                "message": self.message, "error": self.error, "finished": self.finished,
                "result": self.result}


# --------------------------------------------------------------------------- #
# The library
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE, size INTEGER, mtime REAL, kind TEXT,
  taken TEXT, date_source TEXT, lat REAL, lon REAL, gps_source TEXT, place TEXT,
  width INTEGER, height INTEGER, orientation INTEGER, camera TEXT,
  sha256 TEXT, dhash TEXT, thumb INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', orig_path TEXT,
  gps_pending INTEGER DEFAULT 0, date_pending INTEGER DEFAULT 0,
  loc_skip INTEGER DEFAULT 0, title TEXT);
CREATE INDEX IF NOT EXISTS files_status ON files(status);
CREATE INDEX IF NOT EXISTS files_taken ON files(taken);
CREATE INDEX IF NOT EXISTS files_size ON files(size);
CREATE TABLE IF NOT EXISTS dup_ok(key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS picks(key TEXT PRIMARY KEY, features TEXT, keep INTEGER, overridden INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS faces(
  id INTEGER PRIMARY KEY, file_id INTEGER, x REAL, y REAL, w REAL, h REAL, score REAL, size REAL,
  emb BLOB, person_id INTEGER, status TEXT DEFAULT 'unknown', cluster INTEGER, not_person INTEGER);
CREATE INDEX IF NOT EXISTS faces_file ON faces(file_id);
CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);
CREATE TABLE IF NOT EXISTS people(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS my_places(id INTEGER PRIMARY KEY, name TEXT, lat REAL, lon REAL,
  precision TEXT DEFAULT 'exact', radius REAL, type TEXT, tags TEXT, notes TEXT, starred INTEGER DEFAULT 0,
  country TEXT, state TEXT, region TEXT, city TEXT, cover_id INTEGER, created TEXT);
"""

DEFAULT_SETTINGS = {"folders": "month_group", "time": "1", "highlights": "5", "faces": "off"}
FACE_MATCH = 0.5      # faceprints this alike (0..1) are treated as the same person
HIGHLIGHTS_RE = re.compile(r"^\d{4} Highlights$")
GROUP_GAP = 14 * 86400   # photos sharing a name more than two weeks apart are separate trips
NEEDS_DATE = ("file",)            # no date anywhere: the person adds one
NEEDS_TIME = ("filename",)        # date from the old file name, but no time
NO_TIME = ("filename", "manual_date")
NEEDS_SQL = "date_source IN ('file', 'filename')"


class Library:
    def __init__(self, root, exiftool=None, geo=None):
        self.root = os.path.abspath(root)
        if not os.path.isdir(self.root):
            raise ValueError("That folder doesn't exist: %s" % root)
        self.data = os.path.join(self.root, DATA_DIR)
        for sub in ("", "thumbs", "previews", "logs"):
            os.makedirs(os.path.join(self.data, sub), exist_ok=True)
        self.db = sqlite3.connect(os.path.join(self.data, "catalog.db"), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript(SCHEMA)
            try:   # plain rollback journal (safest on removable exFAT drives), kept between saves
                self.db.execute("PRAGMA journal_mode=PERSIST")     # no create/delete of a file per save
                self.db.execute("PRAGMA synchronous=NORMAL")
                self.db.execute("PRAGMA temp_store=MEMORY")
                self.db.execute("PRAGMA cache_size=-20000")
            except sqlite3.DatabaseError:
                pass
            for ix in ("CREATE INDEX IF NOT EXISTS files_pair ON files(pair_of)",
                       "CREATE INDEX IF NOT EXISTS files_batch ON files(batch)",
                       "CREATE INDEX IF NOT EXISTS files_status_taken ON files(status, taken)"):
                try:
                    self.db.execute(ix)
                except sqlite3.DatabaseError:
                    pass
            cols = {r[1] for r in self.db.execute("PRAGMA table_info(files)").fetchall()}
            for col, typ in (("tags", "TEXT"), ("tags_pending", "INTEGER DEFAULT 0"), ("batch", "TEXT"),
                             ("filedates", "INTEGER DEFAULT 0"), ("city", "TEXT"),
                             ("rating", "INTEGER"), ("rating_pending", "INTEGER DEFAULT 0"),
                             ("scene", "TEXT"), ("faces_done", "INTEGER DEFAULT 0"), ("people", "TEXT"),
                             ("pair_of", "INTEGER"), ("gps_precision", "TEXT"), ("gps_radius", "REAL"),
                             ("place_id", "INTEGER")):
                if col not in cols:
                    self.db.execute("ALTER TABLE files ADD COLUMN %s %s" % (col, typ))
            self.db.commit()
        self.et = exiftool or ExifTool()
        self.geo = geo or Geo()
        self.job = None
        self._job_lock = threading.Lock()
        self._dupe_lock = threading.Lock()
        self._dupe_gen = 0
        self._dup_count = None
        self._batch_depth = 0
        self._uncommitted = 0
        self.pending_import = None
        self._dupes = None
        self._loc = None
        self._gm = None

    # ---------- db helpers ----------
    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def x(self, sql, args=(), many=False):
        with self.lock:
            if many:
                self.db.executemany(sql, args)
            else:
                self.db.execute(sql, args)
            self._uncommitted += 1
            if self._batch_depth == 0 or self._uncommitted >= 300:
                self.db.commit()
                self._uncommitted = 0

    @contextlib.contextmanager
    def batch(self):
        """Save the catalog once per few hundred changes instead of after every one —
        each save is slow on an exFAT drive."""
        with self.lock:
            self._batch_depth += 1
        try:
            yield
        finally:
            with self.lock:
                self._batch_depth -= 1
                if self._batch_depth == 0:
                    self.db.commit()
                    self._uncommitted = 0

    def full(self, rel):
        return os.path.join(self.root, rel)

    def invalidate(self):
        self._dupes = None
        self._dupe_gen = getattr(self, "_dupe_gen", 0) + 1
        self._loc = None
        self._gm = None
        self._raws = None

    # ---------- settings ----------
    def settings(self):
        s = dict(DEFAULT_SETTINGS)
        for r in self.q("SELECT key, value FROM settings"):
            s[r["key"]] = r["value"]
        return s

    def set_settings(self, values):
        rows = [(k, str(v)) for k, v in values.items() if k in DEFAULT_SETTINGS]
        self.x("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", rows, many=True)

    # ---------- jobs ----------
    def busy(self):
        return bool(self.job and not self.job.finished)

    def start_job(self, name, fn, *args):
        with self._job_lock:
            if self.job and not self.job.finished:
                raise RuntimeError("Please wait — '%s' is still running." % self.job.name)
            job = Job(name)
            self.job = job

        def runner():
            try:
                job.result = fn(job, *args)
            except Exception as e:  # show the problem in the app
                import traceback
                traceback.print_exc()
                job.error = str(e)
            finally:
                with self.lock:
                    if self._uncommitted:
                        self.db.commit()
                        self._uncommitted = 0
                self.invalidate()
                job.finished = True
        threading.Thread(target=runner, daemon=True).start()
        return job

    # ---------- stats ----------
    def stats(self):
        r = self.q("""SELECT
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status='active' AND kind='photo' THEN 1 ELSE 0 END) AS photos,
            SUM(CASE WHEN status='active' AND kind='video' THEN 1 ELSE 0 END) AS videos,
            SUM(CASE WHEN status='active' AND lat IS NULL AND loc_skip=0 AND pair_of IS NULL THEN 1 ELSE 0 END) AS no_location,
            SUM(CASE WHEN status='set_aside' THEN 1 ELSE 0 END) AS set_aside,
            SUM(CASE WHEN status='active' AND batch IS NOT NULL AND pair_of IS NULL THEN 1 ELSE 0 END) AS inbox,
            SUM(CASE WHEN status='active' AND pair_of IS NOT NULL THEN 1 ELSE 0 END) AS raw_pairs
            FROM files""")[0]
        out = {k: (v or 0) for k, v in r.items()}
        out["dup_groups"] = self._dup_count
        return out

    # ======================================================================= #
    # Scanning
    # ======================================================================= #

    # trash / recycle bins and system folders that Mac or Windows keep on a drive
    SYSTEM_DIRS = {"$recycle.bin", "recycler", "recycled", "system volume information",
                   "trash", "trashes", "network trash folder", "temporary items", "found.000", "lost+found"}

    def _walk(self, top, skip_library_dirs=True, errors=None):
        def onerror(e):
            if errors is not None:
                errors.append(e)
        for dirpath, dirnames, filenames in os.walk(top, onerror=onerror):
            rel_dir = os.path.relpath(dirpath, top)
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".")
                                 and d.lower() not in self.SYSTEM_DIRS
                                 and not (skip_library_dirs and rel_dir == "." and
                                          (d == SET_ASIDE or HIGHLIGHTS_RE.match(d))))
            for fn in sorted(filenames):
                if fn.startswith("."):          # includes macOS '._' shadow files on exFAT drives
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if ext in PHOTO_EXT or ext in VIDEO_EXT:
                    yield os.path.join(dirpath, fn), (fn if rel_dir == "." else os.path.join(rel_dir, fn))

    def scan(self, job, batch=None, only=None):
        """Look for new, changed and removed photos — on the whole drive, or with `only`
        just inside one folder (e.g. the photos an import just copied)."""
        first_scan = self.q("SELECT COUNT(*) AS n FROM files")[0]["n"] == 0
        if batch is None and not first_scan:
            batch = "scan-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        job.step("Finding photos")
        found, errors = {}, []
        top = self.full(only) if only else self.root
        for full, rel in self._walk(top, errors=errors):
            if only:
                rel = os.path.join(only, rel)
            try:
                st = os.stat(full)
            except OSError as e:
                errors.append(e)
                continue
            found[rel] = (st.st_size, st.st_mtime)
            if len(found) % 500 == 0:
                job.message = "%s found so far" % format(len(found), ",")

        existing = {r["path"]: r for r in self.q(
            "SELECT id, path, size, mtime FROM files WHERE status='active'")}
        if only:
            pre = only.rstrip(os.sep) + os.sep
            existing = {k: v for k, v in existing.items() if k.startswith(pre)}
        gone = [r["id"] for p, r in existing.items() if p not in found]
        if not os.path.isdir(self.root) or (existing and not found):
            raise RuntimeError("I can't see your photo drive any more. Is it still plugged in?")
        if errors:   # some folders couldn't be read — keep everything rather than forget photos
            gone = []
        if gone:
            self.x("DELETE FROM files WHERE id=?", [(i,) for i in gone], many=True)
            for i in gone:
                self._drop_thumb(i)
        todo = [p for p, (size, mtime) in found.items()
                if p not in existing or existing[p]["size"] != size
                or abs((existing[p]["mtime"] or 0) - mtime) > 1]

        job.step("Reading dates and locations", len(todo))
        for i in range(0, len(todo), 150):
            chunk = todo[i:i + 150]
            info = self.et.read([self.full(p) for p in chunk])
            rows = []
            for rel in chunk:
                meta = self._meta(rel, info.get(self.full(rel)) or {}, found[rel])
                if rel not in existing:
                    meta["batch"] = batch
                meta["date_pending"] = 0 if meta["date_source"] == "exif" else 1
                meta["gps_pending"] = 1 if meta["gps_source"] == "sidecar" else 0
                rows.append(meta)
            with self.lock:
                for m in rows:
                    old = existing.get(m["path"])
                    if old:
                        # dates, places, tags and stars you set that aren't saved into the file yet are kept
                        self.db.execute("""UPDATE files SET size=:size, mtime=:mtime, kind=:kind,
                            taken=CASE WHEN %(md)s THEN taken ELSE :taken END,
                            date_source=CASE WHEN %(md)s THEN date_source ELSE :date_source END,
                            date_pending=CASE WHEN %(md)s THEN 1 ELSE :date_pending END,
                            lat=CASE WHEN %(mg)s THEN lat ELSE :lat END,
                            lon=CASE WHEN %(mg)s THEN lon ELSE :lon END,
                            place=CASE WHEN %(mg)s THEN place ELSE NULL END,
                            gps_pending=CASE WHEN %(mg)s THEN 1 ELSE :gps_pending END,
                            gps_source=CASE WHEN %(mg)s THEN gps_source ELSE :gps_source END,
                            width=:width, height=:height, orientation=:orientation,
                            camera=:camera, sha256=NULL, dhash=NULL, thumb=0,
                            tags=CASE WHEN tags_pending=1 THEN tags ELSE :tags END,
                            rating=CASE WHEN rating_pending=1 THEN rating ELSE :rating END,
                            filedates=0, faces_done=0 WHERE id=:id""" % {
                            "md": "(date_pending=1 AND date_source IN ('manual','manual_date','copied'))",
                            "mg": "(gps_pending=1 AND gps_source='manual')"},
                                        dict(m, id=old["id"]))
                        self._drop_thumb(old["id"])
                        self.db.execute("DELETE FROM faces WHERE file_id=?", (old["id"],))
                    else:
                        self.db.execute("""INSERT OR REPLACE INTO files(path, size, mtime, kind, taken, date_source,
                            lat, lon, gps_source, width, height, orientation, camera, tags, batch,
                            date_pending, gps_pending, filedates, rating)
                            VALUES(:path, :size, :mtime, :kind, :taken, :date_source, :lat, :lon,
                            :gps_source, :width, :height, :orientation, :camera, :tags, :batch,
                            :date_pending, :gps_pending, 0, :rating)""", m)
                self.db.commit()
            job.done = min(len(todo), i + len(chunk))

        self._pair_up()
        self._make_thumbs(job)
        self._hash_same_sizes(job)
        self._fill_places(job)
        if self.settings().get("faces") == "on":
            try:
                self.face_scan(job)
            except Exception as e:   # faces are a bonus: never let them spoil a scan
                print("face scan skipped:", e)
        s = self.stats()
        new_ids = self.q("SELECT COUNT(*) AS n FROM files WHERE status='active' AND batch=?", (batch,))[0]["n"] if batch else 0
        return {"found": len(found), "new_or_changed": len(todo), "removed": len(gone),
                "total": s["total"], "places_note": self.geo.error, "inbox_new": new_ids}

    def _pair_up(self):
        """RAW + JPEG (or HEIC) of the same shot: the JPEG leads, the RAW travels with it."""
        rows = self.q("SELECT id, path, kind, taken, date_source, camera, pair_of FROM files WHERE status='active' AND kind='photo'")
        by_stem = defaultdict(list)
        for r in rows:
            d, fn = os.path.split(r["path"])
            by_stem[(d.lower(), os.path.splitext(fn)[0].lower())].append(r)
        pair = {}
        for group in by_stem.values():
            raws = [r for r in group if os.path.splitext(r["path"])[1].lower() in RAW_EXT]
            lead = [r for r in group if os.path.splitext(r["path"])[1].lower() not in RAW_EXT]
            if len(raws) == 1 and len(lead) == 1:
                pair[raws[0]["id"]] = lead[0]["id"]
        # names that don't match: same folder, same camera, same second
        by_moment = defaultdict(list)
        for r in rows:
            if r["date_source"] == "exif" and r["camera"] and r["id"] not in pair:
                by_moment[(os.path.dirname(r["path"]).lower(), r["taken"], r["camera"])].append(r)
        led = set(pair.values())
        for group in by_moment.values():
            raws = [r for r in group if os.path.splitext(r["path"])[1].lower() in RAW_EXT and r["id"] not in pair]
            lead = [r for r in group if os.path.splitext(r["path"])[1].lower() not in RAW_EXT and r["id"] not in led]
            if len(raws) == 1 and len(lead) == 1:
                pair[raws[0]["id"]] = lead[0]["id"]
                led.add(lead[0]["id"])
        changes = [(pair.get(r["id"]), r["id"]) for r in rows if pair.get(r["id"]) != r["pair_of"]]
        if changes:
            self.x("UPDATE files SET pair_of=? WHERE id=?", changes, many=True)
        self._raws = None
        self._sync_pairs()

    def _sync_pairs(self):
        """Keep each RAW's details identical to its JPEG."""
        cols = ["taken", "date_source", "lat", "lon", "place", "city", "gps_source", "title", "tags", "rating",
                "people", "gps_pending", "date_pending", "tags_pending", "rating_pending", "loc_skip", "batch"]
        sets = ", ".join("%s=(SELECT p.%s FROM files p WHERE p.id=files.pair_of)" % (c, c) for c in cols)
        self.x("UPDATE files SET " + sets + " WHERE pair_of IS NOT NULL AND status='active'")
        self.x("UPDATE files SET filedates=0 WHERE pair_of IS NOT NULL AND status='active' AND "
               "(SELECT p.filedates FROM files p WHERE p.id=files.pair_of)=0")

    def companions(self, ids):
        ids = [int(i) for i in ids]
        if not ids:
            return []
        out = []
        for k in range(0, len(ids), 800):
            chunk = ids[k:k + 800]
            out += [r["id"] for r in self.q("SELECT id FROM files WHERE pair_of IN (%s)" % ",".join("?" * len(chunk)), chunk)]
        return out

    def _meta(self, rel, info, st):
        full = self.full(rel)
        ext = os.path.splitext(rel)[1].lower()
        kind = "video" if ext in VIDEO_EXT else "photo"
        taken, src = None, None
        for key in ("DateTimeOriginal", "CreationDate", "CreateDate", "MediaCreateDate"):
            taken = parse_iso(info.get(key))
            if taken:
                src = "exif"
                break
        lat, lon = valid_coords(info.get("GPSLatitude"), info.get("GPSLongitude"))
        gsrc = "exif" if lat is not None else None
        if taken is None or lat is None:
            s_taken, s_lat, s_lon = read_sidecar(full)
            if taken is None and s_taken:
                taken, src = s_taken, "sidecar"
            if lat is None:
                lat, lon = valid_coords(s_lat, s_lon)
                if lat is not None:
                    gsrc = "sidecar"
        if taken is None:
            fn_date, has_time, _ = date_from_filename(os.path.basename(rel))
            if fn_date:
                taken, src = fn_date, ("filename_time" if has_time else "filename")
        if taken is None:
            taken, src = dt.datetime.fromtimestamp(st[1]).strftime("%Y-%m-%dT%H:%M:%S"), "file"

        def as_int(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
        camera = " ".join(x for x in (str(info.get("Make") or "").strip(),
                                      str(info.get("Model") or "").strip()) if x) or None
        tags = []
        for key in ("Subject", "Keywords"):
            v = info.get(key)
            for t in (v if isinstance(v, list) else [v] if v else []):
                t = str(t).strip()
                if t and t.lower() not in [x.lower() for x in tags]:
                    tags.append(t)
        return {"path": rel, "size": st[0], "mtime": st[1], "kind": kind, "taken": taken,
                "tags": ", ".join(tags) or None, "batch": None, "rating": _rating(info.get("Rating")),
                "date_source": src, "lat": lat, "lon": lon, "gps_source": gsrc,
                "width": as_int(info.get("ImageWidth")), "height": as_int(info.get("ImageHeight")),
                "orientation": as_int(info.get("Orientation")), "camera": camera}

    # ---------- thumbnails ----------
    def thumb_path(self, fid):
        d = os.path.join(self.data, "thumbs", "%02x" % (fid % 256))
        made = self.__dict__.setdefault("_thumb_dirs", set())
        if d not in made:
            os.makedirs(d, exist_ok=True)
            made.add(d)
        return os.path.join(d, "%d.jpg" % fid)

    def _drop_thumb(self, fid):
        for p in (self.thumb_path(fid), os.path.join(self.data, "previews", "%d.jpg" % fid)):
            try:
                os.remove(p)
            except OSError:
                pass

    def open_image(self, full, size):
        """Open any photo as a PIL image, falling back to macOS tools for RAW/HEIC."""
        ext = os.path.splitext(full)[1].lower()
        if Image is None:
            return None
        if ext in RAW_EXT:
            data = None
            try:
                data = self.et.preview(full)
            except Exception:
                data = None
            if data:
                import io
                im = Image.open(io.BytesIO(data))
                im.draft("RGB", (size, size))
                im.load()
                return im
        else:
            try:
                im = Image.open(full)
                if im.format == "JPEG":
                    im.draft("RGB", (size, size))
                im.load()
                return im
            except Exception:
                pass
        if IS_MAC:
            tmpdir = tempfile.mkdtemp()
            out = os.path.join(tmpdir, "t.jpg")
            try:
                subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(size), full, "--out", out],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                if os.path.exists(out):
                    im = Image.open(out)
                    im.load()
                    return im
            except Exception:
                pass
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
        return None

    def video_frame(self, full):
        if not IS_MAC or Image is None:
            return None
        tmpdir = tempfile.mkdtemp()
        try:
            subprocess.run(["qlmanage", "-t", "-s", "480", "-o", tmpdir, full],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            for fn in os.listdir(tmpdir):
                if fn.lower().endswith(".png"):
                    im = Image.open(os.path.join(tmpdir, fn))
                    im.load()
                    return im
        except Exception:
            pass
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        return None

    def _thumb_one(self, fid, rel, kind):
        full = self.full(rel)
        img = None
        seed = (getattr(self, "_thumb_seed", None) or {}).get(rel)
        if seed:   # the preview made while checking the import — no need to read the big file again
            try:
                img = Image.open(seed)
                img.load()
            except Exception:
                img = None
        if img is None:
            img = self.open_image(full, 800) if kind == "photo" else self.video_frame(full)
        if img is None:
            return fid, None, False
        try:
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        img = img.convert("RGB")
        img.thumbnail((480, 480))
        img.save(self.thumb_path(fid), "JPEG", quality=82)
        dh = sc = None
        if kind == "photo":
            dh = dhash_of(img)
        try:
            sc = scene_sig(img)
        except Exception:
            sc = None
        return fid, (dh, sc), True

    def _make_thumbs(self, job):
        rows = self.q("SELECT id, path, kind FROM files WHERE status='active' AND thumb=0 AND pair_of IS NULL")
        job.step("Making previews", len(rows))
        if not rows:
            return
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self._thumb_one, r["id"], r["path"], r["kind"]) for r in rows]
            pending = []
            for f in as_completed(futures):
                try:
                    fid, sigs, ok = f.result()
                except Exception:
                    continue
                finally:
                    job.done += 1
                dh, sc = sigs if sigs else (None, None)
                pending.append((dh, sc, 1 if ok else 2, fid))
                if len(pending) >= 100:
                    self.x("UPDATE files SET dhash=?, scene=?, thumb=? WHERE id=?", pending, many=True)
                    pending = []
            if pending:
                self.x("UPDATE files SET dhash=?, scene=?, thumb=? WHERE id=?", pending, many=True)

    def _hash_same_sizes(self, job):
        rows = self.q("""SELECT id, path FROM files WHERE status='active' AND sha256 IS NULL AND size IN
            (SELECT size FROM files WHERE status='active' GROUP BY size HAVING COUNT(*) > 1)""")
        job.step("Checking for exact copies", len(rows))
        if not rows:
            return

        def work(r):
            try:
                return r["id"], sha256_of(self.full(r["path"]))
            except OSError:
                return r["id"], None
        with ThreadPoolExecutor(max_workers=2) as pool:
            batch = []
            for fid, h in pool.map(work, rows):
                job.done += 1
                if h:
                    batch.append((h, fid))
                if len(batch) >= 200:
                    self.x("UPDATE files SET sha256=? WHERE id=?", batch, many=True)
                    batch = []
            if batch:
                self.x("UPDATE files SET sha256=? WHERE id=?", batch, many=True)

    def _fill_places(self, job=None):
        rows = self.q("SELECT id, lat, lon, place FROM files WHERE lat IS NOT NULL AND (place IS NULL OR city IS NULL)")
        if not rows:
            return
        if job:
            job.step("Naming places", len(rows))
        if not self.geo.load(job):
            return
        cache, batch = {}, []
        for r in rows:
            key = (round(r["lat"], 4), round(r["lon"], 4))
            if key not in cache:
                cache[key] = (self.geo.label(r["lat"], r["lon"]), self.geo.city(r["lat"], r["lon"]))
            place, city = cache[key]
            batch.append((r["place"] or place, city, r["id"]))
            if job:
                job.done += 1
        self.x("UPDATE files SET place=?, city=? WHERE id=?", batch, many=True)
        self._gm = None

    # ======================================================================= #
    # Import new photos from a card / phone export / downloads folder
    # ======================================================================= #

    def check_import(self, job, source):
        """Compare every photo in `source` with the library before anything is copied."""
        source = os.path.abspath(source)
        if source == self.root or source.startswith(self.root + os.sep):
            raise ValueError("That folder is already inside your library.")
        files = [f for f, _ in self._walk(source, skip_library_dirs=False)]
        # originals before "copy"/"(1)" versions, so the plain name is the one kept
        files.sort(key=lambda f: (os.path.dirname(f), len(os.path.basename(f)), os.path.basename(f)))
        if not files:
            raise ValueError("I couldn't find any photos or videos in that folder.")
        tdir = os.path.join(self.data, "import-check")
        shutil.rmtree(tdir, ignore_errors=True)
        os.makedirs(tdir, exist_ok=True)

        lib = self.q("""SELECT id, path, size, sha256, dhash, taken, date_source, width, height, orientation
                        FROM files WHERE status='active'""")
        lib_by_id = {r["id"]: r for r in lib}
        by_size = defaultdict(list)
        for r in lib:
            by_size[r["size"]].append(r)
        bands = [defaultdict(list) for _ in range(4)]

        def add_hash(key, v):
            for b in range(4):
                bands[b][(v >> (16 * b)) & 0xFFFF].append((key, v))

        def ts_of(taken, source_kind):
            # only the camera's own clock is comparable — a time you changed (e.g. fixing a
            # wrong camera clock) must not hide that the photo is already in the library
            if taken and source_kind in ("exif", "sidecar"):
                try:
                    return iso_to_ts(taken)
                except (ValueError, OverflowError):
                    return None
            return None

        def aspect(w, h, o):
            if not w or not h:
                return None
            if (o or 1) >= 5:
                w, h = h, w
            return w / float(h)

        ref = {}   # key -> (timestamp, aspect)
        for r in lib:
            if r["dhash"]:
                v = int(r["dhash"], 16)
                if 4 <= popcount(v) <= 60:
                    add_hash(("lib", r["id"]), v)
                    ref[("lib", r["id"])] = (ts_of(r["taken"], r["date_source"]),
                                             aspect(r["width"], r["height"], r["orientation"]))

        job.step("Reading the new photos", len(files))
        info = {}
        for i in range(0, len(files), 150):
            info.update(self.et.read(files[i:i + 150]))
            job.done = min(len(files), i + 150)

        job.step("Comparing with your library", len(files))
        sizes = {}
        for f in files:
            try:
                sizes[f] = os.path.getsize(f)
            except OSError:
                pass
        src_sizes = Counter(sizes.values())

        def prepare(arg):
            """The slow part for one file — fingerprint and preview — done 4 files at a time."""
            idx, src = arg
            size = sizes.get(src)
            if size is None:
                return None
            ext = os.path.splitext(src)[1].lower()
            kind = "video" if ext in VIDEO_EXT else "photo"
            sha = None
            if by_size.get(size) or src_sizes[size] > 1:
                try:
                    sha = sha256_of(src)
                except OSError:
                    sha = None
            thumb, v = False, None
            try:
                img = self.open_image(src, 480) if kind == "photo" else self.video_frame(src)
                if img is not None:
                    try:
                        img = ImageOps.exif_transpose(img)
                    except Exception:
                        pass
                    img = img.convert("RGB")
                    img.thumbnail((480, 480))
                    img.save(os.path.join(tdir, "%d.jpg" % idx), "JPEG", quality=80)
                    thumb = True
                    if kind == "photo" and ext not in RAW_EXT:
                        v = int(dhash_of(img), 16)
            except Exception as e:
                print("preview failed:", src, e)
            return idx, src, size, ext, kind, sha, thumb, v

        items, seen_sha, sha_updates = [], {}, []
        with ThreadPoolExecutor(4) as pool:
            for res in pool.map(prepare, enumerate(files)):
                if res is None:
                    job.done += 1
                    continue
                idx, src, size, ext, kind, sha, thumb, v = res
                job.done = idx + 1
                meta = info.get(src) or {}
                taken, exact_time = None, False
                for key in ("DateTimeOriginal", "CreationDate", "CreateDate", "MediaCreateDate"):
                    taken = parse_iso(meta.get(key))
                    if taken:
                        break
                try:
                    w, h, o = int(meta.get("ImageWidth") or 0), int(meta.get("ImageHeight") or 0), int(meta.get("Orientation") or 1)
                except (TypeError, ValueError):
                    w = h = 0
                    o = 1
                has_time = exact_time = bool(taken)
                s_taken, s_lat, s_lon = (None, None, None)
                if not taken or meta.get("GPSLatitude") is None:
                    s_taken, s_lat, s_lon = read_sidecar(src)
                if not taken:
                    taken = s_taken
                    has_time = exact_time = bool(taken)
                if not taken:
                    taken, has_time, _ = date_from_filename(os.path.basename(src))
                lat, lon = valid_coords(meta.get("GPSLatitude"), meta.get("GPSLongitude"))
                if lat is None:
                    lat, lon = valid_coords(s_lat, s_lon)
                camera = " ".join(x for x in (str(meta.get("Make") or "").strip(), str(meta.get("Model") or "").strip()) if x) or None
                item = {"i": idx, "src": src, "name": os.path.basename(src),
                        "folder": os.path.dirname(os.path.relpath(src, source)),
                        "size": size, "kind": kind, "taken": taken, "has_time": has_time,
                        "exact_time": exact_time,
                        "width": w or None, "height": h or None,
                        "status": "new", "match": None, "match_new": None, "thumb": thumb,
                        "q": None, "dhash": None, "flags": [], "burst": None, "keep": True, "why": "",
                        "lat": lat, "lon": lon, "city": None, "camera": camera,
                        "name_part": extract_name(os.path.basename(src)), "raw_of": None}

                # 1. byte-for-byte the same as a library photo or an earlier photo in this folder
                if sha:
                    for r in by_size.get(size, []):
                        if not r["sha256"]:
                            try:
                                r["sha256"] = sha256_of(self.full(r["path"]))
                                sha_updates.append((r["sha256"], r["id"]))
                            except OSError:
                                continue
                        if r["sha256"] == sha:
                            item["status"], item["match"] = "exact", r["id"]
                            break
                    if item["status"] == "new" and sha in seen_sha:
                        item["status"], item["match_new"] = "repeat", seen_sha[sha]
                    seen_sha.setdefault(sha, idx)

                # 2. fingerprint (also catches resized / re-saved / stripped copies)
                if v is not None and item["status"] == "new" and 4 <= popcount(v) <= 60:
                    my_ts, my_asp = ts_of(taken, "exif" if exact_time else "filename"), aspect(w, h, o)
                    best = None
                    for b in range(4):
                        for key, vv in bands[b].get((v >> (16 * b)) & 0xFFFF, ()):
                            d = popcount(v ^ vv)
                            if d > SIMILAR_MAX_BITS:
                                continue
                            their_ts, their_asp = ref.get(key, (None, None))
                            if my_ts and their_ts and abs(my_ts - their_ts) > 2:
                                continue
                            if my_asp and their_asp and abs(my_asp - their_asp) / max(my_asp, their_asp) > 0.05:
                                continue
                            rank = (0 if key[0] == "lib" else 1, d)
                            if best is None or rank < best[0]:
                                best = (rank, key)
                    if best:
                        key = best[1]
                        if key[0] == "lib":
                            item["status"], item["match"] = "similar", key[1]
                        else:
                            item["status"], item["match_new"] = "repeat", key[1]
                    add_hash(("new", idx), v)
                    ref[("new", idx)] = (my_ts, my_asp)
                items.append(item)
        if sha_updates:
            self.x("UPDATE files SET sha256=? WHERE id=?", sha_updates, many=True)

        # RAW + JPEG of the same shot travel together
        by_stem = defaultdict(list)
        for it in items:
            by_stem[(os.path.dirname(it["src"]).lower(), os.path.splitext(it["name"])[0].lower())].append(it)
        for group in by_stem.values():
            raws = [x for x in group if os.path.splitext(x["name"])[1].lower() in RAW_EXT]
            lead = [x for x in group if os.path.splitext(x["name"])[1].lower() not in RAW_EXT
                    and x["kind"] == "photo"]
            if len(raws) == 1 and len(lead) == 1:
                raws[0]["raw_of"] = lead[0]["i"]
                lead[0]["raw"] = raws[0]["name"]
        # place names for photos that carry GPS
        if any(it["lat"] is not None for it in items) and self.geo.load(job):
            for it in items:
                if it["lat"] is not None:
                    it["city"] = self.geo.city(it["lat"], it["lon"])
                    it["place"] = self.geo.label(it["lat"], it["lon"])
        self.pending_import = {"source": source, "items": items}
        counts = Counter(i["status"] for i in items)
        return {"import_check": True, "total": len(items), "new": counts["new"], "exact": counts["exact"],
                "similar": counts["similar"], "repeat": counts["repeat"]}

    def _suggest_picks(self, items):
        """Mark probable throw-aways: blurry, badly exposed, or a weaker frame of the same moment,
        then let what's been learned from past choices adjust the suggestions."""
        new = [i for i in items if i["status"] == "new" and i["q"]]
        sharps = sorted(i["q"]["sharp"] for i in new)
        median = sharps[len(sharps) // 2] if sharps else 0
        for it in new:
            q = it["q"]
            dark = q["mean"] < 30 or q["dark"] > 0.85
            if dark:
                it["flags"].append("too dark")
            elif q["sharp"] < 15 or (len(new) >= 6 and q["sharp"] < 0.2 * median and q["sharp"] < 60):
                it["flags"].append("blurry")
            if q["bright"] > 0.45 or q["mean"] > 238:
                it["flags"].append("overexposed")
        # bursts: taken within 15 seconds of each other and looking alike
        timed = []
        for it in new:
            if it["taken"] and it["dhash"] and it.get("timed", True):   # date-only photos aren't bursts
                timed.append((iso_to_ts(it["taken"]), it))
        timed.sort(key=lambda x: x[0])
        groups, cur = [], []
        for t, it in timed:
            if cur and t - cur[-1][0] <= 15 and popcount(int(it["dhash"], 16) ^ int(cur[-1][1]["dhash"], 16)) <= 14:
                cur.append((t, it))
            else:
                if len(cur) > 1:
                    groups.append(cur)
                cur = [(t, it)]
        if len(cur) > 1:
            groups.append(cur)
        for n, g in enumerate(groups, 1):
            members = [it for _, it in g]
            usable = [m for m in members if "too dark" not in m["flags"] and "overexposed" not in m["flags"]] or members
            best = max(usable, key=lambda m: m["q"]["sharp"])
            for m in members:
                m["burst"] = {"n": n, "size": len(members), "best": m is best}

        model = self.taste_model()
        for it in new:
            rule_skip, why = False, ""
            if it["flags"]:
                rule_skip, why = True, " and ".join(it["flags"]).capitalize()
            elif it["burst"] and not it["burst"]["best"]:
                rule_skip, why = True, "A sharper shot of the same moment is kept"
            it["rule_skip"] = rule_skip
            if model:
                p = model.predict(pick_features(it))
                it["p"] = round(p, 2)
                if rule_skip and p >= 0.85:
                    rule_skip, why = False, ""          # you usually keep photos like this
                elif not rule_skip and p < 0.3:
                    rule_skip, why = True, "You usually skip photos like this"
            it["keep"], it["why"] = (not rule_skip), why

    # ---------- find matches for one photo, optionally only among some photos ----------
    def _vector(self, r):
        """A small, normalised greyscale version of the photo for close comparison."""
        cache = getattr(self, "_vecs", None)
        if cache is None:
            cache = self._vecs = {}
        key = (r["id"], r["mtime"])
        if key in cache:
            return cache[key]
        try:
            im = Image.open(self.thumb_path(r["id"]))
            im.load()
        except Exception:
            cache[key] = None
            return None
        vecs = []
        for angle in (0, 90, 180, 270):
            g = im.rotate(angle, expand=True).convert("L").resize((24, 24), Image.BILINEAR)
            px = list(g.getdata())
            m = sum(px) / float(len(px))
            sd = math.sqrt(sum((p - m) ** 2 for p in px) / len(px)) or 1.0
            vecs.append([(p - m) / sd for p in px])
        cache[key] = vecs
        return vecs

    def find_matches(self, fid, name="", year="", place="", limit=12):
        me = self.get(int(fid))
        if not me or me["thumb"] != 1:
            raise ValueError("I don't have a preview of that photo yet — try Rescan.")
        mine = self._vector(me)
        ids = self.search(place=place, year=year, name=name, ids_only=True)
        ids = [i for i in ids if i != me["id"]]
        big = len(ids) > 6000
        rows = self.q("SELECT * FROM files WHERE status='active' AND kind='photo' AND thumb=1 AND id IN (%s)"
                      % ",".join("?" * len(ids)), ids) if ids and not big else []
        results = []
        if big:
            # the whole library: use the quick fingerprints
            v = int(me["dhash"], 16) if me["dhash"] else None
            for r in self.q("SELECT * FROM files WHERE status='active' AND kind='photo' AND dhash IS NOT NULL AND id != ?", (me["id"],)):
                if v is None:
                    break
                d = popcount(v ^ int(r["dhash"], 16))
                if d <= 12:
                    results.append((1 - d / 64.0, r))
        else:
            for r in rows:
                other = self._vector(r)
                if not other or not mine:
                    continue
                o = other[0]
                n = float(len(o))
                score = max(sum(a * b for a, b in zip(v, o)) / n for v in mine)
                results.append((score, r))
        results.sort(key=lambda x: -x[0])
        out = []
        for score, r in results[:limit]:
            d = self._dup_public(r)
            d["score"] = round(max(0.0, score), 3)
            d["label"] = ("Very likely the same photo" if score >= 0.9 else
                          "Possibly the same photo" if score >= 0.75 else
                          "Looks a bit alike" if score >= 0.55 else "Not alike")
            d["tags"] = split_tags(r["tags"])
            out.append(d)
        return {"me": dict(self._dup_public(me), tags=split_tags(me["tags"])), "looked_at": len(ids), "matches": out}

    def _scene_of(self, r):
        if r["scene"]:
            return r["scene"]
        try:
            im = Image.open(self.thumb_path(r["id"]))
            im.load()
            sc = scene_sig(im)
        except Exception:
            return None
        self.x("UPDATE files SET scene=? WHERE id=?", (sc, r["id"]))
        return sc

    def guess_date(self, *a, **kw):
        with self.batch():
            return self._guess_date(*a, **kw)

    def _guess_date(self, fid, name="", year="", place=""):
        """Suggest dates for an undated photo from the dated photos that look most like it."""
        me = self.get(int(fid))
        if not me or me["thumb"] != 1:
            raise ValueError("I don't have a preview of that photo yet — try Rescan.")
        mine = self._scene_of(me)
        mv = self._vector(me)
        ids = [i for i in self.search(place=place, year=year, name=name, ids_only=True) if i != me["id"]]
        if not ids:
            return {"looked_at": 0, "guesses": []}
        rows = []
        for k in range(0, len(ids), 900):
            chunk = ids[k:k + 900]
            rows += self.q("SELECT * FROM files WHERE status='active' AND thumb=1 AND NOT " + NEEDS_SQL +
                           " AND id IN (%s)" % ",".join("?" * len(chunk)), chunk)
        scored = []
        small_set = len(rows) <= 3000
        for r in rows:
            sc = r["scene"] or (self._scene_of(r) if small_set else None)
            if not sc or not mine:
                continue
            score = scene_similarity(mine, sc)
            if small_set and mv:
                ov = self._vector(r)
                if ov:
                    corr = max(sum(a * b for a, b in zip(v, ov[0])) / float(len(ov[0])) for v in mv)
                    score = 0.75 * score + 0.25 * max(0.0, corr)
            scored.append((score, r))
        scored.sort(key=lambda x: -x[0])
        top = [(sc, r) for sc, r in scored[:30] if sc >= 0.35]
        # group the look-alikes by date: photos within a week of each other are one occasion
        top_by_time = sorted(top, key=lambda x: x[1]["taken"])
        clusters, cur = [], []
        for sc, r in top_by_time:
            if cur and iso_to_ts(r["taken"]) - iso_to_ts(cur[-1][1]["taken"]) > 7 * 86400:
                clusters.append(cur)
                cur = []
            cur.append((sc, r))
        if cur:
            clusters.append(cur)
        guesses = []
        for c in clusters:
            weight = sum(sc for sc, _ in c)
            best = max(c, key=lambda x: x[0])
            dates = sorted(r["taken"][:10] for _, r in c)
            names = Counter(self.name_part(r) for _, r in c if self.name_part(r))
            guesses.append({
                "date": best[1]["taken"][:10], "from": dates[0], "to": dates[-1],
                "count": len(c), "strength": round(weight, 2), "best": round(best[0], 2),
                "name": names.most_common(1)[0][0] if names else "",
                "photos": [dict(self._dup_public(r), score=round(sc, 2)) for sc, r in sorted(c, key=lambda x: -x[0])[:6]],
            })
        guesses.sort(key=lambda g: -g["strength"])
        return {"looked_at": len(rows), "guesses": guesses[:5]}

    def set_date_only(self, ids, date):
        d = parse_iso((date or "").strip()[:10] + "T00:00:00")
        if not d:
            raise ValueError("That date doesn't look right.")
        self.x("UPDATE files SET taken=?, date_source='manual_date', date_pending=1, filedates=0 WHERE id=?",
               [(d, int(i)) for i in ids], many=True)
        self.invalidate()
        return {"updated": len(ids)}

    def copy_details(self, to_id, from_id):
        """Give a photo the date, place and name of the matching photo."""
        t, f = self.get(int(to_id)), self.get(int(from_id))
        if not t or not f:
            raise ValueError("Those photos aren't there any more.")
        upd = {}
        if f["date_source"] not in NEEDS_DATE:
            upd.update({"taken": f["taken"], "date_source": "copied" if f["date_source"] not in NO_TIME else "manual_date",
                        "date_pending": 1, "filedates": 0})
        if f["lat"] is not None:
            upd.update({"lat": f["lat"], "lon": f["lon"], "place": f["place"], "city": f["city"],
                        "gps_source": "manual", "gps_pending": 1})
        name = f["title"] if f["title"] is not None else extract_name(os.path.basename(f["path"]))
        if name and not t["title"]:
            upd["title"] = name
        tags = split_tags(t["tags"])
        for tg in split_tags(f["tags"]):
            if tg.lower() not in [x.lower() for x in tags]:
                tags.append(tg)
        if tags != split_tags(t["tags"]):
            upd.update({"tags": ", ".join(tags), "tags_pending": 1})
        if upd:
            self.x("UPDATE files SET %s WHERE id=?" % ", ".join("%s=?" % k for k in upd), list(upd.values()) + [t["id"]])
        self.invalidate()
        return {"copied": list(upd)}

    # ---------- picking the best from photos already in the library ----------
    def pick_set(self, ids):
        ids = [int(i) for i in ids]
        if not ids:
            return {"items": [], "taste": self.taste_info()}
        rows = self.q("SELECT * FROM files WHERE status='active' AND id IN (%s) ORDER BY taken, path"
                      % ",".join("?" * len(ids)), ids)
        cache = getattr(self, "_qcache", None)
        if cache is None:
            cache = self._qcache = {}
        items = []
        for r in rows:
            q = None
            if r["kind"] == "photo" and r["thumb"] == 1:
                key = (r["id"], r["mtime"])
                q = cache.get(key)
                if q is None:
                    try:
                        im = Image.open(self.thumb_path(r["id"]))
                        im.load()
                        q = cache[key] = quality_of(im)
                    except Exception:
                        q = None
            items.append({"i": r["id"], "name": os.path.basename(r["path"]), "folder": os.path.dirname(r["path"]),
                          "size": r["size"], "kind": r["kind"], "status": "new", "q": q, "dhash": r["dhash"],
                          "taken": r["taken"] if r["date_source"] not in NEEDS_DATE else None,
                          "timed": r["date_source"] not in NEEDS_DATE + NO_TIME,
                          "rating": r["rating"], "flags": [], "burst": None, "keep": True, "why": ""})
        self._suggest_picks(items)
        model = self.taste_model()
        scored = []
        for it in items:
            a, reasons = appeal_of(it["q"])
            if a is None or not it["keep"]:
                continue
            if model and it.get("p") is not None:
                a = 0.5 * a + 0.5 * it["p"]
            it["appeal"], it["appeal_why"] = a, reasons
            scored.append(it)
        scored.sort(key=lambda x: -x["appeal"])
        for it in scored[:max(1, len(scored) // 5)] if len(scored) >= 3 else []:
            it["favorite"] = True
        self._pick_session = {it["i"]: it for it in items}
        return {"items": items, "taste": self.taste_info()}

    def pick_commit(self, job, keep, skip, ratings):
        keep = [int(i) for i in keep]
        skip = [int(i) for i in skip]
        session = getattr(self, "_pick_session", None) or {}
        items = [session[i] for i in keep + skip if i in session]
        self.record_picks(items, keep)
        ratings = {int(k): int(v) for k, v in (ratings or {}).items()}
        changed = [(v if v in (1, 2, 3, 4, 5) else None, i) for i, v in ratings.items()
                   if i in session and (session[i].get("rating") or 0) != v]
        if changed:
            self.x("UPDATE files SET rating=?, rating_pending=1 WHERE id=?", changed, many=True)
        job.step("Moving the ones you deleted to the Trash", len(skip))
        rows = [r for r in (self.get(i) for i in skip) if r and r["status"] == "active"]
        trashed, aside = self._trash(rows, job)
        self.invalidate()
        result = {"picked": len(keep), "trashed": trashed, "set_aside": aside}
        rated_ids = [i for _, i in changed if i in set(keep)]
        if rated_ids:
            result.update(self.apply(job, rated_ids, rename=False))   # save the stars into the photos now
        else:
            result.update(self.sync_highlights(job))
        self._pick_session = None
        return result

    def _trash(self, rows, job=None):
        """Send files to the Mac Trash (recoverable from the Trash). Anything that can't be
        trashed goes to _Set aside instead, so nothing is ever lost by accident."""
        rows = list(rows) + [c for c in (self.get(i) for i in self.companions([r["id"] for r in rows]))
                             if c and c["status"] == "active"]
        if job:
            job.total = len(rows)
        trashed = aside = 0
        dirs, gone = set(), []
        for k in range(0, len(rows), 200):
            chunk = rows[k:k + 200]
            files = []
            for r in chunk:
                full = self.full(r["path"])
                if os.path.exists(full):
                    files.append(full)
                    side = find_sidecar(full)
                    if side:
                        files.append(side)
            trash_files(files)
            for r in chunk:
                full = self.full(r["path"])
                if not os.path.exists(full):
                    gone.append(r["id"])
                    dirs.add(os.path.dirname(full))
                    trashed += 1
                else:
                    self._set_aside(r, with_pair=False)   # its RAW is already in this list
                    aside += 1
                if job:
                    job.done += 1
            if gone:   # one save per batch, not per photo — much faster on exFAT
                self.x("DELETE FROM files WHERE id=?", [(i,) for i in gone], many=True)
                for i in gone:
                    self._drop_thumb(i)
                gone = []
        self._remove_empty_dirs(dirs)
        return trashed, aside

    def record_picks(self, items, include):
        want = set(int(i) for i in include)
        rows = []
        now = dt.datetime.now().isoformat(timespec="seconds")
        for it in items:
            if it["status"] != "new" or not it.get("q"):
                continue
            keep = 1 if it["i"] in want else 0
            overridden = 1 if keep != (1 if it["keep"] else 0) else 0
            key = "%s|%s" % (it["name"], it["size"])
            rows.append((key, json.dumps(pick_features(it)), keep, overridden, now))
        if rows:
            self.x("INSERT OR REPLACE INTO picks(key, features, keep, overridden, at) VALUES(?,?,?,?,?)", rows, many=True)
        self._taste = None

    def taste_model(self):
        if getattr(self, "_taste", None) is not None:
            return self._taste or None
        rows = [r for r in self.q("SELECT features, keep, overridden FROM picks")
                if len(json.loads(r["features"])) == FEATURES]
        keeps = sum(r["keep"] for r in rows)
        skips = len(rows) - keeps
        model = None
        if len(rows) >= 40 and keeps >= 10 and skips >= 10:
            model = Taste.train([(json.loads(r["features"]), r["keep"], 3.0 if r["overridden"] else 1.0) for r in rows])
            model.examples = len(rows)
        self._taste = model or False
        return model

    def taste_info(self):
        n = sum(1 for r in self.q("SELECT features FROM picks") if len(json.loads(r["features"])) == FEATURES)
        m = self.taste_model()
        return {"choices": n, "learning": bool(m), "needed": 40}

    def import_view(self):
        p = getattr(self, "pending_import", None)
        if not p:
            return None
        out = []
        for it in p["items"]:
            d = dict(it)
            if it["match"]:
                r = self.get(it["match"])
                d["match"] = self._dup_public(r) if r else None
            if it["match_new"] is not None:
                o = next((x for x in p["items"] if x["i"] == it["match_new"]), None)
                if o:
                    d["other"] = {k: o[k] for k in ("i", "name", "folder", "size", "width", "height", "taken")}
            out.append(d)
        groups = [{"key": g["key"], "name": g["name"], "start": g["start"], "end": g["end"], "count": g["count"],
                   "thumbs": g["thumbs"][:1]} for g in self.groups()[:200]]
        return {"source": p["source"], "items": out, "settings": self.settings(), "albums": groups,
                "library": os.path.basename(self.root.rstrip(os.sep)) or self.root}

    def names_in_use(self, targets):
        """For each wanted path, which endings are already taken on the drive:
        1 = the plain name, 2 = "… 2", and so on."""
        out = {}
        for t in targets[:5000]:
            stem, ext = os.path.splitext(t)
            low_stem, low_ext = stem.lower(), ext.lower()
            used = set()
            for r in self.q("SELECT path FROM files WHERE status='active' AND lower(path) LIKE ? ESCAPE '\\'",
                            (low_stem.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",)):
                p = r["path"].lower()
                if not p.endswith(low_ext):
                    continue
                rest = p[len(low_stem):len(p) - len(low_ext)]
                if rest == "":
                    used.add(1)
                elif rest.startswith(" ") and rest[1:].isdigit():
                    used.add(int(rest[1:]))
            if os.path.exists(self.full(t)):
                used.add(1)
            out[t] = sorted(used)
        return out

    def import_thumb(self, idx):
        return os.path.join(self.data, "import-check", "%d.jpg" % int(idx))

    def cancel_import(self):
        self.pending_import = None
        shutil.rmtree(os.path.join(self.data, "import-check"), ignore_errors=True)

    def import_preview(self, idx):
        """A large view of a photo that hasn't been imported yet."""
        p = getattr(self, "pending_import", None)
        it = next((x for x in (p or {}).get("items", []) if x["i"] == int(idx)), None)
        if not it:
            return None, None
        ext = os.path.splitext(it["src"])[1].lower()
        if it["kind"] == "video" or ext in WEB_OK:
            return it["src"], None
        big = os.path.join(self.data, "import-check", "big-%d.jpg" % it["i"])
        if not os.path.exists(big):
            img = self.open_image(it["src"], 2000)
            if img is None:
                return self.import_thumb(it["i"]), "image/jpeg"
            try:
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass
            img = img.convert("RGB")
            img.thumbnail((2000, 2000))
            img.save(big, "JPEG", quality=85)
        return big, "image/jpeg"

    def commit_import(self, job, *args, **kw):
        with self.batch():
            return self._commit_import(job, *args, **kw)

    def _commit_import(self, job, include, ratings=None, event=None, shift=0, album=None,
                       rename=True, delete_source=False, names=None, times=None, tags=None,
                       places=None, batch_place=None):
        p = getattr(self, "pending_import", None)
        if not p:
            raise ValueError("Please check the folder again.")
        want = set(int(i) for i in include)
        # a RAW always comes along with its JPEG
        for it in p["items"]:
            if it.get("raw_of") is not None and it["raw_of"] in want:
                want.add(it["i"])
        ratings = {int(k): int(v) for k, v in (ratings or {}).items() if v}
        chosen = [it for it in p["items"] if it["i"] in want]
        rated = {}
        copied_ok = []
        names = {int(k): v for k, v in (names or {}).items()}
        times = {int(k): v for k, v in (times or {}).items() if v}
        tags = {int(k): v for k, v in (tags or {}).items() if v}
        places = {int(k): v for k, v in (places or {}).items() if v}
        named_paths, timed_paths, tagged_paths, placed_paths = {}, {}, {}, {}
        job.step("Copying photos to your drive", len(chosen))
        stamp = dt.datetime.now().strftime("%Y-%m-%d %H%M%S")
        dest_dir = os.path.join(self.root, INBOX, stamp)
        seed, copy_failed = {}, []
        tdir = os.path.join(self.data, "import-check")

        def clean(part):
            return BAD_CHARS_RE.sub("_", part).strip() or "_"
        for it in chosen:
            if os.path.exists(it["src"]):
                # keep the card's own folders apart, so a RAW stays next to its own JPEG
                sub = os.path.join(*[clean(x) for x in it["folder"].split(os.sep)]) if it["folder"] else ""
                ddir = os.path.join(dest_dir, sub)
                dest = None
                try:
                    os.makedirs(ddir, exist_ok=True)
                    dest = unique_path(os.path.join(ddir, clean(it["name"])))
                    shutil.copy2(it["src"], dest)
                    if os.path.getsize(dest) != os.path.getsize(it["src"]):
                        raise OSError("the copy came out a different size")
                except OSError as e:
                    if dest and os.path.exists(dest):
                        try:
                            os.remove(dest)
                        except OSError:
                            pass
                    copy_failed.append({"name": it["name"], "error": str(e)[:200]})
                    job.done += 1
                    continue
                copied_ok.append(it["src"])
                rel = os.path.relpath(dest, self.root)
                if it.get("thumb"):
                    seed[rel] = os.path.join(tdir, "%d.jpg" % it["i"])
                if it["i"] in names:
                    named_paths[rel] = names[it["i"]]
                if it["i"] in times:
                    timed_paths[rel] = times[it["i"]]
                if it["i"] in tags:
                    tagged_paths[rel] = tags[it["i"]]
                if it["i"] in places:
                    placed_paths[rel] = places[it["i"]]
                if it["i"] in ratings:
                    rated[os.path.relpath(dest, self.root)] = ratings[it["i"]]
                side = find_sidecar(it["src"])
                if side:
                    try:
                        shutil.copy2(side, dest + ".json")
                    except OSError:
                        pass
            job.done += 1
        if not copied_ok:
            self.cancel_import()
            raise RuntimeError("Nothing could be copied: " + (copy_failed[0]["error"] if copy_failed else "no photos"))
        batch = "import-" + stamp
        self._thumb_seed = seed
        try:
            with self.batch():
                result = self.scan(job, batch=batch, only=os.path.relpath(dest_dir, self.root))
        finally:
            self._thumb_seed = None
            self.cancel_import()
        if rated:
            self.x("UPDATE files SET rating=?, rating_pending=1 WHERE path=?",
                   [(v, k) for k, v in rated.items()], many=True)
        ids = [r["id"] for r in self.q("SELECT id FROM files WHERE status='active' AND pair_of IS NULL AND batch=?", (batch,))]
        if ids and event:
            self.edit(ids, title=event)
        if ids and shift:
            dated = [r["id"] for r in self.q("SELECT id FROM files WHERE batch=? AND pair_of IS NULL AND NOT " + NEEDS_SQL, (batch,))]
            if dated:
                self.edit(dated, shift=int(shift))
        if ids and album:
            try:
                self.add_to_group(ids, album, keep_dates=True)
            except ValueError:
                pass
        # what you set for single photos wins over the batch settings
        def one(path):
            row = self.q("SELECT id FROM files WHERE path=? AND pair_of IS NULL", (path,))
            return row[0]["id"] if row else None
        for path, nm in named_paths.items():
            fid = one(path)
            if fid:
                self.edit([fid], title=nm)
        for path, when in timed_paths.items():
            fid = one(path)
            if fid:
                self.edit([fid], taken=when)
        for path, tg in tagged_paths.items():
            fid = one(path)
            if fid:
                self.edit([fid], add_tags=list(tg))
        # a place for the batch fills in photos without GPS; a place you set for one photo always applies
        if batch_place and ids:
            bare = [r["id"] for r in self.q("SELECT id FROM files WHERE batch=? AND pair_of IS NULL AND lat IS NULL", (batch,))]
            if bare:
                self.set_location(bare, batch_place["lat"], batch_place["lon"],
                                  batch_place.get("label"), batch_place.get("name"))
        for path, pl in placed_paths.items():
            fid = one(path)
            if fid:
                self.set_location([fid], pl["lat"], pl["lon"], pl.get("label"), pl.get("name"))
        waiting = self.q("SELECT COUNT(*) AS n FROM files WHERE batch=? AND pair_of IS NULL AND " + NEEDS_SQL, (batch,))[0]["n"]
        filed = {}
        if ids and rename:
            filed = self.apply(job, ids)
        trashed_src = 0
        if delete_source and copied_ok:
            job.step("Moving the originals to the Trash", len(copied_ok))
            trashed_src = self._trash_paths(copied_ok, job)
        result.update({"copied": len(copied_ok), "copy_failed": copy_failed[:50],
                       "skipped": len(p["items"]) - len(chosen),
                       "imported_ids": ids, "waiting": waiting, "renamed": bool(rename),
                       "filed": filed.get("moved", 0), "trashed_source": trashed_src,
                       "folders": sorted(set(os.path.dirname(r["path"]) for r in self.q(
                           "SELECT path FROM files WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)))[:6] if ids else []})
        return result

    def _trash_paths(self, paths, job=None):
        """Put files outside the library (e.g. on a memory card) in the Trash."""
        if not IS_MAC:
            return 0
        done = 0
        for k in range(0, len(paths), 200):
            chunk = [f for f in paths[k:k + 200] if os.path.exists(f)]
            if chunk:
                trash_files(chunk)
                done += sum(1 for f in chunk if not os.path.exists(f))
            if job:
                job.done += len(paths[k:k + 200])
        return done

    # ======================================================================= #
    # Browse / search
    # ======================================================================= #

    def search(self, place="", year="", name="", offset=0, limit=120, month="", ids_only=False, rating=""):
        where, args = ["status='active' AND pair_of IS NULL"], []
        if rating:
            where.append("rating >= ?")
            args.append(int(rating))
        if month and year and year != "none":
            where.append("substr(taken,6,2)=?")
            args.append("%02d" % int(month))
        if place:
            where.append("(place LIKE ? OR city LIKE ?)")
            args += ["%" + place + "%"] * 2
        if year == "none":
            where.append(NEEDS_SQL)
        elif year:
            where.append("substr(taken,1,4)=?")
            args.append(str(year))
        if name:
            where.append("(path LIKE ? OR title LIKE ? OR tags LIKE ? OR people LIKE ?)")
            args += ["%" + name + "%"] * 4
        w = " AND ".join(where)
        if ids_only:
            return [r["id"] for r in self.q("SELECT id FROM files WHERE " + w + " ORDER BY taken", args)]
        total = self.q("SELECT COUNT(*) AS n FROM files WHERE " + w, args)[0]["n"]
        rows = self.q("SELECT * FROM files WHERE " + w + " ORDER BY taken DESC, path LIMIT ? OFFSET ?",
                      args + [limit, offset])
        items = [self.public(r) for r in rows]
        days = {}
        wanted = sorted(set(i["taken"][:10] for i in items if i["taken"]))
        by_day = defaultdict(list)
        if wanted:   # one query for the whole page (uses the date index) instead of one per day
            for r in self.q("""SELECT path, title, place, taken FROM files WHERE status='active' AND pair_of IS NULL
                               AND taken >= ? AND taken < ?""", (wanted[0], wanted[-1] + "T99")):
                by_day[r["taken"][:10]].append(r)
        for d in wanted:
            info = by_day.get(d, [])
            names = Counter((r["title"] or extract_name(os.path.basename(r["path"]))) for r in info)
            names.pop("", None)
            places = Counter(short_place(r["place"]) for r in info if r["place"])
            days[d] = {"count": len(info),
                       "name": names.most_common(1)[0][0] if names else "",
                       "place": places.most_common(1)[0][0] if places else ""}
        return {"total": total, "items": items, "days": days}

    def name_day(self, day, title):
        """Give every photo from one day the same location/event name."""
        title = BAD_CHARS_RE.sub(" ", title or "").strip()
        rng = (day[:10], day[:10] + "T99")
        self.x("UPDATE files SET title=? WHERE status='active' AND taken >= ? AND taken < ?", (title or None,) + rng)
        self.invalidate()
        n = self.q("SELECT COUNT(*) AS n FROM files WHERE status='active' AND taken >= ? AND taken < ?", rng)[0]["n"]
        return {"updated": n, "title": title}

    def filters(self):
        years = [r["y"] for r in self.q(
            "SELECT DISTINCT substr(taken,1,4) AS y FROM files WHERE status='active' ORDER BY y DESC")]
        counts = Counter()
        for r in self.q("SELECT place, COUNT(*) AS n FROM files WHERE status='active' AND place IS NOT NULL GROUP BY place"):
            parts = [p.strip() for p in r["place"].split(",")]
            if parts and parts[0].lower().startswith("near "):
                parts[0] = parts[0][5:]
            for p in parts:
                counts[p] += r["n"]
        for r in self.q("SELECT city, COUNT(*) AS n FROM files WHERE status='active' AND city IS NOT NULL GROUP BY city"):
            counts[short_place(r["city"])] += r["n"]
        places = [p for p, _ in counts.most_common(400)]
        return {"years": years, "places": sorted(places, key=str.lower), "tags": self.all_tags()}

    def all_tags(self):
        c = Counter()
        for r in self.q("SELECT name FROM people"):
            c[r["name"]] += 1
        for r in self.q("SELECT tags FROM files WHERE status='active' AND tags IS NOT NULL"):
            for t in split_tags(r["tags"]):
                c[t] += 1
        return sorted(c, key=str.lower)

    def public(self, r):
        return {"id": r["id"], "path": r["path"], "name": os.path.basename(r["path"]),
                "folder": os.path.dirname(r["path"]), "kind": r["kind"], "taken": r["taken"],
                "date_source": r["date_source"], "place": r["place"],
                "lat": r["lat"], "lon": r["lon"], "gps_source": r["gps_source"], "city": r.get("city"),
                "width": r["width"], "height": r["height"], "size": r["size"],
                "camera": r["camera"], "thumb": r["thumb"], "status": r["status"],
                "tags": split_tags(r.get("tags")), "title": r.get("title"), "rating": r.get("rating"),
                "people": split_tags(r.get("people")),
                "raw": self._raw_map().get(r["id"])}

    def _raw_map(self):
        m = getattr(self, "_raws", None)
        if m is None:
            rows = self.q("SELECT pair_of, path FROM files WHERE pair_of IS NOT NULL AND status='active'")
            m = self._raws = {r["pair_of"]: os.path.basename(r["path"]) for r in rows}
        return m

    def get(self, fid):
        rows = self.q("SELECT * FROM files WHERE id=?", (fid,))
        return rows[0] if rows else None

    def preview_path(self, fid):
        """A browser-friendly large version of any photo."""
        r = self.get(fid)
        if not r:
            return None, None
        full = self.full(r["path"])
        ext = os.path.splitext(full)[1].lower()
        if r["kind"] == "video" or ext in WEB_OK:
            return full, None
        cached = os.path.join(self.data, "previews", "%d.jpg" % fid)
        if not os.path.exists(cached):
            img = self.open_image(full, 2400)
            if img is None:
                return None, None
            try:
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass
            img = img.convert("RGB")
            img.thumbnail((2400, 2400))
            img.save(cached, "JPEG", quality=88)
        return cached, "image/jpeg"

    # ======================================================================= #
    # Duplicates
    # ======================================================================= #

    def dupes_in_background(self):
        """Work out duplicate groups without making the rest of the app wait."""
        if self._dupes is None and not self.busy() and not self._dupe_lock.locked():
            threading.Thread(target=self._dupes_quietly, daemon=True).start()

    def _dupes_quietly(self):
        try:
            self.dup_groups()
        except Exception as e:
            print("duplicate check failed:", e)

    def dup_groups(self):
        with self._dupe_lock:   # its own lock: the catalog stays usable while this runs
            if self._dupes is not None:
                return self._dupes
            gen = self._dupe_gen
            rows = self.q("""SELECT id, path, size, sha256, dhash, width, height, orientation, taken,
                date_source, lat, place, kind, title, thumb, camera, gps_source FROM files
                WHERE status='active' AND pair_of IS NULL""")
            byid = {r["id"]: r for r in rows}
            parent = {}

            def find(a):
                while parent.get(a, a) != a:
                    parent[a] = parent.get(parent[a], parent[a])
                    a = parent[a]
                return a

            def union(a, b):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[ra] = rb

            by_sha = defaultdict(list)
            for r in rows:
                if r["sha256"]:
                    by_sha[r["sha256"]].append(r["id"])
            for ids in by_sha.values():
                for i in ids[1:]:
                    union(ids[0], i)

            # look-alikes: split the 64-bit hash into 4 bands; any pair within 3 bits shares a band
            hashes = []
            for r in rows:
                if r["dhash"]:
                    v = int(r["dhash"], 16)
                    if 4 <= popcount(v) <= 60:
                        hashes.append((r["id"], v))
            ts = {}
            for r in rows:
                if r["date_source"] in ("exif", "sidecar"):
                    try:
                        ts[r["id"]] = iso_to_ts(r["taken"])
                    except (ValueError, OverflowError):
                        pass

            def aspect(r):
                w, h = r["width"], r["height"]
                if not w or not h:
                    return None
                if (r["orientation"] or 1) >= 5:
                    w, h = h, w
                return w / float(h)

            checked = set()
            for band in range(4):
                buckets = defaultdict(list)
                shift = band * 16
                for fid, v in hashes:
                    buckets[(v >> shift) & 0xFFFF].append((fid, v))
                for items in buckets.values():
                    if len(items) < 2 or len(items) > 400:
                        continue
                    for i in range(len(items)):
                        a, va = items[i]
                        for j in range(i + 1, len(items)):
                            b, vb = items[j]
                            key = (a, b) if a < b else (b, a)
                            if key in checked:
                                continue
                            checked.add(key)
                            if popcount(va ^ vb) > SIMILAR_MAX_BITS:
                                continue
                            if a in ts and b in ts and abs(ts[a] - ts[b]) > 2:
                                continue  # different moments, e.g. a burst
                            ra, rb = aspect(byid[a]), aspect(byid[b])
                            if ra and rb and abs(ra - rb) / max(ra, rb) > 0.05:
                                continue
                            union(a, b)

            groups = defaultdict(list)
            for r in rows:
                groups[find(r["id"])].append(r["id"])
            ok = set(r["key"] for r in self.q("SELECT key FROM dup_ok"))
            ok_sets = [set(int(x) for x in k.split(",")) for k in ok]
            result = []
            for members in groups.values():
                if len(members) < 2:
                    continue
                mset = set(members)
                if any(mset <= s for s in ok_sets):
                    continue
                files = [byid[i] for i in members]
                shas = set(f["sha256"] for f in files)
                exact = len(shas) == 1 and None not in shas
                keep = self._best_copy(files, exact)
                files.sort(key=lambda f: (f["id"] != keep, f["taken"] or "", f["path"]))
                result.append({
                    "key": ",".join(str(i) for i in sorted(members)),
                    "kind": "exact" if exact else "similar",
                    "keep": keep,
                    "taken": min(f["taken"] or "9999" for f in files),
                    "files": [self._dup_public(f) for f in files],
                })
            result.sort(key=lambda g: (g["kind"] != "exact", g["taken"]))
            if gen == self._dupe_gen:   # nothing changed while this was being worked out
                self._dupes = result
                self._dup_count = len(result)
            return result

    def _dup_public(self, f):
        return {"id": f["id"], "path": f["path"], "name": os.path.basename(f["path"]),
                "folder": os.path.dirname(f["path"]), "size": f["size"], "width": f["width"],
                "height": f["height"], "taken": f["taken"], "date_source": f["date_source"],
                "place": f["place"], "kind": f["kind"], "thumb": f["thumb"], "camera": f["camera"]}

    def _best_copy(self, files, exact):
        def score(f):
            named = 1 if (f["title"] or extract_name(os.path.basename(f["path"]))) else 0
            in_inbox = 1 if (f["path"].startswith(INBOX + os.sep) or f["path"].startswith("_Inbox" + os.sep)) else 0
            pixels = (f["width"] or 0) * (f["height"] or 0)
            if exact:
                return (-in_inbox, named, f["lat"] is not None, -len(f["path"]))
            return (pixels, f["size"] or 0, f["date_source"] == "exif", f["lat"] is not None,
                    named, -in_inbox)
        return max(files, key=score)["id"]

    def resolve_dupes(self, key, keep_ids, aside_ids):
        keep_ids = [int(i) for i in keep_ids]
        aside_ids = [int(i) for i in aside_ids]
        if not keep_ids:
            raise ValueError("Keep at least one copy.")
        if not aside_ids:
            self.x("INSERT OR IGNORE INTO dup_ok(key) VALUES(?)", (key,))
            self.invalidate()
            return {"moved": 0}
        keepers = [self.get(i) for i in keep_ids]
        others = [self.get(i) for i in aside_ids]
        # Carry anything useful from the copies being set aside over to the keeper
        for k in keepers:
            if not k:
                continue
            updates = {}
            for o in others:
                if not o:
                    continue
                if k["lat"] is None and o["lat"] is not None and "lat" not in updates:
                    updates.update({"lat": o["lat"], "lon": o["lon"], "place": o["place"], "city": o["city"],
                                    "gps_source": "manual", "gps_pending": 1})
                if (k["date_source"] in ("file", "filename") and o["date_source"] in ("exif", "sidecar", "filename_time")
                        and "taken" not in updates):
                    updates.update({"taken": o["taken"], "date_source": "copied", "date_pending": 1,
                                    "filedates": 0})
                if not k["title"] and not extract_name(os.path.basename(k["path"])) and "title" not in updates:
                    nm = o["title"] or extract_name(os.path.basename(o["path"]))
                    if nm:
                        updates["title"] = nm
            if updates:
                sets = ", ".join("%s=?" % c for c in updates)
                self.x("UPDATE files SET %s WHERE id=?" % sets, list(updates.values()) + [k["id"]])
        moved = 0
        for o in others:
            if o and o["status"] == "active":
                self._set_aside(o)
                moved += 1
        if len(keep_ids) > 1:
            self.x("INSERT OR IGNORE INTO dup_ok(key) VALUES(?)",
                   (",".join(str(i) for i in sorted(keep_ids)),))
        self.invalidate()
        return {"moved": moved}

    def _set_aside(self, r, with_pair=True):
        if with_pair:
            for cid in self.companions([r["id"]]):
                c = self.get(cid)
                if c and c["status"] == "active":
                    self._set_aside(c, with_pair=False)
        src = self.full(r["path"])
        rel = os.path.join(SET_ASIDE, r["path"])
        dst = unique_path(self.full(rel))
        rel = os.path.relpath(dst, self.root)
        if os.path.exists(src):
            side = find_sidecar(src)
            move_file(src, dst)
            if side:
                move_file(side, unique_path(dst + ".json"))
            self._remove_empty_dirs([os.path.dirname(src)])
        self.x("UPDATE files SET status='set_aside', orig_path=path, path=? WHERE id=?", (rel, r["id"]))

    def auto_exact(self, job):
        groups = [g for g in self.dup_groups() if g["kind"] == "exact"]
        job.step("Setting aside exact copies", len(groups))
        moved = 0
        for g in groups:
            keep = g["keep"]
            aside = [f["id"] for f in g["files"] if f["id"] != keep]
            moved += self.resolve_dupes(g["key"], [keep], aside)["moved"]
            job.done += 1
        return {"groups": len(groups), "moved": moved}

    def restore_set_aside(self, job):
        rows = self.q("SELECT * FROM files WHERE status='set_aside'")
        job.step("Putting copies back", len(rows))
        for r in rows:
            src = self.full(r["path"])
            dst = unique_path(self.full(r["orig_path"] or os.path.basename(r["path"])))
            if os.path.exists(src):
                side = find_sidecar(src)
                move_file(src, dst)
                if side:
                    move_file(side, unique_path(dst + ".json"))
            self.x("UPDATE files SET status='active', path=?, orig_path=NULL WHERE id=?",
                   (os.path.relpath(dst, self.root), r["id"]))
            job.done += 1
        self._remove_empty_dirs([os.path.join(self.root, SET_ASIDE)], include_top=True)
        self.x("DELETE FROM dup_ok")
        self._pair_up()
        return {"restored": len(rows)}

    # ======================================================================= #
    # Locations
    # ======================================================================= #

    def location_days(self):
        with self.lock:
            if self._loc is not None:
                return self._loc
            rows = self.q("""SELECT id, taken, date_source, lat, lon, place, gps_source, loc_skip, thumb, kind
                FROM files WHERE status='active' AND pair_of IS NULL ORDER BY taken""")
            anchors = []
            by_day_anchor = defaultdict(list)
            for r in rows:
                if r["lat"] is not None and r["gps_source"] != "nearby":
                    try:
                        t = iso_to_ts(r["taken"])
                    except (ValueError, OverflowError):
                        continue
                    anchors.append((t, r["lat"], r["lon"], r["place"]))
                    by_day_anchor[r["taken"][:10]].append(r)
            anchors.sort()
            times = [a[0] for a in anchors]
            suggestions = {}
            days = defaultdict(list)
            for r in rows:
                if r["lat"] is not None or r["loc_skip"]:
                    continue
                day = r["taken"][:10]
                days[day].append(r)
                if r["date_source"] in ("file",):
                    continue
                if r["date_source"] not in NO_TIME and anchors:
                    t = iso_to_ts(r["taken"])
                    i = bisect.bisect_left(times, t)
                    best = None
                    for j in (i - 1, i):
                        if 0 <= j < len(anchors):
                            gap = abs(anchors[j][0] - t)
                            if gap <= NEARBY_WINDOW and (best is None or gap < best[0]):
                                best = (gap, anchors[j])
                    if best:
                        a = best[1]
                        suggestions[r["id"]] = {"lat": a[1], "lon": a[2], "place": a[3],
                                                "why": "photo taken %s away" % _gap_words(best[0])}
                        continue
                same_day = by_day_anchor.get(day)
                if same_day:
                    lat0, lon0 = same_day[0]["lat"], same_day[0]["lon"]
                    if all(km_between(lat0, lon0, s["lat"], s["lon"]) <= DAY_CLUSTER_KM for s in same_day):
                        c = Counter(s["place"] for s in same_day).most_common(1)[0][0]
                        pick = next(s for s in same_day if s["place"] == c)
                        suggestions[r["id"]] = {"lat": pick["lat"], "lon": pick["lon"], "place": pick["place"],
                                                "why": "other photos that day"}
            out = []
            for day in sorted(days, reverse=True):
                items = days[day]
                sug = [suggestions.get(r["id"]) for r in items]
                covered = [s for s in sug if s]
                top = Counter(s["place"] for s in covered).most_common(1)[0][0] if covered else None
                why = Counter(s["why"].split(" taken ")[0] if " taken " in s["why"] else s["why"]
                              for s in covered)
                out.append({
                    "date": day, "count": len(items), "covered": len(covered),
                    "place": top, "why": ("from photos taken close in time" if why and "photo" in why.most_common(1)[0][0]
                                          else (why.most_common(1)[0][0] if why else None)),
                    "guessed_dates": sum(1 for r in items if r["date_source"] == "file"),
                    "ids": [r["id"] for r in items],
                    "suggested": {str(r["id"]): s for r, s in zip(items, sug) if s},
                })
            self._loc = {"days": out, "total": sum(d["count"] for d in out),
                         "covered": sum(d["covered"] for d in out)}
            return self._loc

    def accept_suggestions(self, ids=None):
        data = self.location_days()
        want = set(int(i) for i in ids) if ids is not None else None
        batch = []
        for d in data["days"]:
            for sid, s in d["suggested"].items():
                fid = int(sid)
                if want is None or fid in want:
                    batch.append((s["lat"], s["lon"], s["place"], fid))
        self.x("UPDATE files SET lat=?, lon=?, place=?, city=NULL, gps_source='nearby', gps_pending=1 WHERE id=?",
               batch, many=True)
        self._fill_places()
        self.invalidate()
        return {"updated": len(batch)}

    def set_location(self, ids, lat, lon, label=None, name=None):
        lat, lon = valid_coords(lat, lon)
        if lat is None:
            raise ValueError("That location doesn't look right.")
        place = None
        if self.geo.load():
            place = self.geo.label_with(name, lat, lon) if name else self.geo.label(lat, lon)
        place = place or label or name
        self.x("UPDATE files SET lat=?, lon=?, place=?, city=NULL, gps_source='manual', gps_pending=1, loc_skip=0 WHERE id=?",
               [(lat, lon, place, int(i)) for i in ids], many=True)
        self._fill_places()
        self.invalidate()
        return {"updated": len(ids), "place": place}

    # ---------- Places page: saved places, map points, batch geotagging ----------
    def my_places(self):
        rows = self.q("""SELECT p.*, (SELECT COUNT(*) FROM files f WHERE f.place_id=p.id AND f.status='active'
                         AND f.pair_of IS NULL) AS photos FROM my_places p ORDER BY starred DESC, name COLLATE NOCASE""")
        for r in rows:
            r["tags"] = split_tags(r["tags"])
        return rows

    def save_place(self, d):
        lat, lon = valid_coords(d.get("lat"), d.get("lon"))
        name = re.sub(r"\s+", " ", (d.get("name") or "")).strip()
        if lat is None:
            raise ValueError("Drop a pin on the map first.")
        if not name:
            raise ValueError("Give the place a name, like Mom's Cabin.")
        info = self.geo.details(lat, lon)
        tags = d.get("tags") or []
        if isinstance(tags, str):
            tags = split_tags(tags)
        vals = {"name": name, "lat": lat, "lon": lon, "precision": d.get("precision") or "exact",
                "radius": d.get("radius"), "type": (d.get("type") or "").strip() or None,
                "tags": ", ".join(tags) or None, "notes": (d.get("notes") or "").strip() or None,
                "starred": 1 if d.get("starred") else 0, "country": info.get("country"), "state": info.get("state"),
                "region": info.get("region"), "city": info.get("city"), "cover_id": d.get("cover_id")}
        pid = d.get("id")
        if pid:
            self.x("UPDATE my_places SET %s WHERE id=?" % ", ".join("%s=?" % k for k in vals),
                   list(vals.values()) + [int(pid)])
            # photos filed under this place follow it if it moved
            moved = self.q("SELECT id FROM files WHERE place_id=? AND (lat != ? OR lon != ?)", (int(pid), lat, lon))
            if moved:
                self.set_location([r["id"] for r in moved], lat, lon, name=name)
        else:
            vals["created"] = dt.datetime.now().isoformat(timespec="seconds")
            with self.lock:
                cur = self.db.execute("INSERT INTO my_places(%s) VALUES(%s)" % (", ".join(vals), ", ".join("?" * len(vals))),
                                      list(vals.values()))
                self.db.commit()
                pid = cur.lastrowid
        return next(p for p in self.my_places() if p["id"] == int(pid))

    def delete_place(self, pid):
        self.x("UPDATE files SET place_id=NULL WHERE place_id=?", (int(pid),))
        self.x("DELETE FROM my_places WHERE id=?", (int(pid),))
        return {"ok": True}

    def place_points(self):
        """Every photo with a location, for the map."""
        return [[r["id"], round(r["lat"], 6), round(r["lon"], 6), r["gps_precision"] or "exact"] for r in self.q(
            """SELECT id, lat, lon, gps_precision FROM files WHERE status='active' AND pair_of IS NULL
               AND lat IS NOT NULL""")]

    def places_photos(self, mode="none", ids=None, limit=3000):
        """Photos for the filmstrip: those without a location (with suggestions), or a given set."""
        if ids:
            ids = [int(i) for i in ids][:limit]
            rows = self.q("SELECT * FROM files WHERE id IN (%s) AND status='active' ORDER BY taken, path"
                          % ",".join("?" * len(ids)), ids)
        else:
            rows = self.q("""SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND lat IS NULL
                             AND loc_skip=0 ORDER BY taken DESC, path LIMIT ?""", (limit,))
        sug = {}
        if not ids:
            for d in self.location_days()["days"]:
                for k, v in d["suggested"].items():
                    sug[int(k)] = v
        total = len(rows) if ids else self.q("""SELECT COUNT(*) AS n FROM files WHERE status='active'
                AND pair_of IS NULL AND lat IS NULL AND loc_skip=0""")[0]["n"]
        return {"total": total, "items": [dict(
            self.public(r), lat=r["lat"], lon=r["lon"],
            precision=r["gps_precision"] or ("exact" if r["lat"] is not None else None),
            needs_date=r["date_source"] in NEEDS_DATE, suggest=sug.get(r["id"])) for r in rows]}

    def geotag(self, job, ids, lat, lon, name=None, precision="exact", radius=None, place_id=None):
        """Put one location on many photos and save it into the files (only the location changes)."""
        ids = [int(i) for i in ids]
        job.step("Setting the location", len(ids))
        with self.batch():
            self.set_location(ids, lat, lon, name=name or None)
            prec = precision if precision in ("exact", "approx", "place") else "exact"
            rad = float(radius) if radius and prec != "exact" else None
            self.x("UPDATE files SET gps_precision=?, gps_radius=?, place_id=? WHERE id=?",
                   [(prec, rad, int(place_id) if place_id else None, i) for i in ids + self.companions(ids)], many=True)
            job.done = len(ids)
            res = self.apply(job, ids, rename=False)
        return {"geotagged": len(ids), "failed": res.get("failed", []), "failed_count": res.get("failed_count", 0)}

    # ---------- offline map regions (kept on the drive with the photos) ----------
    def maps_dir(self):
        d = os.path.join(self.data, "maps")
        os.makedirs(d, exist_ok=True)
        return d

    def map_info(self):
        world = None
        for d in (os.environ.get("PO_MAP_DIR"), self.maps_dir(), os.path.join(app_dir(), "maps")):
            if d and os.path.exists(os.path.join(d, "world.pmtiles")):
                world = os.path.join(d, "world.pmtiles")
                break
        regions = []
        try:
            with open(os.path.join(self.maps_dir(), "regions.json"), encoding="utf-8") as f:
                regions = json.load(f)
        except Exception:
            regions = []
        regions = [r for r in regions if os.path.exists(os.path.join(self.maps_dir(), r["file"]))]
        for r in regions:
            r["size"] = os.path.getsize(os.path.join(self.maps_dir(), r["file"]))
        return {"world": world, "regions": regions, "tool": bool(pmtiles_tool()), "presets": MAP_PRESETS}

    def _save_regions(self, regions):
        keep = [{k: r[k] for k in ("id", "name", "bbox", "maxzoom", "file", "build") if k in r} for r in regions]
        with open(os.path.join(self.maps_dir(), "regions.json"), "w", encoding="utf-8") as f:
            json.dump(keep, f, indent=1)

    def map_estimate(self, bbox, maxzoom):
        tool = pmtiles_tool()
        if not tool:
            raise RuntimeError("The map download tool isn't included in this copy of the app.")
        url = latest_map_build()
        r = subprocess.run([tool, "extract", url, os.path.join(self.maps_dir(), "estimate.pmtiles"),
                            "--bbox=%s" % ",".join("%.5f" % x for x in bbox), "--maxzoom=%d" % int(maxzoom), "--dry-run"],
                           capture_output=True, text=True, timeout=180)
        text = r.stdout + r.stderr
        m = re.findall(r"([\d.]+)\s*(B|kB|KB|MB|GB|TB)\b", text)
        if not m:
            return {"bytes": None, "note": text.strip()[-300:]}
        num, unit = m[-1]
        mult = {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[unit]
        return {"bytes": int(float(num) * mult)}

    def map_download(self, job, name, bbox, maxzoom):
        tool = pmtiles_tool()
        if not tool:
            raise RuntimeError("The map download tool isn't included in this copy of the app.")
        job.step("Getting ready to download the %s map" % name)
        url = latest_map_build()
        try:
            est = self.map_estimate(bbox, maxzoom).get("bytes")
        except Exception:
            est = None
        rid = re.sub(r"[^a-z0-9]+", "-", fold(name)).strip("-") or "region"
        info = self.map_info()
        n, base = 2, rid
        while any(r["id"] == rid for r in info["regions"]):
            rid, n = "%s-%d" % (base, n), n + 1
        final = os.path.join(self.maps_dir(), rid + ".pmtiles")
        part = final + ".part"
        job.step("Downloading the %s map" % name, est or 0)
        proc = subprocess.Popen([tool, "extract", url, part, "--bbox=%s" % ",".join("%.5f" % x for x in bbox),
                                 "--maxzoom=%d" % int(maxzoom), "--download-threads=4"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        tail = []

        def reader():
            for line in iter(proc.stdout.readline, b""):
                tail.append(line.decode("utf-8", "replace"))
                del tail[:-20]
        threading.Thread(target=reader, daemon=True).start()
        while proc.poll() is None:
            time.sleep(1)
            try:
                size = os.path.getsize(part)
            except OSError:
                size = 0
            job.done = min(size, est) if est else 0
            job.message = "%s downloaded%s" % (fmt_bytes(size), (" of about " + fmt_bytes(est)) if est else "")
            if getattr(job, "cancel", False):
                proc.kill()
        if proc.returncode != 0 or not os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass
            raise RuntimeError("The map download didn't finish: " + "".join(tail)[-300:].strip())
        os.replace(part, final)
        regions = info["regions"] + [{"id": rid, "name": name, "bbox": bbox, "maxzoom": int(maxzoom),
                                      "file": rid + ".pmtiles", "build": url.rsplit("/", 1)[-1]}]
        self._save_regions(regions)
        return {"map_region": name, "bytes": os.path.getsize(final)}

    def map_delete(self, rid):
        info = self.map_info()
        keep = []
        for r in info["regions"]:
            if r["id"] == rid:
                try:
                    os.remove(os.path.join(self.maps_dir(), r["file"]))
                except OSError:
                    pass
            else:
                keep.append(r)
        self._save_regions(keep)
        return {"ok": True}

    def map_file(self, name):
        """Path of a map file the map view asks for (world or a downloaded region)."""
        if name == "world":
            return self.map_info()["world"]
        for r in self.map_info()["regions"]:
            if r["id"] == name:
                return os.path.join(self.maps_dir(), r["file"])
        return None

    def skip_location(self, ids, skip=True):
        self.x("UPDATE files SET loc_skip=? WHERE id=?", [(1 if skip else 0, int(i)) for i in ids], many=True)
        self.invalidate()
        return {"updated": len(ids)}

    def search_places(self, q):
        try:
            res = search_places_online(q)
            if res:
                return res
        except Exception:
            pass
        self.geo.load()
        return self.geo.search_offline(q)

    # ======================================================================= #
    # Inbox / review: new photos, edited one by one or in bulk
    # ======================================================================= #

    def review_items(self, ids=None, day=None, needs=False):
        if needs:
            rows = self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND " + NEEDS_SQL + " ORDER BY taken, path")
        elif ids:
            marks = ",".join("?" * len(ids))
            rows = self.q("SELECT * FROM files WHERE status='active' AND id IN (%s) ORDER BY taken, path" % marks,
                          [int(i) for i in ids])
        elif day:
            rows = self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND substr(taken,1,10)=? ORDER BY taken, path", (day,))
        else:
            rows = self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND batch IS NOT NULL ORDER BY taken, path")
        s = self.settings()
        dup_ids = set()
        for g in self.dup_groups():
            for f in g["files"]:
                dup_ids.add(f["id"])
        final = {c["id"]: c["new"] for c in self.plan()}
        return {"items": [self._review_public(r, s, dup_ids, final) for r in rows], "tags": self.all_tags()}

    def _review_public(self, r, s, dup_ids=(), final=None):
        out = self.public(r)
        out["new"] = (final or {}).get(r["id"]) or self.target_for(r, s)
        out["name_part"] = r["title"] if r["title"] is not None else extract_name(os.path.basename(r["path"]))
        out["default_name"] = short_place(r.get("city") or r["place"]) if r["place"] else ""
        out["dupe"] = r["id"] in dup_ids
        out["pending"] = bool(r["gps_pending"] or r["date_pending"] or r["tags_pending"] or r["rating_pending"])
        out["needs"] = ("date" if r["date_source"] in NEEDS_DATE else
                        "time" if r["date_source"] in NEEDS_TIME else None)
        return out

    def edit(self, ids, title=None, taken=None, shift=None, add_tags=None, remove_tags=None,
             date_only=False, use_file_date=False, rating=None):
        """Change name part, date/time (exact or shifted) and tags for one or more photos."""
        ids = [int(i) for i in ids]
        if not ids:
            return {"items": []}
        rows = {r["id"]: r for r in self.q(
            "SELECT * FROM files WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)}
        updates = []
        if title is not None:
            clean = BAD_CHARS_RE.sub(" ", title)
            clean = re.sub(r"\s+", " ", clean).strip(" .")
            self.x("UPDATE files SET title=? WHERE id=?", [(clean, i) for i in ids], many=True)
        if taken:
            t = taken.strip()
            if len(t) == 16:
                t += ":00"
            iso = parse_iso(t)
            if not iso:
                raise ValueError("That date doesn't look right.")
            updates = [(iso, i) for i in ids]
        elif shift:
            shift = int(shift)
            day_only = []
            for i in ids:
                r = rows.get(i)
                # photos still waiting for a date don't get one invented by a shift
                if r and r["taken"] and r["date_source"] not in NEEDS_DATE:
                    new = dt.datetime.strptime(r["taken"][:19], "%Y-%m-%dT%H:%M:%S") + dt.timedelta(seconds=shift)
                    (day_only if r["date_source"] in NO_TIME else updates).append(
                        (new.strftime("%Y-%m-%dT%H:%M:%S"), i))
            if day_only:
                self.x("UPDATE files SET taken=?, date_source='manual_date', date_pending=1, filedates=0 WHERE id=?",
                       day_only, many=True)
        if updates:
            self.x("UPDATE files SET taken=?, date_source='manual', date_pending=1, filedates=0 WHERE id=?", updates, many=True)
        if rating is not None:
            rv = int(rating) if int(rating) in (1, 2, 3, 4, 5) else None
            self.x("UPDATE files SET rating=?, rating_pending=1 WHERE id=?", [(rv, i) for i in ids], many=True)
        if date_only:
            self.x("UPDATE files SET date_source='manual_date', date_pending=1, filedates=0 WHERE id=?",
                   [(i,) for i in ids], many=True)
        if use_file_date:
            self.x("UPDATE files SET date_source='manual', date_pending=1, filedates=0 WHERE id=?",
                   [(i,) for i in ids], many=True)
        if add_tags or remove_tags:
            add = [t.strip() for t in (add_tags or []) if t and t.strip()]
            rem = set(t.strip().lower() for t in (remove_tags or []))
            batch = []
            for i in ids:
                r = rows.get(i)
                if not r:
                    continue
                tags = [t for t in split_tags(r["tags"]) if t.lower() not in rem]
                for t in add:
                    if t.lower() not in [x.lower() for x in tags]:
                        tags.append(t)
                batch.append((", ".join(tags) or None, i))
            self.x("UPDATE files SET tags=?, tags_pending=1 WHERE id=?", batch, many=True)
        self.invalidate()
        s = self.settings()
        fresh = self.q("SELECT * FROM files WHERE id IN (%s) ORDER BY taken, path" % ",".join("?" * len(ids)), ids)
        final = {c["id"]: c["new"] for c in self.plan()}
        return {"items": [self._review_public(r, s, (), final) for r in fresh]}

    def groups(self):
        """Existing groups: photos sharing a name, split where there's a gap of more than two weeks."""
        rows = self.q("""SELECT id, path, title, taken, place, lat, lon, kind FROM files
                         WHERE status='active' AND batch IS NULL AND pair_of IS NULL ORDER BY taken""")
        by = defaultdict(list)
        for r in rows:
            nm = r["title"] if r["title"] is not None else extract_name(os.path.basename(r["path"]))
            if nm:
                by[nm.lower()].append((r, nm))
        out = []
        for key, items in by.items():
            runs, cur = [], [items[0]]
            for prev, it in zip(items, items[1:]):
                try:
                    gap = iso_to_ts(it[0]["taken"]) - iso_to_ts(prev[0]["taken"])
                except (ValueError, OverflowError):
                    gap = 0
                if gap > 14 * 86400:
                    runs.append(cur)
                    cur = []
                cur.append(it)
            runs.append(cur)
            for run in runs:
                rs = [r for r, _ in run]
                places = Counter(r["place"] for r in rs if r["place"])
                anchor = next((r for r in rs if r["lat"] is not None), None)
                step = max(1, len(rs) // 4)
                out.append({
                    "key": "%s|%s" % (key, rs[0]["taken"][:10]),
                    "name": Counter(nm for _, nm in run).most_common(1)[0][0],
                    "start": rs[0]["taken"], "end": rs[-1]["taken"], "count": len(rs),
                    "videos": sum(1 for r in rs if r["kind"] == "video"),
                    "place": places.most_common(1)[0][0] if places else None,
                    "lat": anchor["lat"] if anchor else None, "lon": anchor["lon"] if anchor else None,
                    "thumbs": [r["id"] for r in rs[::step][:4]],
                })
        out.sort(key=lambda g: g["end"], reverse=True)
        return out

    def add_to_group(self, ids, key, taken=None, keep_dates=False):
        g = next((x for x in self.groups() if x["key"] == key), None)
        if not g:
            raise ValueError("I couldn't find that group any more.")
        ids = [int(i) for i in ids]
        self.edit(ids, title=g["name"])
        if g["lat"] is not None:
            missing = [r["id"] for r in self.q("SELECT id, lat FROM files WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)
                       if r["lat"] is None]
            if missing:
                self.x("""UPDATE files SET lat=?, lon=?, place=?, city=NULL, gps_source='manual', gps_pending=1, loc_skip=0
                          WHERE id=?""", [(g["lat"], g["lon"], g["place"], i) for i in missing], many=True)
                self._fill_places()
        if not keep_dates and taken:
            if len(ids) == 1:
                self.edit(ids, taken=taken)
            else:
                t = taken.strip() + (":00" if len(taken.strip()) == 16 else "")
                first = min(r["taken"] for r in self.q(
                    "SELECT taken FROM files WHERE id IN (%s)" % ",".join("?" * len(ids)), ids))
                shift = (dt.datetime.strptime(t, "%Y-%m-%dT%H:%M:%S") -
                         dt.datetime.strptime(first, "%Y-%m-%dT%H:%M:%S")).total_seconds()
                if shift:
                    self.edit(ids, shift=int(shift))
        self.invalidate()
        s = self.settings()
        fresh = self.q("SELECT * FROM files WHERE id IN (%s) ORDER BY taken, path" % ",".join("?" * len(ids)), ids)
        return {"items": [self._review_public(r, s) for r in fresh], "group": g["name"]}

    def mark_reviewed(self, ids=None):
        if ids is None:
            self.x("UPDATE files SET batch=NULL WHERE batch IS NOT NULL")
        else:
            self.x("UPDATE files SET batch=NULL WHERE id=?", [(int(i),) for i in ids], many=True)
        return {"ok": True}

    # ======================================================================= #
    # Organize: rename + folders + save dates/locations into files
    # ======================================================================= #

    def name_part(self, r):
        """A name the person gave (location + event) wins; otherwise the GPS place name."""
        name = r["title"] if r["title"] is not None else extract_name(os.path.basename(r["path"]))
        if not name:
            city = r.get("city") if hasattr(r, "get") else None
            name = short_place(city or r["place"])
        return name

    def group_months(self):
        """id -> (start month 'YYYY.MM', group name). A trip stays in the month it began."""
        with self.lock:
            if self._gm is not None:
                return self._gm
            rows = self.q("SELECT id, path, title, place, city, taken, date_source FROM files WHERE status='active' ORDER BY taken")
            by = defaultdict(list)
            for r in rows:
                if r["date_source"] in NEEDS_DATE:
                    continue
                nm = self.name_part(r)
                if nm:
                    by[nm.lower()].append((r, nm))
            gm = {}
            for items in by.values():
                runs, cur = [], [items[0]]
                for prev, it in zip(items, items[1:]):
                    try:
                        gap = iso_to_ts(it[0]["taken"]) - iso_to_ts(prev[0]["taken"])
                    except (ValueError, OverflowError):
                        gap = 0
                    if gap > GROUP_GAP:
                        runs.append(cur)
                        cur = []
                    cur.append(it)
                runs.append(cur)
                for run in runs:
                    month = run[0][0]["taken"][:7].replace("-", ".")
                    name = Counter(nm for _, nm in run).most_common(1)[0][0]
                    for r, _ in run:
                        gm[r["id"]] = (month, name)
            self._gm = gm
            return gm

    def target_for(self, r, s, group=None):
        # Style: 2025.12.25 1432 St. Barts Xmas NYE.jpg  (date, time, location + event)
        taken = r["taken"]
        parts = [taken[:10].replace("-", ".")]
        if s.get("time") == "1" and r["date_source"] not in NO_TIME:
            parts.append(taken[11:13] + taken[14:16])
        name = self.name_part(r)
        if name:
            parts.append(name)
        fname = " ".join(parts) + norm_ext(os.path.splitext(r["path"])[1])
        mode = s.get("folders", "month_group")
        if mode == "month_group":
            g = group if group is not None else self.group_months().get(r["id"])
            if g:
                folder = os.path.join(g[0], BAD_CHARS_RE.sub(" ", "%s %s" % g).strip().rstrip(" ."))
            else:
                folder = taken[:7].replace("-", ".")
        elif mode == "year_month":
            folder = os.path.join(taken[:4], taken[:7])
        elif mode == "year":
            folder = taken[:4]
        else:
            folder = ""
        return os.path.join(folder, fname) if folder else fname

    # ======================================================================= #
    # Tidy Up: pick photos already on the drive, change them, save just those
    # ======================================================================= #

    def tidy_browse(self, folder="", q="", limit=600):
        folder = folder.strip("/")
        rows = self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL ORDER BY taken, path")
        final = {c["id"]: c["new"] for c in self.plan() if not c["lead"]}
        raws = self._raw_map()
        pre = folder + "/" if folder else ""
        subs = {}
        here = []
        if q:
            ids = set(self.search(name=q, ids_only=True)) | set(self.search(place=q, ids_only=True))
            here = [r for r in rows if r["id"] in ids]
        else:
            for r in rows:
                p = r["path"]
                if pre and not p.startswith(pre):
                    continue
                rest = p[len(pre):]
                if "/" in rest:
                    name = rest.split("/", 1)[0]
                    d = subs.setdefault(name, {"name": name, "path": pre + name, "count": 0, "cover": None})
                    d["count"] += 1
                    if d["cover"] is None and r["thumb"] == 1:
                        d["cover"] = r["id"]
                else:
                    here.append(r)
        s = self.settings()
        photos = []
        for r in here[:limit]:
            new = final.get(r["id"], r["path"])
            photos.append(dict(self._split_name(r, new), id=r["id"], name=os.path.basename(r["path"]), path=r["path"],
                               taken=r["taken"], date_source=r["date_source"], place=r["place"], kind=r["kind"],
                               thumb=r["thumb"], tags=split_tags(r["tags"]), raw=raws.get(r["id"]),
                               lat=r["lat"], needs=r["date_source"] in NEEDS_DATE + NEEDS_TIME,
                               tidy=new == r["path"]))
        dated = sorted([d for d in subs.values() if d["name"][:1].isdigit()], key=lambda d: d["name"], reverse=True)
        other = sorted([d for d in subs.values() if not d["name"][:1].isdigit()], key=lambda d: d["name"].lower())
        folders = dated + other   # newest year and month first, then other folders
        return {"folder": folder, "folders": folders, "photos": photos, "total": len(here),
                "settings": s, "albums": [{"key": g["key"], "name": g["name"], "start": g["start"]} for g in self.groups()[:300]]}

    def _split_name(self, r, new, name=None):
        """Split a planned name into the fixed date part, the editable name, the number and the ending."""
        stem, ext = os.path.splitext(os.path.basename(new))
        m = re.match(r"^((?:19|20)\d{2}\.\d{2}\.\d{2}(?: \d{4})?)(?: |$)", stem)
        prefix = (m.group(1) + " ") if m else ""
        rest = stem[m.end():] if m else stem
        name = self.name_part(r) if name is None else name
        name = name or ""
        if rest == name:
            suffix = ""
        elif name and rest.startswith(name) and re.match(r"^ \d+$", rest[len(name):]):
            suffix = rest[len(name):]
        else:
            name, suffix = rest, ""
        return {"prefix": prefix, "np": name, "suffix": suffix, "ext": ext, "new": new, "folder_new": os.path.dirname(new)}

    def _tidy_rows(self, ids, title=None, names=None, shift=0, place=None, replace_place=False):
        """The selected photos as they would be after the edits (nothing is saved)."""
        ids = [int(i) for i in ids]
        names = {int(k): v for k, v in (names or {}).items()}
        rows = self.q("SELECT * FROM files WHERE status='active' AND id IN (%s)" % ",".join("?" * len(ids)), ids) if ids else []
        out = []
        city_cache = {}
        for r in rows:
            r = dict(r)
            if r["id"] in names:
                r["title"] = BAD_CHARS_RE.sub(" ", names[r["id"]]).strip()
            elif title is not None:
                r["title"] = BAD_CHARS_RE.sub(" ", title).strip()
            if shift and r["date_source"] not in NEEDS_DATE:
                t = dt.datetime.strptime(r["taken"], "%Y-%m-%dT%H:%M:%S") + dt.timedelta(seconds=int(shift))
                r["taken"] = t.strftime("%Y-%m-%dT%H:%M:%S")
                if r["date_source"] not in NO_TIME:
                    r["date_source"] = "manual"
            if place and (replace_place or r["lat"] is None):
                key = (round(place["lat"], 4), round(place["lon"], 4))
                if key not in city_cache:
                    self.geo.load()
                    city_cache[key] = self.geo.city(place["lat"], place["lon"]) if self.geo.grid is not None else None
                r["lat"], r["lon"] = place["lat"], place["lon"]
                r["city"] = city_cache[key] or place.get("name")
                r["place"] = place.get("label") or place.get("name")
            out.append(r)
        return out

    def tidy_preview(self, ids, title=None, names=None, shift=0, place=None, replace_place=False):
        s = self.settings()
        rows = [r for r in self._tidy_rows(ids, title, names, shift, place, replace_place)
                if r["date_source"] not in NEEDS_DATE + NEEDS_TIME]
        sel = set(r["id"] for r in rows)
        # trips stay together in the month they began (counting photos not selected that share the name)
        starts = {}
        if s.get("folders", "month_group") == "month_group":
            names_here = defaultdict(list)
            for r in rows:
                nm = self.name_part(r)
                if nm:
                    names_here[nm.lower()].append(r)
            others = defaultdict(list)
            for r in self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL"):
                if r["id"] in sel or r["date_source"] in NEEDS_DATE:
                    continue
                nm = self.name_part(r)
                if nm and nm.lower() in names_here:
                    others[nm.lower()].append(r)
            for key, group in names_here.items():
                pool = sorted(group + others.get(key, []), key=lambda x: x["taken"])
                # the run of photos (gaps under two weeks) around the selection
                runs, cur = [], [pool[0]]
                for a, b in zip(pool, pool[1:]):
                    if iso_to_ts(b["taken"]) - iso_to_ts(a["taken"]) > GROUP_GAP:
                        runs.append(cur)
                        cur = []
                    cur.append(b)
                runs.append(cur)
                for run in runs:
                    month = run[0]["taken"][:7].replace("-", ".")
                    nm = Counter(self.name_part(x) for x in run).most_common(1)[0][0]
                    for x in run:
                        if x["id"] in sel:
                            starts[x["id"]] = (month, nm)
        items = []
        month_group = s.get("folders", "month_group") == "month_group"
        for r in rows:
            # a photo with no name goes straight into its month folder
            target = self.target_for(r, s, starts.get(r["id"], ())) if month_group else self.target_for(r, s)
            items.append((r, target))
        # number photos that would share a name, in the order they were taken
        by = defaultdict(list)
        for r, t in items:
            by[t.lower()].append((r, t))
        final = {}
        for key, group in by.items():
            t = group[0][1]
            stem, ext = os.path.splitext(t)
            used = set()
            for x in self.q("SELECT id, path FROM files WHERE status='active' AND lower(path) LIKE ? ESCAPE '\\'",
                            (stem.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",)):
                if x["id"] in sel:
                    continue
                p = x["path"].lower()
                if not p.endswith(ext.lower()):
                    continue
                rest = p[len(stem):len(p) - len(ext)]
                if rest == "":
                    used.add(1)
                elif rest.startswith(" ") and rest[1:].isdigit():
                    used.add(int(rest[1:]))
            group.sort(key=lambda g: (g[0]["taken"], g[0]["path"]))
            k = 1
            for r, _ in group:
                while k in used:
                    k += 1
                used.add(k)
                final[r["id"]] = t if k == 1 else "%s %d%s" % (stem, k, ext)
        out = []
        for r in rows:
            new = final[r["id"]]
            out.append(dict(self._split_name(r, new), id=r["id"], old=r["path"], changes=new != r["path"]))
        waiting = len(ids) - len(rows)
        return {"items": out, "waiting": waiting}

    def tidy_save(self, job, ids, title=None, names=None, shift=0, place=None, replace_place=False,
                  tags=None, album=None):
        ids = [int(i) for i in ids]
        names = {int(k): v for k, v in (names or {}).items()}
        job.step("Saving your changes")
        if album:
            try:
                self.add_to_group(ids, album, keep_dates=True)
            except ValueError:
                pass
        elif title is not None:
            rest = [i for i in ids if i not in names]
            if rest:
                self.edit(rest, title=title)
        for i, nm in names.items():
            self.edit([i], title=nm)
        if shift:
            dated = [r["id"] for r in self.q("SELECT id FROM files WHERE id IN (%s) AND NOT %s"
                                             % (",".join("?" * len(ids)), NEEDS_SQL), ids)]
            if dated:
                self.edit(dated, shift=int(shift))
        if place:
            targets = ids if replace_place else [r["id"] for r in self.q(
                "SELECT id FROM files WHERE lat IS NULL AND id IN (%s)" % ",".join("?" * len(ids)), ids)]
            if targets:
                self.set_location(targets, place["lat"], place["lon"], place.get("label"), place.get("name"))
        if tags:
            self.edit(ids, add_tags=list(tags))
        result = self.apply(job, ids)
        result["tidied"] = len(ids)
        return result

    def plan(self):
        s = self.settings()
        self._sync_pairs()
        every = self.q("SELECT * FROM files WHERE status='active' ORDER BY taken, path")
        rows = [r for r in every if not r["pair_of"]]
        raws = defaultdict(list)
        for r in every:
            if r["pair_of"]:
                raws[r["pair_of"]].append(r)
        taken_paths = set(r["path"].lower() for r in rows)
        changes, moving = [], []
        for r in rows:
            if r["date_source"] in NEEDS_DATE + NEEDS_TIME:
                continue
            target = self.target_for(r, s)
            if target == r["path"]:
                if r["gps_pending"] or r["date_pending"] or r["tags_pending"] or r["rating_pending"] or not r["filedates"]:
                    changes.append(self._change(r, r["path"]))
                continue
            moving.append((r, target))
        claimed = set()
        for r, target in moving:
            own = r["path"].lower()
            final = target
            base, ext = os.path.splitext(target)
            n = 2
            while True:
                low = final.lower()
                clash = (low in claimed or (low in taken_paths and low != own)
                         or (low != own and os.path.exists(self.full(final))))
                if not clash:
                    break
                final = "%s %d%s" % (base, n, ext)
                n += 1
            claimed.add(final.lower())
            if final == r["path"] and not (r["gps_pending"] or r["date_pending"] or r["tags_pending"]
                                           or r["rating_pending"] or not r["filedates"]):
                continue
            changes.append(self._change(r, final))
        # each RAW follows its JPEG: same folder, same name, its own ending
        lead_new = {c["id"]: c["new"] for c in changes}
        every_path = set(r["path"].lower() for r in every)
        raw_claimed = set()
        for lead in rows:
            for raw in raws.get(lead["id"], ()):
                target = os.path.splitext(lead_new.get(lead["id"], lead["path"]))[0] + norm_ext(os.path.splitext(raw["path"])[1])
                pending = raw["gps_pending"] or raw["date_pending"] or raw["tags_pending"] or raw["rating_pending"] or not raw["filedates"]
                if lead["date_source"] in NEEDS_DATE + NEEDS_TIME:
                    continue
                if target != raw["path"] or pending:
                    if target.lower() != raw["path"].lower() and (
                            target.lower() in raw_claimed or target.lower() in every_path
                            or os.path.exists(self.full(target))):
                        continue
                    raw_claimed.add(target.lower())
                    changes.append(self._change(raw, target))
        return changes

    def _change(self, r, new):
        return {"id": r["id"], "old": r["path"], "new": new, "kind": r["kind"], "lead": r["pair_of"],
                "gps": bool(r["gps_pending"]), "date": bool(r["date_pending"]),
                "tags": bool(r["tags_pending"]), "filedates": not r["filedates"],
                "rating": bool(r["rating_pending"]),
                "guessed": r["date_source"] == "file", "thumb": r["thumb"]}

    def unorganized_count(self):
        """Quick count of photos whose name or folder doesn't match the style yet (not in the Inbox)."""
        s = self.settings()
        n = 0
        for r in self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND batch IS NULL AND NOT " + NEEDS_SQL):
            if self.target_for(r, s) != r["path"]:
                n += 1
        return n

    def plan_groups(self, changes, offset=0, limit=40):
        """The planned renames, grouped by destination folder, with the editable name part
        of each photo pulled out so it can be changed."""
        rows = {r["id"]: r for r in self.q("SELECT * FROM files WHERE status='active'")}
        raws = defaultdict(list)
        for c in changes:
            if c["lead"]:
                raws[c["lead"]].append(c)
        groups, order = {}, []
        for c in changes:
            if c["lead"] or c["old"] == c["new"]:
                continue
            r = rows.get(c["id"])
            if not r:
                continue
            folder = os.path.dirname(c["new"])
            stem, ext = os.path.splitext(os.path.basename(c["new"]))
            m = re.match(r"^((?:19|20)\d{2}\.\d{2}\.\d{2}(?: \d{4})?)(?: |$)", stem)
            prefix = (m.group(1) + " ") if m else ""
            rest = stem[m.end():] if m else stem
            name = self.name_part(r) or ""
            if rest == name:
                suffix = ""
            elif name and rest.startswith(name) and re.match(r"^ \d+$", rest[len(name):]):
                suffix = rest[len(name):]
            else:
                name, suffix = rest, ""
            item = {"id": c["id"], "old": c["old"], "prefix": prefix, "name": name, "suffix": suffix, "ext": ext,
                    "thumb": c["thumb"], "gps": c["gps"], "date": c["date"], "tags": c["tags"],
                    "own": r["title"] is not None,
                    "raw": [os.path.splitext(x["new"])[1].lstrip(".").upper() for x in raws.get(c["id"], [])]}
            if folder not in groups:
                groups[folder] = {"folder": folder, "items": []}
                order.append(folder)
            groups[folder]["items"].append(item)
        out = []
        for f in order[offset:offset + limit]:
            g = groups[f]
            names = Counter(i["name"] for i in g["items"])
            g["name"] = names.most_common(1)[0][0] if names else ""
            g["count"] = len(g["items"])
            g["items"] = g["items"][:60]
            out.append(g)
        return out, len(order)

    def plan_summary(self, limit=300, offset=0):
        changes = self.plan()
        groups, ngroups = self.plan_groups(changes, offset)
        return {
            "groups": groups, "group_total": ngroups, "group_offset": offset,
            "settings": self.settings(),
            "renames": sum(1 for c in changes if c["old"] != c["new"]),
            "gps": sum(1 for c in changes if c["gps"]),
            "dates": sum(1 for c in changes if c["date"]),
            "tags": sum(1 for c in changes if c["tags"]),
            "filedates": sum(1 for c in changes if c["filedates"]),
            "guessed": 0,
            "needs_date": self.q("SELECT COUNT(*) AS n FROM files WHERE status='active' AND " + NEEDS_SQL)[0]["n"],
            "total": len(changes),
            "sample": changes[:limit],
            "can_undo": self.last_log() is not None,
            "highlights": len(self.highlight_rows()),
        }

    def apply(self, job, ids=None, rename=True):
        with self.batch():
            return self._apply(job, ids, rename)

    def _apply(self, job, ids=None, rename=True):
        changes = self.plan()
        if ids is not None:
            ids = list(ids) + self.companions(ids)
            want = set(int(i) for i in ids)
            changes = [c for c in changes if c["id"] in want]
        writes = [c for c in changes if c["gps"] or c["date"] or c["tags"] or c["rating"] or c["filedates"]]
        job.step("Saving dates, places and tags into photos", len(writes))
        failed = []
        for c in writes:
            r = self.get(c["id"])
            args = []
            if c["gps"] and r["lat"] is not None:
                if r["kind"] == "video":
                    coords = "%.6f, %.6f, 0" % (r["lat"], r["lon"])
                    args += ["-Keys:GPSCoordinates=" + coords, "-UserData:GPSCoordinates=" + coords]
                else:
                    args += ["-GPSLatitude*=%.6f" % r["lat"], "-GPSLongitude*=%.6f" % r["lon"]]
                    # how sure the spot is: 'about 500 m' for approximate or place-only locations
                    radius = r.get("gps_radius") if r.get("gps_precision") in ("approx", "place") else None
                    args += ["-GPSHPositioningError=%d" % radius] if radius else ["-GPSHPositioningError="]
                    info = self.geo.details(r["lat"], r["lon"]) if self.geo.load() else {}
                    named = None
                    if r.get("place_id"):
                        pl = self.q("SELECT name FROM my_places WHERE id=?", (r["place_id"],))
                        named = pl[0]["name"] if pl else None
                    for tag, val in (("XMP-photoshop:City", info.get("city")), ("XMP-photoshop:State", info.get("state")),
                                     ("XMP-photoshop:Country", info.get("country")),
                                     ("XMP-iptcCore:Location", named)):
                        args.append("-%s=%s" % (tag, val or ""))
            if c["date"]:
                stamp = r["taken"].replace("-", ":").replace("T", " ")
                if r["kind"] == "video":
                    args += ["-api", "QuickTimeUTC=1", "-QuickTime:CreateDate=" + stamp,
                             "-QuickTime:MediaCreateDate=" + stamp, "-Keys:CreationDate=" + stamp]
                else:
                    args += ["-DateTimeOriginal=" + stamp, "-CreateDate=" + stamp]
            if c["tags"]:
                people = split_tags(r["people"])
                tags = split_tags(r["tags"])
                tags += [p for p in people if p.lower() not in [t.lower() for t in tags]]
                args += ["-XMP-dc:Subject=" + t for t in tags] or ["-XMP-dc:Subject="]
                args += ["-XMP-iptcExt:PersonInImage=" + p for p in people] or ["-XMP-iptcExt:PersonInImage="]
                if os.path.splitext(r["path"])[1].lower() in (".jpg", ".jpeg", ".tif", ".tiff"):
                    args += ["-codedcharacterset=utf8"]
                    args += ["-IPTC:Keywords=" + t for t in tags] or ["-IPTC:Keywords="]
            if c["rating"]:
                args += ["-XMP-xmp:Rating=%d" % r["rating"] if r["rating"] else "-XMP-xmp:Rating="]
            # Finder's Created / Modified dates match the name too
            stamp = r["taken"].replace("-", ":").replace("T", " ")
            args += ["-FileModifyDate=" + stamp]
            if IS_MAC:
                args += ["-FileCreateDate=" + stamp]
            ok = True
            if args:
                try:
                    ok, msg = self.et.write(self.full(r["path"]), args)
                except RuntimeError as e:
                    ok, msg = False, str(e)
                if not ok:
                    failed.append({"name": os.path.basename(r["path"]), "error": msg[:200]})
                try:
                    st = os.stat(self.full(r["path"]))
                    self.x("UPDATE files SET size=?, mtime=?, sha256=NULL WHERE id=?",
                           (st.st_size, st.st_mtime, r["id"]))
                except OSError:
                    pass
            if ok:   # only mark as saved what really was saved — failures are tried again next time
                self.x("UPDATE files SET gps_pending=0, date_pending=0, tags_pending=0, rating_pending=0, filedates=1 WHERE id=?",
                       (c["id"],))
            job.done += 1

        moves = [c for c in changes if c["old"] != c["new"]] if rename else []
        job.step("Renaming and filing", len(moves))
        log_path = os.path.join(self.data, "logs", "organize-%s.csv" % dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
        lead_moving = set(c["id"] for c in moves if not c["lead"])
        lead_moved = set()
        dirs = set()
        moved = 0
        with open(log_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "old", "new"])
            for c in moves:
                src, dst = self.full(c["old"]), self.full(c["new"])
                job.done += 1
                if c["lead"] and c["lead"] in lead_moving and c["lead"] not in lead_moved:
                    continue   # its JPEG couldn't move, so the RAW stays with it
                if not os.path.exists(src):
                    continue
                if os.path.exists(dst) and src.lower() != dst.lower():
                    failed.append({"name": c["new"], "error": "a file with that name is already there"})
                    continue
                side = find_sidecar(src)
                try:
                    move_file(src, dst)
                except OSError as e:
                    failed.append({"name": c["new"], "error": str(e)[:200]})
                    continue
                row = self.get(c["id"])
                try:
                    self.x("UPDATE files SET path=?, title=? WHERE id=?",
                           (c["new"], self.name_part(row) if row else None, c["id"]))
                except sqlite3.IntegrityError:
                    move_file(dst, src)   # put it back so the catalog and the drive agree
                    failed.append({"name": c["new"], "error": "that name is already taken in your library"})
                    continue
                if side:
                    try:
                        move_file(side, unique_path(dst + ".json"))
                    except OSError:
                        pass
                lead_moved.add(c["id"])
                w.writerow([c["id"], c["old"], c["new"]])
                f.flush()
                dirs.add(os.path.dirname(src))
                moved += 1
        if moved == 0:
            os.remove(log_path)
        self._remove_empty_dirs(dirs)
        # photos still waiting for a date stay in the Inbox
        if not rename:
            pass
        elif ids is None:
            self.x("UPDATE files SET batch=NULL WHERE status='active' AND NOT " + NEEDS_SQL)
        else:
            waiting = set(r["id"] for r in self.q("SELECT id FROM files WHERE " + NEEDS_SQL))
            self.x("UPDATE files SET batch=NULL WHERE id=?",
                   [(int(i),) for i in ids if int(i) not in waiting], many=True)
        hl = self.sync_highlights(job)
        return {"moved": moved, "written": sum(1 for c in writes if c["gps"] or c["date"] or c["tags"]),
                "highlights_added": hl["highlights_added"], "highlights_removed": hl["highlights_removed"],
                "synced": len(writes), "failed": failed[:50],
                "failed_count": len(failed)}

    # ======================================================================= #
    # People: find faces, group them, you name them once
    # ======================================================================= #

    def faces_ready(self):
        try:
            import onnxruntime  # noqa: F401
            import numpy  # noqa: F401
        except Exception:
            return False
        import faces as fx
        return fx.model_ready(app_dir())

    def _engine(self):
        if getattr(self, "_face_engine", None) is None:
            import faces as fx
            self._face_engine = fx.FaceEngine(app_dir())
        return self._face_engine

    def face_thumb_path(self, face_id):
        d = os.path.join(self.data, "faces", "%02x" % (int(face_id) % 256))
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "%d.jpg" % int(face_id))

    def face_setup(self, job):
        import faces as fx
        try:
            import onnxruntime  # noqa: F401
        except Exception:
            raise RuntimeError("Face recognition needs an update to the app's building blocks. "
                               "Close the app and start it again with Start Picture Perfect.")
        job.step("Setting up face recognition")
        fx.download_model(app_dir(), job)
        self.set_settings({"faces": "on"})
        return self.face_scan(job)

    def face_scan(self, job):
        import numpy as np
        rows = self.q("SELECT id, path FROM files WHERE status='active' AND kind='photo' AND faces_done=0 AND pair_of IS NULL ORDER BY taken")
        if rows:
            eng = self._engine()
            job.step("Finding faces", len(rows))

            def load(r):
                try:
                    im = self.open_image(self.full(r["path"]), 1600)
                    if im is None:
                        return r, None
                    try:
                        im = ImageOps.exif_transpose(im)
                    except Exception:
                        pass
                    im = im.convert("RGB")
                    im.thumbnail((1600, 1600))
                    return r, im
                except Exception:
                    return r, None

            nfaces = self.q("SELECT COUNT(*) AS n FROM faces")[0]["n"]
            with ThreadPoolExecutor(max_workers=2) as pool:
                for r, im in pool.map(load, rows):
                    found = []
                    if im is not None:
                        try:
                            found = eng.analyse(im)
                        except Exception:
                            found = []
                    with self.lock:
                        nfaces -= self.db.execute("DELETE FROM faces WHERE file_id=?", (r["id"],)).rowcount
                        nfaces += len(found)
                        for f in found:
                            cur = self.db.execute(
                                "INSERT INTO faces(file_id, x, y, w, h, score, size, emb) VALUES(?,?,?,?,?,?,?,?)",
                                (r["id"], f["box"][0], f["box"][1], f["box"][2], f["box"][3], f["score"], f["size"],
                                 np.asarray(f["emb"], dtype=np.float16).tobytes()))
                            f["thumb"].save(self.face_thumb_path(cur.lastrowid), "JPEG", quality=85)
                        self.db.execute("UPDATE files SET faces_done=1 WHERE id=?", (r["id"],))
                        if job.done % 100 == 0:
                            self.db.commit()
                    job.done += 1
                    job.message = "%s faces so far" % format(max(0, nfaces), ",")
            with self.lock:
                self.db.commit()
        job.step("Grouping faces")
        self.face_group()
        return {"faces": self.q("SELECT COUNT(*) AS n FROM faces")[0]["n"]}

    def _face_rows(self):
        import numpy as np
        rows = self.q("""SELECT f.id, f.file_id, f.score, f.size, f.emb, f.person_id, f.status, f.not_person
                         FROM faces f JOIN files x ON x.id=f.file_id WHERE x.status='active'""")
        if not rows:
            return rows, np.zeros((0, 512), dtype=np.float32)
        E = np.stack([np.frombuffer(r["emb"], dtype=np.float16).astype(np.float32) for r in rows])
        E /= np.maximum(1e-6, np.linalg.norm(E, axis=1, keepdims=True))
        return rows, E

    def face_group(self):
        """Suggest named people for new faces, and pile the rest up by likeness."""
        import numpy as np
        with self.lock:
            self.db.execute("DELETE FROM faces WHERE file_id NOT IN (SELECT id FROM files)")
            self.db.commit()
        rows, E = self._face_rows()
        if not rows:
            return
        # each named person's typical face
        pids = sorted(set(r["person_id"] for r in rows if r["status"] == "confirmed" and r["person_id"]))
        cents = []
        for pid in pids:
            idx = [i for i, r in enumerate(rows) if r["status"] == "confirmed" and r["person_id"] == pid]
            c = E[idx].mean(axis=0)
            cents.append(c / max(1e-6, np.linalg.norm(c)))
        C = np.stack(cents) if cents else np.zeros((0, 512), dtype=np.float32)
        updates = []
        loose = []
        for i, r in enumerate(rows):
            if r["status"] in ("confirmed", "ignored"):
                continue
            good = r["size"] >= 50 and r["score"] >= 0.6
            best_pid, best = None, 0.0
            if len(C):
                sims = C @ E[i]
                for k in np.argsort(-sims)[:3]:
                    if pids[k] != r["not_person"]:
                        best_pid, best = pids[k], float(sims[k])
                        break
            need = FACE_MATCH if good else FACE_MATCH + 0.1
            if best_pid and best >= need:
                updates.append((best_pid, "suggested", None, r["id"]))
            else:
                updates.append((None, "unknown", None, r["id"]))
                if good:
                    loose.append(i)
        # pile up the unnamed faces: each joins the closest pile if alike enough
        cluster_of = {}
        piles = []
        dim = E.shape[1] if len(E) else 512
        sums = np.zeros((max(1, len(loose)), dim), dtype=np.float32)
        P = np.zeros_like(sums)          # each pile's typical face, kept up to date
        for i in loose:
            e = E[i]
            n = len(piles)
            if n:
                sims = P[:n] @ e
                k = int(np.argmax(sims))
                if sims[k] >= FACE_MATCH:
                    piles[k].append(i)
                    sums[k] += e
                    P[k] = sums[k] / max(1e-6, float(np.linalg.norm(sums[k])))
                    cluster_of[rows[i]["id"]] = k + 1
                    continue
            piles.append([i])
            sums[n] = e
            P[n] = e / max(1e-6, float(np.linalg.norm(e)))
            cluster_of[rows[i]["id"]] = len(piles)
        updates = [(p, s, cluster_of.get(fid), fid) for p, s, _, fid in updates]
        # faces you confirmed or hid while this was running are left as you set them
        self.x("UPDATE faces SET person_id=?, status=?, cluster=? WHERE id=? AND status NOT IN ('confirmed','ignored')",
               updates, many=True)

    def _refresh_people_on_files(self, file_ids):
        file_ids = list(set(int(i) for i in file_ids if i))
        if not file_ids:
            return
        changed = []
        for k in range(0, len(file_ids), 800):
            chunk = file_ids[k:k + 800]
            marks = ",".join("?" * len(chunk))
            names = defaultdict(set)
            for r in self.q("""SELECT f.file_id, p.name FROM faces f JOIN people p ON p.id=f.person_id
                               WHERE f.status='confirmed' AND f.file_id IN (%s)""" % marks, chunk):
                names[r["file_id"]].add(r["name"])
            for r in self.q("SELECT id, people FROM files WHERE id IN (%s)" % marks, chunk):
                new = ", ".join(sorted(names.get(r["id"], ()), key=str.lower)) or None
                if new != r["people"]:
                    changed.append((new, r["id"]))
        if changed:
            self.x("UPDATE files SET people=?, tags_pending=1 WHERE id=?", changed, many=True)

    def _person_id(self, name):
        name = re.sub(r"\s+", " ", BAD_CHARS_RE.sub(" ", name or "")).strip()
        if not name:
            raise ValueError("Type a name.")
        r = self.q("SELECT id FROM people WHERE name=? COLLATE NOCASE", (name,))
        if r:
            return r[0]["id"]
        with self.lock:
            cur = self.db.execute("INSERT INTO people(name) VALUES(?)", (name,))
            self.db.commit()
            return cur.lastrowid

    def _files_of_faces(self, face_ids):
        if not face_ids:
            return []
        return [r["file_id"] for r in self.q("SELECT DISTINCT file_id FROM faces WHERE id IN (%s)"
                                             % ",".join("?" * len(face_ids)), [int(i) for i in face_ids])]

    def people_overview(self):
        total = self.q("SELECT COUNT(*) AS n FROM files WHERE status='active' AND kind='photo' AND pair_of IS NULL")[0]["n"]
        done = self.q("SELECT COUNT(*) AS n FROM files WHERE status='active' AND kind='photo' AND pair_of IS NULL AND faces_done=1")[0]["n"]
        people = self.q("""SELECT p.id, p.name,
                SUM(CASE WHEN f.status='confirmed' THEN 1 ELSE 0 END) AS photos,
                SUM(CASE WHEN f.status='suggested' THEN 1 ELSE 0 END) AS suggested,
                (SELECT f2.id FROM faces f2 WHERE f2.person_id=p.id AND f2.status='confirmed' ORDER BY f2.size DESC LIMIT 1) AS cover
                FROM people p LEFT JOIN faces f ON f.person_id=p.id
                LEFT JOIN files x ON x.id=f.file_id AND x.status='active'
                GROUP BY p.id ORDER BY photos DESC, p.name""")
        piles = self.q("""SELECT f.cluster, COUNT(*) AS n FROM faces f JOIN files x ON x.id=f.file_id
                          WHERE x.status='active' AND f.status='unknown' AND f.cluster IS NOT NULL
                          GROUP BY f.cluster HAVING n >= 2 ORDER BY n DESC LIMIT 80""")
        groups = []
        for g in piles:
            ids = [r["id"] for r in self.q("""SELECT id FROM faces WHERE cluster=? AND status='unknown'
                                              ORDER BY size DESC LIMIT 8""", (g["cluster"],))]
            groups.append({"cluster": g["cluster"], "count": g["n"], "faces": ids})
        singles = self.q("""SELECT COUNT(*) AS n FROM faces f JOIN files x ON x.id=f.file_id
                            WHERE x.status='active' AND f.status='unknown'""")[0]["n"] - sum(g["count"] for g in groups)
        return {"ready": self.faces_ready(), "on": self.settings().get("faces") == "on",
                "photos": total, "scanned": done,
                "faces": self.q("SELECT COUNT(*) AS n FROM faces")[0]["n"],
                "people": people, "groups": groups, "singles": max(0, singles)}

    def person_faces(self, pid=None, status="confirmed", cluster=None, limit=400):
        if cluster is not None:
            rows = self.q("""SELECT f.id, f.file_id, f.status FROM faces f JOIN files x ON x.id=f.file_id
                             WHERE x.status='active' AND f.cluster=? AND f.status='unknown' ORDER BY f.size DESC LIMIT ?""",
                          (int(cluster), limit))
        else:
            rows = self.q("""SELECT f.id, f.file_id, f.status FROM faces f JOIN files x ON x.id=f.file_id
                             WHERE x.status='active' AND f.person_id=? AND f.status=? ORDER BY x.taken DESC LIMIT ?""",
                          (int(pid), status, limit))
        return rows

    def name_faces(self, face_ids=None, cluster=None, name=""):
        pid = self._person_id(name)
        if cluster is not None:
            face_ids = [r["id"] for r in self.q("SELECT id FROM faces WHERE cluster=? AND status='unknown'", (int(cluster),))]
        face_ids = [int(i) for i in face_ids or []]
        self.x("UPDATE faces SET person_id=?, status='confirmed', cluster=NULL WHERE id=?",
               [(pid, i) for i in face_ids], many=True)
        self._refresh_people_on_files(self._files_of_faces(face_ids))
        self.face_group()
        return {"person": pid, "named": len(face_ids)}

    def confirm_faces(self, face_ids, yes=True):
        face_ids = [int(i) for i in face_ids]
        if yes:
            self.x("UPDATE faces SET status='confirmed' WHERE id=? AND person_id IS NOT NULL",
                   [(i,) for i in face_ids], many=True)
        else:   # "that's not them": never suggest this person for these faces again
            self.x("UPDATE faces SET not_person=person_id, person_id=NULL, status='unknown' WHERE id=?",
                   [(i,) for i in face_ids], many=True)
        self._refresh_people_on_files(self._files_of_faces(face_ids))
        self.face_group()
        return {"updated": len(face_ids)}

    def ignore_faces(self, face_ids=None, cluster=None):
        if cluster is not None:
            face_ids = [r["id"] for r in self.q("SELECT id FROM faces WHERE cluster=? AND status='unknown'", (int(cluster),))]
        face_ids = [int(i) for i in face_ids or []]
        files = self._files_of_faces(face_ids)
        self.x("UPDATE faces SET status='ignored', person_id=NULL, cluster=NULL WHERE id=?",
               [(i,) for i in face_ids], many=True)
        self._refresh_people_on_files(files)
        return {"ignored": len(face_ids)}

    def rename_person(self, pid, name):
        pid = int(pid)
        clean = re.sub(r"\s+", " ", BAD_CHARS_RE.sub(" ", name or "")).strip()
        if not clean:
            raise ValueError("Type a name.")
        other = self.q("SELECT id FROM people WHERE name=? COLLATE NOCASE AND id != ?", (clean, pid))
        files = [r["file_id"] for r in self.q("SELECT DISTINCT file_id FROM faces WHERE person_id=?", (pid,))]
        if other:   # same name as someone else: they're one person
            self.x("UPDATE faces SET person_id=? WHERE person_id=?", (other[0]["id"], pid))
            self.x("UPDATE faces SET not_person=? WHERE not_person=?", (other[0]["id"], pid))
            self.x("DELETE FROM people WHERE id=?", (pid,))
            pid = other[0]["id"]
        else:
            self.x("UPDATE people SET name=? WHERE id=?", (clean, pid))
        self._refresh_people_on_files(files)
        self.face_group()
        return {"person": pid}

    def forget_person(self, pid):
        pid = int(pid)
        files = [r["file_id"] for r in self.q("SELECT DISTINCT file_id FROM faces WHERE person_id=?", (pid,))]
        self.x("UPDATE faces SET person_id=NULL, status='unknown' WHERE person_id=?", (pid,))
        self.x("UPDATE faces SET not_person=NULL WHERE not_person=?", (pid,))
        self.x("DELETE FROM people WHERE id=?", (pid,))
        self._refresh_people_on_files(files)
        self.face_group()
        return {"ok": True}

    def faces_in_file(self, fid):
        return self.q("""SELECT f.id, f.x, f.y, f.w, f.h, f.status, p.name FROM faces f
                         LEFT JOIN people p ON p.id=f.person_id WHERE f.file_id=? AND f.status != 'ignored'""", (int(fid),))

    # ---------- year highlights: copies of your top-rated photos ----------
    def highlight_rows(self):
        mode = self.settings().get("highlights", "5")
        if mode == "off":
            return []
        return self.q("SELECT * FROM files WHERE status='active' AND pair_of IS NULL AND rating >= ? AND NOT " + NEEDS_SQL +
                      " ORDER BY taken", (int(mode),))

    def sync_highlights(self, job=None):
        """Keep '2025 Highlights' etc. holding a copy of each top-rated photo from that year.
        Only copies the app made are ever removed."""
        want, low = defaultdict(dict), defaultdict(dict)
        for r in self.highlight_rows():
            year = r["taken"][:4]
            name = os.path.basename(r["path"])
            base, ext = os.path.splitext(name)
            k = 2
            # exFAT ignores capitals, so IMG_1.JPG and img_1.jpg would be the same file
            while name.lower() in low[year] and low[year][name.lower()]["id"] != r["id"]:
                name = "%s %d%s" % (base, k, ext)
                k += 1
            want[year][name] = r
            low[year][name.lower()] = r
        years = set(want) | set(d[:4] for d in os.listdir(self.root) if HIGHLIGHTS_RE.match(d))
        added = removed = 0
        for year in sorted(years):
            folder = os.path.join(self.root, "%s Highlights" % year)
            mpath = os.path.join(folder, ".highlights.json")
            try:
                with open(mpath, encoding="utf-8") as f:
                    manifest = json.load(f)
            except Exception:
                manifest = {}
            for name in list(manifest):
                if name not in want.get(year, {}):
                    try:
                        os.remove(os.path.join(folder, name))
                    except OSError:
                        pass
                    del manifest[name]
                    removed += 1
            try:
                added += self._fill_highlights(folder, manifest, want.get(year, {}))
            finally:   # always remember which copies are ours, even if copying stopped part way
                self._save_highlights(folder, mpath, manifest)
        return {"highlights_added": added, "highlights_removed": removed}

    def _fill_highlights(self, folder, manifest, wanted):
        added = 0
        for name, r in wanted.items():
                src = self.full(r["path"])
                try:
                    st = os.stat(src)
                except OSError:
                    continue
                dst = os.path.join(folder, name)
                m = manifest.get(name)
                if m and m.get("src") == r["path"] and m.get("size") == st.st_size and os.path.exists(dst):
                    continue
                os.makedirs(folder, exist_ok=True)
                if os.path.exists(dst) and name not in manifest:
                    continue   # a file you put there yourself; leave it alone
                if os.path.exists(dst):
                    os.remove(dst)
                copied = False
                if IS_MAC and getattr(self, "_can_clone", True):   # APFS only: shares the original's space
                    copied = subprocess.run(["cp", "-c", "-p", src, dst], stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL).returncode == 0
                    if not copied:
                        self._can_clone = False   # exFAT and other formats: make ordinary copies
                        if os.path.exists(dst):
                            os.remove(dst)
                if not copied:
                    try:
                        shutil.copy2(src, dst)
                    except OSError as e:
                        print("highlight copy failed:", name, e)
                        try:
                            os.remove(dst)
                        except OSError:
                            pass
                        continue
                manifest[name] = {"src": r["path"], "size": st.st_size}
                added += 1
        return added

    def _save_highlights(self, folder, mpath, manifest):
            if manifest:
                with open(mpath, "w", encoding="utf-8") as f:
                    json.dump(manifest, f, indent=1)
            elif os.path.isdir(folder):
                try:
                    os.remove(mpath)
                except OSError:
                    pass
                left = [x for x in os.listdir(folder) if x != ".DS_Store" and not x.startswith("._")]
                if not left:
                    shutil.rmtree(folder, ignore_errors=True)

    def highlights_job(self, job):
        job.step("Updating your highlights")
        return self.sync_highlights(job)

    def last_log(self):
        d = os.path.join(self.data, "logs")
        logs = sorted(f for f in os.listdir(d) if f.startswith("organize-") and f.endswith(".csv"))
        return os.path.join(d, logs[-1]) if logs else None

    def undo(self, job):
        with self.batch():
            return self._undo(job)

    def _undo(self, job):
        log = self.last_log()
        if not log:
            raise ValueError("There's nothing to undo.")
        with open(log, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        job.step("Putting names and folders back", len(rows))
        dirs, back = set(), 0
        for row in reversed(rows):
            src, dst = self.full(row["new"]), self.full(row["old"])
            job.done += 1
            if not os.path.exists(src) or (os.path.exists(dst) and src.lower() != dst.lower()):
                continue
            side = find_sidecar(src)
            try:
                move_file(src, dst)
            except OSError:
                continue
            if side:
                try:
                    move_file(side, unique_path(dst + ".json"))
                except OSError:
                    pass
            try:
                self.x("UPDATE files SET path=? WHERE id=?", (row["old"], int(row["id"])))
            except sqlite3.IntegrityError:
                move_file(dst, src)
                continue
            dirs.add(os.path.dirname(src))
            back += 1
        os.rename(log, log[:-4] + ".undone")
        self._remove_empty_dirs(dirs)
        self.sync_highlights(job)
        return {"restored": back}

    def _remove_empty_dirs(self, dirs, include_top=False):
        protected = {os.path.abspath(self.root), os.path.abspath(self.data)}
        for d in sorted(set(dirs), key=len, reverse=True):
            d = os.path.abspath(d)
            while d not in protected and d.startswith(self.root + os.sep):
                try:
                    left = [x for x in os.listdir(d) if x not in (".DS_Store",) and not x.startswith("._")]
                except OSError:
                    break
                if left:
                    break
                for x in os.listdir(d):
                    try:
                        os.remove(os.path.join(d, x))
                    except OSError:
                        pass
                try:
                    os.rmdir(d)
                except OSError:
                    break
                d = os.path.dirname(d)


def _gap_words(seconds):
    m = int(round(seconds / 60.0))
    if m < 1:
        return "under a minute"
    if m < 60:
        return "%d min" % m
    return "%.1f hr" % (m / 60.0)
