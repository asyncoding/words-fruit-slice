#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 i/j 无点的 EMNIST 笔画数据合成点（小孩书写规范：i/j 必须有点）。

EMNIST 成人笔迹的 i/j 常省略点或点连在主干上，骨架化后与 l 无法区分；
目标用户（学拼音儿童）会写点，因此以 80% 概率给无点样本补点，
20% 保持无点（兼容成人写法）。点位置：主干顶端上方 3~5px、横向 ±1.5px 抖动。
"""
import json
import os
import sys

import numpy as np

TARGETS = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'test', 'emnist-strokes.json'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'emnist-strokes-train.json'),
]


def has_dot(strokes):
    for st in strokes:
        xs = [p[0] for p in st]
        ys = [p[1] for p in st]
        if max(xs) - min(xs) <= 2 and max(ys) - min(ys) <= 2:
            return True
    return False


def add_dot(strokes, rng):
    pts = [p for st in strokes for p in st]
    ys = [p[1] for p in pts]
    y_top = min(ys)
    stem = [p for p in pts if p[1] - y_top < 4]
    x_stem = float(np.mean([p[0] for p in stem]))
    dot_x = x_stem + rng.uniform(-1.5, 1.5)
    dot_y = float(max(0, y_top - rng.uniform(3, 5)))
    strokes.append([(dot_x, dot_y)])
    return strokes


def main():
    for path in TARGETS:
        if not os.path.exists(path):
            print(f'[skip] {path}')
            continue
        with open(path) as f:
            data = json.load(f)
        rng = np.random.RandomState(7)
        n_ij = n_dot = 0
        for d in data:
            if d['letter'] not in ('i', 'j'):
                continue
            n_ij += 1
            if not has_dot(d['strokes']) and rng.rand() < 0.8:
                d['strokes'] = add_dot(d['strokes'], rng)
                n_dot += 1
        with open(path, 'w') as f:
            json.dump(data, f)
        print(f'[ok] {path}: i/j={n_ij} 补点={n_dot}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
