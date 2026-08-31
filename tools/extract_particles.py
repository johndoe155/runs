#!/usr/bin/env python3
"""
extract_particles.py — offline image -> particle pipeline for the Nemoverse hero.
"""

import argparse
import bisect
import json
import math
import os
import random
from array import array
from collections import deque

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF_DIR = os.path.join(ROOT, "references")
DATA_DIR = os.path.join(ROOT, "data")
PREV_DIR = os.path.join(ROOT, "previews")

XRANGE = (-0.36, 0.36)
YRANGE = (-0.03, 1.03)

SAT_BOOST = 1.25
GAMMA = 0.85
LIFT = 1.08
FLOOR = 0.04

IMAGES = [
    {
        "file": "Torn-Paper.jpg",
        "pose": 0,
        "flood_tol": 0.08,
        "flood_grow": 1.2,
        "center_bias": 0.25,
        "sat_weight": 0.65,
        "keep_frac": 0.10,
        "target_frac": 1.0,
        "exclude": [],
        "edges": ("top", "bottom", "left", "right")
    },
    {
        "file": "HQvGjJqXsAATKlK.jpg",
        "pose": 1,
        "flood_tol": 0.08,
        "flood_grow": 1.2,
        "center_bias": 0.20,
        "sat_weight": 0.55,
        "keep_frac": 0.10,
        "target_frac": 1.0,
        "exclude": [],
        "edges": ("top", "bottom", "left", "right")
    },
    {
        "file": "HO4w6qVXQAAdk9V.jpg",
        "pose": 2,
        "flood_tol": 0.08,
        "flood_grow": 1.2,
        "center_bias": 0.45,
        "sat_weight": 0.65,
        "keep_frac": 0.10,
        "target_frac": 1.0,
        "exclude": [],
        "edges": ("top",)
    },
    {
        "file": "HOPqL1PW0AA1MJy.jpg",
        "pose": 3,
        "flood_tol": 0.12,
        "flood_grow": 1.2,
        "center_bias": 0.30,
        "sat_weight": 0.70,
        "keep_frac": 0.0,
        "target_frac": 1.0,
        "exclude": [],
        "edges": ("top",)
    },
]

MAX_DIM = 512

def border_indices(w, h, t, edges=("top", "bottom", "left", "right")):
    y_list = []
    if "top" in edges:
        y_list.extend(range(t))
    if "bottom" in edges:
        y_list.extend(range(h - t, h))
        
    for y in y_list:
        base = y * w
        for x in range(w):
            yield base + x
            
    x_list = []
    if "left" in edges:
        x_list.extend(range(t))
    if "right" in edges:
        x_list.extend(range(w - t, w))
        
    if x_list:
        for y in range(t, h - t):
            base = y * w
            for x in x_list:
                yield base + x

def background_model(buf, w, h, edges=("top", "bottom", "left", "right")):
    t = max(2, int(min(w, h) * 0.06))
    sums = {}
    counts = {}
    for i in border_indices(w, h, t, edges):
        o = i * 3
        r, g, b = buf[o], buf[o + 1], buf[o + 2]
        key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
        c = counts.get(key, 0) + 1
        counts[key] = c
        s = sums.get(key)
        if s is None:
            sums[key] = [r, g, b]
        else:
            s[0] += r; s[1] += g; s[2] += b
    top = sorted(counts, key=counts.get, reverse=True)[:6]
    centers = []
    for key in top:
        c = counts[key]
        s = sums[key]
        centers.append((s[0] / c / 255.0, s[1] / c / 255.0, s[2] / c / 255.0))
    return centers

def build_dist_lut(centers):
    lut = array("f", bytes(4 * 32768))
    for key in range(32768):
        r = ((key >> 10) & 31) / 31.0
        g = ((key >> 5) & 31) / 31.0
        b = (key & 31) / 31.0
        best = 2.0
        for cr, cg, cb in centers:
            dd = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb)
            if dd < best:
                best = dd
        lut[key] = math.sqrt(best)
    return lut

def pixel_features(buf, n, lut):
    dist = array("f", bytes(4 * n))
    sat = array("f", bytes(4 * n))
    val = array("f", bytes(4 * n))
    hue = array("f", bytes(4 * n))
    for i in range(n):
        o = i * 3
        r = buf[o]; g = buf[o + 1]; b = buf[o + 2]
        dist[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]
        mx = r if r >= g else g
        if b > mx: mx = b
        mn = r if r <= g else g
        if b < mn: mn = b
        df = mx - mn
        val[i] = mx / 255.0
        if mx == 0 or df == 0:
            sat[i] = 0.0
            hue[i] = 0.0
            continue
        sat[i] = df / mx
        if mx == r:
            hh = ((g - b) / df) % 6.0
        elif mx == g:
            hh = (b - r) / df + 2.0
        else:
            hh = (r - g) / df + 4.0
        hue[i] = hh * 60.0
    return dist, sat, val, hue

def flood_background(w, h, dist, tol, grow=1.6, edges=("top", "bottom", "left", "right")):
    allowed = tol * grow
    seen = bytearray(w * h)
    q = deque()
    t = max(2, int(min(w, h) * 0.06))
    for i in border_indices(w, h, t, edges):
        if dist[i] < tol:
            seen[i] = 1
            q.append(i)
    while q:
        i = q.popleft()
        y, x = divmod(i, w)
        for nb in ((i - w) if y > 0 else -1,
                   (i + w) if y < h - 1 else -1,
                   (i - 1) if x > 0 else -1,
                   (i + 1) if x < w - 1 else -1):
            if nb >= 0 and not seen[nb] and dist[nb] < allowed:
                seen[nb] = 1
                q.append(nb)
    return seen

def compute_scores(w, h, flooded, dist, sat, val, hue, cfg):
    n = w * h
    score = array("f", bytes(4 * n))
    sw = cfg["sat_weight"]
    cb = cfg["center_bias"]
    rules = cfg["exclude"]
    inv_w = 1.0 / (w - 1)
    inv_h = 1.0 / (h - 1)
    for y in range(h):
        cy = (y * inv_h - 0.5) / 0.62
        base = y * w
        for x in range(w):
            i = base + x
            if flooded[i]:
                continue
            hh = hue[i]; ss = sat[i]; vv = val[i]
            if rules:
                kill = False
                for r in rules:
                    if r["h0"] <= hh <= r["h1"] and ss >= r["sat"] and vv >= r["val"]:
                        kill = True
                        break
                if kill:
                    continue
            s = dist[i] * (1.0 - sw + sw * ss)
            cx = (x * inv_w - 0.5) / 0.62
            rad = math.sqrt(cx * cx + cy * cy)
            if rad > 1.0: rad = 1.0
            score[i] = s * (1.0 - cb * rad)
    return score

def keep_components(mask, w, h, keep_frac):
    label = array("i", bytes(4 * w * h))
    nxt = 0
    sizes = []
    q = deque()
    n = w * h
    for start in range(n):
        if not mask[start] or label[start]:
            continue
        nxt += 1
        size = 0
        label[start] = nxt
        q.append(start)
        while q:
            i = q.popleft()
            size += 1
            y, x = divmod(i, w)
            for nb in ((i - w) if y > 0 else -1,
                       (i + w) if y < h - 1 else -1,
                       (i - 1) if x > 0 else -1,
                       (i + 1) if x < w - 1 else -1):
                if nb >= 0 and mask[nb] and not label[nb]:
                    label[nb] = nxt
                    q.append(nb)
        sizes.append(size)
    if not sizes:
        return mask, 0
    biggest = max(sizes)
    keep = {idx + 1 for idx, s in enumerate(sizes) if s >= keep_frac * biggest}
    out = bytearray(n)
    for i in range(n):
        if label[i] in keep:
            out[i] = 1
    return out, nxt

def foreground_mask(buf, w, h, cfg):
    edges = cfg.get("edges", ("top", "bottom", "left", "right"))
    centers = background_model(buf, w, h, edges)
    lut = build_dist_lut(centers)
    dist, sat, val, hue = pixel_features(buf, w * h, lut)
    flooded = flood_background(w, h, dist, cfg["flood_tol"], cfg.get("flood_grow", 1.5), edges)
    score = compute_scores(w, h, flooded, dist, sat, val, hue, cfg)
    
    mask = bytearray(1 if score[i] > 0 else 0 for i in range(w * h))
    
    tf = cfg.get("target_frac", 1.0)
    thr = 0.0
    if tf < 1.0:
        limit = int(w * h * tf)
        valid = [score[i] for i in range(w * h) if mask[i]]
        if len(valid) > limit:
            valid.sort(reverse=True)
            thr = valid[limit - 1]
            for i in range(w * h):
                if mask[i] and score[i] < thr:
                    mask[i] = 0
                    
    mask = denoise(mask, w, h)
    mask, n_comp = keep_components(mask, w, h, cfg.get("keep_frac", 0.05))
    return mask, score, flooded, thr, n_comp

def denoise(mask, w, h, min_neighbors=3):
    cnt = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            i = base + x
            if not mask[i]:
                continue
            if y > 0: cnt[i - w] += 1
            if y < h - 1: cnt[i + w] += 1
            if x > 0: cnt[i - 1] += 1
            if x < w - 1: cnt[i + 1] += 1
    return bytearray(1 if (mask[i] and cnt[i] >= min_neighbors) else 0 for i in range(w * h))

def sample_points(mask, score, buf, w, h, n, rng):
    idxs = []
    cum = []
    acc = 0.0
    for i in range(w * h):
        if mask[i]:
            acc += score[i]
            idxs.append(i)
            cum.append(acc)
    total = acc
    sx = array("f", bytes(4 * n))
    sy = array("f", bytes(4 * n))
    col = bytearray(3 * n)
    inv_w = 1.0 / (w - 1)
    inv_h = 1.0 / (h - 1)
    for k in range(n):
        i = idxs[bisect.bisect(cum, rng.random() * total)]
        y, x = divmod(i, w)
        sx[k] = (x + rng.uniform(-0.5, 0.5)) * inv_w
        sy[k] = (y + rng.uniform(-0.5, 0.5)) * inv_h
        o = i * 3
        col[k * 3] = buf[o]
        col[k * 3 + 1] = buf[o + 1]
        col[k * 3 + 2] = buf[o + 2]
    return idxs, sx, sy, col

def normalize(sx, sy, n):
    x0 = min(sx); x1 = max(sx)
    y0 = min(sy); y1 = max(sy)
    bw = max(x1 - x0, 1e-6)
    bh = max(y1 - y0, 1e-6)
    s = min((XRANGE[1] - XRANGE[0]) / bw, (YRANGE[1] - YRANGE[0]) / bh)
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    ox = (XRANGE[0] + XRANGE[1]) / 2
    oy = (YRANGE[0] + YRANGE[1]) / 2
    for k in range(n):
        sx[k] = ox + (sx[k] - cx) * s
        sy[k] = oy + (cy - sy[k]) * s

def grade_colors(col, n):
    out = bytearray(3 * n)
    for k in range(n):
        o = k * 3
        r = col[o] / 255.0; g = col[o + 1] / 255.0; b = col[o + 2] / 255.0
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        for j, c in enumerate((r, g, b)):
            c = lum + (c - lum) * SAT_BOOST
            c = c if c > 0 else 0.0
            c = c if c < 1 else 1.0
            c = c ** GAMMA * LIFT + FLOOR
            out[o + j] = min(255, int(c * 255.0))
    return out

def save_previews(name, buf, w, h, mask, flooded, sx, sy, col, n):
    over = bytearray(w * h * 3)
    for i in range(w * h):
        o = i * 3
        r = buf[o] * 0.35; g = buf[o + 1] * 0.35; b = buf[o + 2] * 0.35
        if mask[i]:
            r = r * 0.4 + 255 * 0.6 * 1.0
            g = g * 0.4 + 255 * 0.6 * 0.15
            b = b * 0.4 + 255 * 0.6 * 0.3
        elif flooded[i]:
            r = r * 0.5
            g = g * 0.5 + 255 * 0.5 * 0.5
            b = b * 0.5 + 255 * 0.5
        over[o] = min(255, int(r))
        over[o + 1] = min(255, int(g))
        over[o + 2] = min(255, int(b))
    Image.frombytes("RGB", (w, h), bytes(over)).save(
        os.path.join(PREV_DIR, f"{name}_mask.png"))

    pts = bytearray(w * h * 3)
    for k in range(n):
        x = min(w - 1, max(0, int(sx[k] * (w - 1))))
        y = min(h - 1, max(0, int(sy[k] * (h - 1))))
        o = (y * w + x) * 3
        pts[o] = col[k * 3]
        pts[o + 1] = col[k * 3 + 1]
        pts[o + 2] = col[k * 3 + 2]
    Image.frombytes("RGB", (w, h), bytes(pts)).save(
        os.path.join(PREV_DIR, f"{name}_samples.png"))

def process(cfg, n, rng):
    path = os.path.join(REF_DIR, cfg["file"])
    im = Image.open(path).convert("RGB")
    im.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)
    w, h = im.size
    buf = im.tobytes()

    mask, score, flooded, thr, n_comp = foreground_mask(buf, w, h, cfg)
    n_fg = sum(mask)
    _, sx, sy, col = sample_points(mask, score, buf, w, h, n, rng)
    
    graded = grade_colors(col, n)

    name = os.path.splitext(cfg["file"])[0]
    save_previews(name, buf, w, h, mask, flooded, sx, sy, graded, n)

    normalize(sx, sy, n)

    pos = []
    pos_append = pos.append
    for k in range(n):
        pos_append(round(sx[k], 5))
        pos_append(round(sy[k], 5))
    out = {
        "name": name,
        "n": n,
        "xrange": list(XRANGE),
        "yrange": list(YRANGE),
        "pos": pos,
        "rgb": list(graded),
    }
    out_path = os.path.join(DATA_DIR, f"pose{cfg['pose']}.json")
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kb = os.path.getsize(out_path) / 1024
    print(f"{cfg['file']:<22} {w}x{h}  fg={n_fg:>6}px ({100.0*n_fg/(w*h):.1f}%)"
          f"  thr={thr:.3f}  comps={n_comp}  -> pose{cfg['pose']}.json ({kb:.0f} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20000, help="particles per pose")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(PREV_DIR, exist_ok=True)
    rng = random.Random(9584)
    for cfg in IMAGES:
        process(cfg, args.n, rng)

if __name__ == "__main__":
    main()
