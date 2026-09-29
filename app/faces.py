"""Face finding and recognition, entirely on this computer.

Uses a small open face model (InsightFace "buffalo_sc": SCRFD face finder + MobileFaceNet
recogniser, about 15 MB) run with onnxruntime. Each face becomes a 512-number "faceprint";
two faceprints that point the same way belong to the same person.
"""
import os
import shutil
import urllib.request
import zipfile

import numpy as np
from PIL import Image

MODEL_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip"
DET_FILE, REC_FILE = "det_500m.onnx", "w600k_mbf.onnx"

# where the eyes, nose and mouth corners sit in a 112 x 112 face the recogniser expects
ARCFACE_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def model_dir(base):
    bundled = os.environ.get("PO_MODEL_DIR")   # the Mac app carries the model inside it
    if bundled and os.path.exists(os.path.join(bundled, DET_FILE)):
        return bundled
    return os.path.join(base, "models", "buffalo_sc")


def model_ready(base):
    d = model_dir(base)
    return os.path.exists(os.path.join(d, DET_FILE)) and os.path.exists(os.path.join(d, REC_FILE))


def download_model(base, job=None):
    d = model_dir(base)
    os.makedirs(d, exist_ok=True)
    if model_ready(base):
        return
    if job:
        job.message = "Downloading the face model (one time, about 15 MB)…"
    tmp = os.path.join(d, "model.zip.part")
    req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "PhotoOrganizer/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    with zipfile.ZipFile(tmp) as z:
        for name in z.namelist():
            base_name = os.path.basename(name)
            if base_name in (DET_FILE, REC_FILE):
                with z.open(name) as src, open(os.path.join(d, base_name), "wb") as dst:
                    shutil.copyfileobj(src, dst)
    os.remove(tmp)
    if not model_ready(base):
        raise RuntimeError("The face model download didn't contain what I expected.")


def _nms(dets, thresh=0.4):
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


def _similarity_transform(src, dst):
    """Best rotation + uniform scale + shift mapping src points onto dst (Umeyama)."""
    num = src.shape[0]
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_d, dst_d = src - src_mean, dst - dst_mean
    A = dst_d.T @ src_d / num
    d = np.ones((2,), dtype=np.float64)
    if np.linalg.det(A) < 0:
        d[1] = -1
    U, S, V = np.linalg.svd(A)
    R = U @ np.diag(d) @ V
    scale = 1.0 / src_d.var(axis=0).sum() * (S @ d)
    T = np.eye(3)
    T[:2, :2] = scale * R
    T[:2, 2] = dst_mean - scale * (R @ src_mean)
    return T


class FaceEngine:
    def __init__(self, base):
        import onnxruntime as ort
        d = model_dir(base)
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.det = ort.InferenceSession(os.path.join(d, DET_FILE), opts, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(os.path.join(d, REC_FILE), opts, providers=["CPUExecutionProvider"])
        self.det_in = self.det.get_inputs()[0].name
        self.det_out = [o.name for o in self.det.get_outputs()]
        self.rec_in = self.rec.get_inputs()[0].name

    # ---------- finding faces ----------
    def detect(self, img, thresh=0.55, size=640):
        """img: PIL RGB. Returns list of (box[x1,y1,x2,y2], landmarks 5x2, score) in image pixels."""
        w, h = img.size
        if h / float(w) > 1.0:
            nh, nw = size, max(1, int(size * w / float(h)))
        else:
            nw, nh = size, max(1, int(size * h / float(w)))
        scale = nh / float(h)
        canvas = np.zeros((size, size, 3), dtype=np.float32)
        canvas[:nh, :nw] = np.asarray(img.resize((nw, nh), Image.BILINEAR), dtype=np.float32)
        blob = ((canvas - 127.5) / 128.0).transpose(2, 0, 1)[None]
        outs = self.det.run(self.det_out, {self.det_in: blob})
        boxes, kpss, scores = [], [], []
        for k, stride in enumerate((8, 16, 32)):
            sc = outs[k].reshape(-1)
            bb = outs[k + 3].reshape(-1, 4) * stride
            kp = outs[k + 6].reshape(-1, 10) * stride
            fh, fw = size // stride, size // stride
            centers = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
            centers = (centers * stride).reshape(-1, 2)
            centers = np.repeat(centers, 2, axis=0)          # two anchors per cell
            pos = np.where(sc >= thresh)[0]
            if not len(pos):
                continue
            c = centers[pos]
            b = bb[pos]
            boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=-1))
            kk = kp[pos].reshape(-1, 5, 2) + c[:, None, :]
            kpss.append(kk)
            scores.append(sc[pos])
        if not boxes:
            return []
        boxes = np.vstack(boxes) / scale
        kpss = np.vstack(kpss) / scale
        scores = np.concatenate(scores)
        keep = _nms(np.hstack([boxes, scores[:, None]]))
        return [(boxes[i], kpss[i], float(scores[i])) for i in keep]

    # ---------- recognising ----------
    def aligned(self, img, kps):
        T = _similarity_transform(np.asarray(kps, dtype=np.float64), ARCFACE_DST.astype(np.float64))
        inv = np.linalg.inv(T)            # PIL maps output pixels back to input pixels
        coeffs = (inv[0, 0], inv[0, 1], inv[0, 2], inv[1, 0], inv[1, 1], inv[1, 2])
        return img.transform((112, 112), Image.AFFINE, coeffs, resample=Image.BILINEAR)

    def embed(self, faces):
        """faces: list of 112x112 PIL RGB. Returns unit-length 512-d faceprints."""
        if not faces:
            return np.zeros((0, 512), dtype=np.float32)
        arr = np.stack([np.asarray(f, dtype=np.float32) for f in faces])
        blob = ((arr - 127.5) / 127.5).transpose(0, 3, 1, 2)
        out = []
        for i in range(len(blob)):            # this model takes one face at a time
            out.append(self.rec.run(None, {self.rec_in: blob[i:i + 1]})[0][0])
        emb = np.array(out, dtype=np.float32)
        return emb / np.maximum(1e-6, np.linalg.norm(emb, axis=1, keepdims=True))

    def analyse(self, img, min_size=40):
        """All usable faces in a photo: box (0..1 of the image), score, faceprint, display crop."""
        img = img.convert("RGB")
        found = self.detect(img)
        if not found:
            # a face filling the whole frame (close-up, selfie): look again with a border around it
            w0, h0 = img.size
            pad = int(max(w0, h0) * 0.35)
            framed = Image.new("RGB", (w0 + 2 * pad, h0 + 2 * pad), (127, 127, 127))
            framed.paste(img, (pad, pad))
            found = [(b - np.array([pad, pad, pad, pad]), k - pad, sc) for b, k, sc in self.detect(framed)]
            found = [(np.clip(b, [0, 0, 0, 0], [w0, h0, w0, h0]), k, sc) for b, k, sc in found]
        w, h = img.size
        items, crops = [], []
        for box, kps, score in found:
            bw, bh = box[2] - box[0], box[3] - box[1]
            if min(bw, bh) < min_size:
                continue
            crops.append(self.aligned(img, kps))
            pad = 0.35
            cx1, cy1 = max(0, box[0] - bw * pad), max(0, box[1] - bh * pad)
            cx2, cy2 = min(w, box[2] + bw * pad), min(h, box[3] + bh * pad)
            thumb = img.crop((int(cx1), int(cy1), int(cx2), int(cy2)))
            thumb.thumbnail((160, 160))
            items.append({"box": [float(box[0] / w), float(box[1] / h), float(bw / w), float(bh / h)],
                          "score": score, "size": float(min(bw, bh)), "thumb": thumb})
        embs = self.embed(crops)
        for it, e in zip(items, embs):
            it["emb"] = e
        return items
