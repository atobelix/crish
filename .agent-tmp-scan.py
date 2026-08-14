# -*- coding: utf-8 -*-
"""临时探针：全仓三层扫描（与 03 方案 §附口径一致），不提交"""
import os, re, sys

SRC = "apps/crish-desktop/src"
FEAT = set("閳ユ柡鈧姘顒烽敍妞ょ數鐎鏂鍙鍘鍦鎻鎷鎸鍗鍐鍑鍔鈥鈧锛濠婃艾濮╅崠鐚寸窗鈹€")  # 不含 '?'
PUA = re.compile(r'[\uE000-\uF8FF]')
CJK = re.compile(r'[\u4e00-\u9fff]')


def cjk_count(s):
    return len(CJK.findall(s))


def scan(path):
    hits = []  # (lineno, layers, sample)
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    for i, line in enumerate(lines, 1):
        layers = []
        if PUA.search(line):
            layers.append('L1')
        if cjk_count(line) > 0:
            try:
                rec = line.encode('gbk').decode('utf-8', errors='strict')
                if cjk_count(rec) >= 2:
                    layers.append('L2:' + rec[:30])
            except Exception:
                pass
        fcount = sum(1 for ch in line if ch in FEAT)
        if fcount >= 2:
            layers.append('L3')
        elif fcount == 1 and '?' in line:
            layers.append('L3(1+?)')
        if layers:
            hits.append((i, layers, line[:50]))
    return hits


all_hits = {}
for root, dirs, files in os.walk(SRC):
    for fn in files:
        if not fn.endswith(('.css', '.ts', '.tsx')):
            continue
        if '.test.' in fn:
            continue
        p = os.path.join(root, fn)
        rel = os.path.relpath(p, SRC).replace(os.sep, '/')
        h = scan(p)
        if h:
            all_hits[rel] = h

nfiles = len(all_hits)
nlines = sum(len(v) for v in all_hits.values())
print(f"files: {nfiles}, lines: {nlines}")
for rel in sorted(all_hits):
    lines = [(l, layers) for l, layers, _ in all_hits[rel]]
    print(f"{len(lines):4d}  {rel}: {lines}")
