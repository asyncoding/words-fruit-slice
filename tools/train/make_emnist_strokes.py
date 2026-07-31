#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 EMNIST 生成真实手写笔画轨迹数据（供浏览器蒙层测试回放 + 训练 StrokeDataset）。

对每个 EMNIST 样本：skeletonize → 骨架像素 → 分支分解为多段折线 stroke（含 i/j 点兜底），
输出 JSON: [{"letter":"a","strokes":[[[x,y],...],...]}, ...]
坐标范围为 28x28 原始图，浏览器端/训练端按比例放大后以真实笔画渲染。

用法：
  python make_emnist_strokes.py            # test 集（24样本/字母 -> test/emnist-strokes.json）
  python make_emnist_strokes.py --train    # train 集（全量 124800 -> data/emnist-strokes-train.json）
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool

import numpy as np
from skimage.morphology import skeletonize
from torchvision import datasets

DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
OUT_JSON = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'test', 'emnist-strokes.json')
OUT_TRAIN_JSON = os.path.join(DATA_ROOT, 'emnist-strokes-train.json')
SAMPLES_PER_LETTER = 24


def skeleton_to_strokes(skel):
    """骨架二值图 → 多段折线（分支处断开）。"""
    ys, xs = np.nonzero(skel)
    n = len(xs)
    if n == 0:
        return []
    # 邻接表（8连通）
    adj = {}
    pts = set(range(n))
    for i in range(n):
        adj[i] = []
    for i in range(n):
        for j in range(i + 1, n):
            if abs(xs[i] - xs[j]) <= 1 and abs(ys[i] - ys[j]) <= 1:
                adj[i].append(j)
                adj[j].append(i)
    # 取分支点/端点为线段起点：度 != 2
    visited = set()
    strokes = []
    for i in range(n):
        if i in visited:
            continue
        if len(adj[i]) != 2:
            # BFS/DFS 沿路径走
            for nxt in adj[i]:
                path = [i, nxt]
                visited.add(i)
                prev = i
                cur = nxt
                while True:
                    visited.add(cur)
                    nxts = [k for k in adj[cur] if k != prev]
                    if len(nxts) != 1:
                        break
                    nxt = nxts[0]
                    if nxt in visited:
                        break
                    path.append(nxt)
                    prev, cur = cur, nxt
                if len(path) >= 3:
                    strokes.append(path)
    # 环（全度=2）兜底：从任一像素绕一圈
    for i in range(n):
        if i in visited:
            continue
        if not adj[i]:
            continue
        # 沿环走
        path = [i]
        visited.add(i)
        prev = i
        cur = adj[i][0]
        while cur != i and cur not in visited:
            path.append(cur)
            visited.add(cur)
            nxts = [k for k in adj[cur] if k != prev]
            if not nxts:
                break
            prev, cur = cur, nxts[0]
        if len(path) >= 3:
            strokes.append(path)
    # 孤立点/短分量兜底：i/j 的点、小杂点等（骨架 <3 像素）直接作为单笔画
    for i in range(n):
        if i in visited:
            continue
        comp = [i]
        visited.add(i)
        stack = [i]
        while stack:
            c = stack.pop()
            for k in adj[c]:
                if k not in visited:
                    visited.add(k)
                    comp.append(k)
                    stack.append(k)
        if len(comp) <= 2:
            strokes.append([(float(xs[k]), float(ys[k])) for k in comp])
    # 转坐标列表并粗略降采样（间隔取点，保持折线形状）
    out = []
    for path in strokes:
        line = [(float(xs[i]), float(ys[i])) for i in path] if isinstance(path[0], int) else path
        if len(line) <= 2:
            out.append(line)
            continue
        step = max(1, len(line) // 12)
        out.append(line[::step])
    return out


def skeletonize_one(idx_label_arr):
    idx, label, arr = idx_label_arr
    letter = chr(97 + int(label) - 1)
    skel = skeletonize(np.asarray(arr) > 128)
    strokes = skeleton_to_strokes(skel)
    if not strokes:
        return None
    return {"letter": letter, "strokes": strokes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', action='store_true', help='生成 train 集全量数据（多进程）')
    ap.add_argument('--workers', type=int, default=8)
    args = ap.parse_args()

    split = 'train' if args.train else 'test'
    ds = datasets.EMNIST(root=DATA_ROOT, split='letters', train=args.train, download=False)

    if args.train:
        print(f'[train] 全量 {len(ds)} 样本，{args.workers} 进程骨架化…（约几分钟）')
        tasks = [(i, ds[i][1], ds[i][0]) for i in range(len(ds))]
        with Pool(args.workers) as pool:
            rows = pool.map(skeletonize_one, tasks, chunksize=512)
        data = [r for r in rows if r is not None]
        with open(OUT_TRAIN_JSON, 'w') as f:
            json.dump(data, f)
        print(f'ok: {len(data)} samples -> {OUT_TRAIN_JSON}')
        return 0

    data = []
    per_letter = {}
    for i in range(len(ds)):
        img, label = ds[i]
        letter = chr(97 + int(label) - 1)
        if len(per_letter.get(letter, [])) >= SAMPLES_PER_LETTER:
            continue
        arr = np.asarray(img) > 128
        skel = skeletonize(arr)
        strokes = skeleton_to_strokes(skel)
        if len(strokes) < 1:
            continue
        per_letter.setdefault(letter, []).append(strokes)
        if sum(len(v) for v in per_letter.values()) >= 26 * SAMPLES_PER_LETTER:
            break
    for letter in map(chr, range(97, 123)):
        for strokes in per_letter.get(letter, []):
            data.append({"letter": letter, "strokes": strokes})
    with open(OUT_JSON, 'w') as f:
        json.dump(data, f)
    total = len(data)
    print(f'ok: {total} samples -> {OUT_JSON}')
    lens = [sum(len(s) for s in d["strokes"]) for d in data]
    print(f'avg points/stroke-trace: {np.mean(lens):.1f}, strokes/sample: {np.mean([len(d["strokes"]) for d in data]):.1f}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
