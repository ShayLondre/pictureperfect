"""On a Mac: pretend to be an old installed copy, let the updater fetch the newest release,
install it in place, and check that the app on disk is now the new version."""
import os, plistlib, shutil, subprocess, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "app"))
out = open(sys.argv[2], "w")
def say(*a):
    print(*a); print(*a, file=out); out.flush()

apps = sys.argv[1]                       # folder holding a "Picture Perfect.app" (the old copy)
app = os.path.join(apps, "Picture Perfect.app")
plist = os.path.join(app, "Contents", "Info.plist")
with open(plist, "rb") as f:
    info = plistlib.load(f)
info["CFBundleShortVersionString"] = "0.0.1"   # make it look old
with open(plist, "wb") as f:
    plistlib.dump(info, f)

sys.frozen = True
sys.executable = os.path.join(app, "Contents", "MacOS", "Picture Perfect")
import updater
say("current:", updater.current_version(), "bundle:", updater.app_bundle())
t = time.time()
st = updater.check_and_download()
say("check:", {k: st.get(k) for k in ("status", "latest", "error", "progress")}, round(time.time() - t, 1), "s")
if st["status"] != "ready":
    sys.exit(1)

pid = os.fork()
if pid == 0:            # the "app": starts the installer and quits
    updater.install_and_restart()
    time.sleep(10)
    os._exit(0)
os.waitpid(pid, 0)
for _ in range(60):     # the installer swaps the app once the old copy has quit
    time.sleep(1)
    try:
        with open(plist, "rb") as f:
            v = plistlib.load(f).get("CFBundleShortVersionString")
        if v != "0.0.1":
            break
    except Exception:
        v = None
say("installed version now:", v, "(expected %s)" % st["latest"])
say("leftovers:", sorted(os.listdir(apps)))
subprocess.run(["pkill", "-f", "Picture Perfect.app"])
say("UPDATE TEST", "PASSED" if v == st["latest"] else "FAILED")
