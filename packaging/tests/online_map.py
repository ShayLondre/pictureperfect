"""Screenshots of the Places map with internet (run on GitHub's machines)."""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

U = "http://127.0.0.1:8799"
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
log = open(os.path.join(OUT, "online-test.txt"), "w")
def say(*a):
    print(*a); print(*a, file=log); log.flush()
def post(u, d):
    return json.loads(urllib.request.urlopen(urllib.request.Request(U + u, json.dumps(d).encode(), {"Content-Type": "application/json"})).read())

errs = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 1480, "height": 944})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text[:200]))
    pg.goto(U); time.sleep(3)
    pg.click("[data-tab=locations]"); time.sleep(8)
    say("status:", pg.inner_text("#pl-net"))
    pg.evaluate("PL.map.jumpTo({center: [-120.14, 39.07], zoom: 14})"); time.sleep(10)
    pg.screenshot(path=os.path.join(OUT, "online-map-tahoe.png"))
    pg.evaluate("PL.map.jumpTo({center: [-120.83, 39.3], zoom: 11})"); time.sleep(8)
    pg.screenshot(path=os.path.join(OUT, "online-map-hwy20.png"))
    pg.click("#pl-show button[data-v=satellite]"); time.sleep(10)
    pg.evaluate("PL.map.jumpTo({center: [-61.243, 13.007], zoom: 16})"); time.sleep(10)
    pg.screenshot(path=os.path.join(OUT, "satellite-bequia.png"))
    pg.click("#pl-show button[data-v=map]"); time.sleep(6)
    pg.fill("#pl-q", "10183 Truckee Airport Rd"); time.sleep(2)
    pg.click("#pl-results [data-online]"); time.sleep(6)
    say("online search:", pg.inner_text("#pl-results")[:300].replace("\n", " | "))
    pg.screenshot(path=os.path.join(OUT, "online-search.png"))
    # offline: the app should fall back to the built-in map
    pg.context.set_offline(True)
    pg.evaluate("window.dispatchEvent(new Event('offline'))"); time.sleep(6)
    say("status offline:", pg.inner_text("#pl-net"))
    pg.evaluate("PL.map.jumpTo({center: [-120.14, 39.07], zoom: 9})"); time.sleep(6)
    say("detail hint shown:", pg.is_visible("#pl-detail"))
    pg.screenshot(path=os.path.join(OUT, "offline-fallback.png"))
    b.close()
say("errors:", errs[:20])
