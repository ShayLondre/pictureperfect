# PyInstaller recipe for "Picture Perfect.app"
import os
from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
EXTRA = os.path.join(ROOT, "build_extra")
VERSION = os.environ.get("APP_VERSION", "1.0.0")

datas = [(os.path.join(ROOT, "app", "static"), "static")]
for name in ("exiftool", "models", "geo", "maps", "bin"):
    p = os.path.join(EXTRA, name)
    if os.path.isdir(p):
        datas.append((p, name))
binaries = []
hiddenimports = ["library", "faces", "server", "updater", "webview.platforms.cocoa", "Foundation"]
for pkg in ("onnxruntime", "pillow_heif"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(SPECPATH, "desktop.py")],
    pathex=[os.path.join(ROOT, "app")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "scipy", "pandas", "IPython"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Picture Perfect",
          console=False, argv_emulation=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Picture Perfect")
app = BUNDLE(
    coll,
    name="Picture Perfect.app",
    icon=os.path.join(EXTRA, "icon.icns"),
    bundle_identifier="com.pictureperfect.app",
    info_plist={
        "CFBundleName": "Picture Perfect",
        "CFBundleDisplayName": "Picture Perfect",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
        "NSAppleEventsUsageDescription": "Picture Perfect asks Finder to move photos you delete to the Trash and to show photos in Finder.",
        "NSRemovableVolumesUsageDescription": "Picture Perfect works with the photos on your external drive.",
    },
)
