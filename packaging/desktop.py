"""Picture Perfect as a Mac app: starts the engine and shows it in its own window."""
import os
import socket
import sys
import threading
import time

BASE = getattr(sys, "_MEIPASS", os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def res(*parts):
    return os.path.join(BASE, *parts)


# tools and data that travel inside the app
if os.path.exists(res("exiftool", "exiftool")):
    os.environ.setdefault("EXIFTOOL", res("exiftool", "exiftool"))
if os.path.isdir(res("models")):
    os.environ.setdefault("PO_MODEL_DIR", res("models"))
if os.path.isdir(res("geo")):
    os.environ.setdefault("PO_GEO_DIR", res("geo"))
sys.path.insert(0, res("app"))   # when run from the source folder

import server  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def self_test():
    """Used by the build machine to make sure everything inside the app works."""
    import library
    et = library.ExifTool()
    out, _ = et.run(["-ver"])
    print("exiftool", out.strip())
    geo = library.Geo()
    print("place names bundled:", geo.ready(), geo.dir)
    import faces
    print("face model:", faces.model_ready(library.app_dir()), faces.model_dir(library.app_dir()))
    eng = faces.FaceEngine(library.app_dir())
    from PIL import Image
    print("faces in a blank picture:", len(eng.analyse(Image.new("RGB", (640, 480), (128, 128, 128)))))
    import pillow_heif  # noqa: F401
    print("self-test ok")


def main():
    if "--self-test" in sys.argv:
        self_test()
        return
    server.init()
    port = free_port()
    threading.Thread(target=server.run, args=(port,), daemon=True).start()
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    import webview
    webview.create_window("Picture Perfect", "http://127.0.0.1:%d/" % port,
                          width=1320, height=880, min_size=(960, 640))
    webview.start()
    os._exit(0)


if __name__ == "__main__":
    main()
