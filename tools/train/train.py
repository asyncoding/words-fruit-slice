#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EMNIST 26类字母CNN 重训管线（方向A3：孩子笔迹增强重训 + 方向A4：EMNIST标准预处理对齐）

- 数据：torchvision EMNIST split='letters'（train 124800 / test 20800，类 0-25 = a-z）
         + StrokeDataset（EMNIST 笔画化渲染：骨架折线→圆头笔画→画布降采样，镜像 app 真实绘制）
         + FontDataset（渲染字体合成样本）
- 增强（先EMNIST标准形 -> 再随机扰动）：
    旋转 ±25° / 缩放 0.75~1.25 / 平移 ±3px（带画布越界约束，避免裁掉字母笔画）
    随机擦除少量笔画像素；scipy.ndimage 3×3 dilate/erode 各 25%（粗细模拟）
- 架构：conv32-BN-MP-conv96-BN-MP-fc128-fc26（约63万参数，fp32 < 4MB）
- 训练：Adam lr 1e-3 cosine，batch 256，epoch 8；每 epoch 报 EMNIST test 准确率
- 导出：opset 13，input/output 命名 + Softmax 结尾；onnxruntime 数值一致性验证
- 验收：EMNIST test >= 97%；字体渲染 Arial >= 99% / Georgia >= 90% / 草书 >= 85%；
        笔画渲染 test 集（笔宽 4.3/18px）作为真实手写代理指标
"""
import json
import math
import os
import sys
import time

import numpy as np
from scipy import ndimage

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader, ConcatDataset
from torchvision import datasets, transforms
from torchvision.transforms.functional import InterpolationMode
import torchvision.transforms.functional as Fx

SEED = 42
DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
OUT_ONNX = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'emnist_cnn.onnx')
OLD_ONNX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'emnist_cnn_old.onnx')
FONT_DIR = '/System/Library/Fonts/Supplemental'

EPOCHS = 8
FINE_EPOCHS = 3          # 微调阶段：低强度增强，挽回规整样本准确率
BATCH = 256
LR = 1e-3
LR_MIN = 1e-5
NUM_WORKERS = 4

SE3 = np.ones((3, 3), dtype=bool)


def worker_init(worker_id):
    np.random.seed(SEED + worker_id * 7919)
    torch.manual_seed(SEED + worker_id * 7919)


# ---------------------------------------------------------------------------
# 训练预处理：EMNIST 样本已是标准形（质心对齐 (14,14)、内容 ~20×20），
# 在此基础上随机扰动（对应 AGENT.md 方向A3：孩子笔迹旋转/粗细/抖动）。
# ---------------------------------------------------------------------------

def _fwd_affine(angle, tx, ty, scale, center):
    """正向 2x3 仿射（输入像素 -> 输出像素），镜像 F.affine 实际映射：
    out = scale * R(angle) @ (in - center) + center + translate（数值探测验证）。"""
    cx, cy = center
    rot = math.radians(angle)
    A = scale * np.array([[math.cos(rot), -math.sin(rot)],
                          [math.sin(rot), math.cos(rot)]])
    t = np.array([tx, ty]) + np.array([cx, cy]) - A @ np.array([cx, cy])
    return A, t


def _affine_fits(ink_bbox, angle, tx, ty, scale, center):
    """变换后字母包围盒是否仍完整落在 28×28 画布内（+1px 双线性余量）。"""
    x0, y0, x1, y1 = ink_bbox
    corners = np.array([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], dtype=float)
    A, t = _fwd_affine(angle, tx, ty, scale, center)
    out = corners @ A.T + t
    return bool((out >= 1).all() and (out <= 27).all())


def _sample_geom(ink_bbox, center, angle_rng=25, scale_rng=(0.75, 1.25), tx_rng=3):
    """采样满足画布约束的 旋转/缩放/平移。"""
    for _ in range(15):
        angle = np.random.uniform(-angle_rng, angle_rng)
        scale = np.random.uniform(*scale_rng)
        tx, ty = np.random.uniform(-tx_rng, tx_rng, 2)
        if _affine_fits(ink_bbox, angle, tx, ty, scale, center):
            return angle, scale, tx, ty
    angle = np.random.uniform(-0.4 * angle_rng, 0.4 * angle_rng)
    scale = np.random.uniform(*scale_rng)
    tx, ty = np.random.uniform(-0.5 * tx_rng, 0.5 * tx_rng, 2)
    return angle, scale, tx, ty


class KidAugment:
    """孩子笔迹风格增强（作用于标准形 28×28 float32 0/1 图）。
    intensity='full' 强增强；intensity='light' 微调阶段弱增强。"""

    def __init__(self, center=(13.5, 13.5), intensity='full'):
        self.center = center
        self.intensity = intensity
        self.p_aug = 0.85 if intensity == 'full' else 0.35
        self.angle_rng = 25 if intensity == 'full' else 10
        self.scale_rng = (0.75, 1.25) if intensity == 'full' else (0.88, 1.12)
        self.tx_rng = 3 if intensity == 'full' else 1.5
        self.p_erase = 0.35 if intensity == 'full' else 0.0

    def __call__(self, img):
        if np.random.rand() >= self.p_aug:
            return img
        # 1) 粗细模拟：dilate/erode 3×3 各 25%（仅强增强阶段）
        if self.intensity == 'full':
            r = np.random.rand()
            if r < 0.25:
                img = ndimage.binary_dilation(img > 0.5, structure=SE3).astype(np.float32)
            elif r < 0.5:
                img = ndimage.binary_erosion(img > 0.5, structure=SE3).astype(np.float32)
        # 2) 随机擦除少量笔画像素
        if np.random.rand() < self.p_erase:
            ys, xs = np.nonzero(img > 0.5)
            if ys.size > 0:
                x0b, x1b, y0b, y1b = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
                for _ in range(int(np.random.randint(1, 3))):
                    w = int(np.random.randint(2, 7))
                    h = int(np.random.randint(2, 7))
                    if x1b - x0b + 1 > w and y1b - y0b + 1 > h:
                        px = int(np.random.randint(x0b, x1b - w + 2))
                        py = int(np.random.randint(y0b, y1b - h + 2))
                        img[py:py + h, px:px + w] = 0
        # 3) 几何扰动：旋转±25° 缩放0.75~1.25 平移±3px（画布约束内）
        ys, xs = np.nonzero(img > 0.5)
        if ys.size == 0:
            return img
        ink_bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        angle, scale, tx, ty = _sample_geom(ink_bbox, self.center, self.angle_rng, self.scale_rng, self.tx_rng)
        t = torch.from_numpy(img)[None, None]
        t = Fx.affine(t, angle, [tx, ty], scale, 0, InterpolationMode.BILINEAR, 0.0)
        return t[0, 0].numpy()


def selftest_affine():
    """启动自检：确认 _fwd_affine 与 F.affine 实际像素映射一致（center 约定）。"""
    probe = np.zeros((28, 28), dtype=np.float32)
    probe[7, 20] = 1.0
    angle, tx, ty, scale = 15.0, 1.0, -2.0, 1.2
    out = Fx.affine(torch.from_numpy(probe)[None, None], angle, [tx, ty], scale, 0, InterpolationMode.BILINEAR, 0.0)[0, 0].numpy()
    ys, xs = np.nonzero(out > 0.05)
    emp = np.array([xs.mean(), ys.mean()]) if len(xs) else None
    for center in [(13.5, 13.5), (14.0, 14.0)]:
        A, t = _fwd_affine(angle, tx, ty, scale, center)
        pred = A @ np.array([20.0, 7.0]) + t
        err = np.linalg.norm(pred - emp) if emp is not None else 99
        print(f'  center={center} err={err:.3f}')
        if err < 0.5:
            return center
    raise RuntimeError('affine center convention mismatch: ' + str(emp))


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------

class LetterCNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 32, 3, padding=1)
        self.bn1 = nn.BatchNorm2d(32)
        self.conv2 = nn.Conv2d(32, 96, 3, padding=1)
        self.bn2 = nn.BatchNorm2d(96)
        self.fc1 = nn.Linear(7 * 7 * 96, 128)
        self.fc2 = nn.Linear(128, 26)

    def forward(self, x):
        x = F.relu(self.bn1(self.conv1(x)))
        x = F.max_pool2d(x, 2)
        x = F.relu(self.bn2(self.conv2(x)))
        x = F.max_pool2d(x, 2)
        x = x.view(x.size(0), -1)
        x = F.relu(self.fc1(x))
        x = F.dropout(x, 0.2, training=self.training)
        return self.fc2(x)


def fold_bn(conv, bn):
    """推理期 BatchNorm 折叠进卷积权重（torch 2.13 legacy 导出器 BN 折叠有 bug）。"""
    scale = bn.weight.detach() / torch.sqrt(bn.running_var.detach() + bn.eps)
    w = conv.weight.detach() * scale.view(-1, 1, 1, 1)
    b = (conv.bias.detach() - bn.running_mean.detach()) * scale + bn.bias.detach()
    return w, b


def make_export_net(model):
    """构建无 BN 等价网络（BN 已折叠进卷积），用于 ONNX 导出。"""
    m = model
    w1, b1 = fold_bn(m.conv1, m.bn1)
    w2, b2 = fold_bn(m.conv2, m.bn2)
    net = nn.Sequential()
    net.conv1 = nn.Conv2d(1, 32, 3, padding=1)
    net.conv1.weight = torch.nn.Parameter(w1)
    net.conv1.bias = torch.nn.Parameter(b1)
    net.conv2 = nn.Conv2d(32, 96, 3, padding=1)
    net.conv2.weight = torch.nn.Parameter(w2)
    net.conv2.bias = torch.nn.Parameter(b2)
    net.fc1 = m.fc1
    net.fc2 = m.fc2
    net.softmax = nn.Softmax(dim=1)

    def forward(x):
        x = F.relu(net.conv1(x))
        x = F.max_pool2d(x, 2)
        x = F.relu(net.conv2(x))
        x = F.max_pool2d(x, 2)
        x = x.view(x.size(0), -1)
        x = F.relu(net.fc1(x))
        return net.softmax(net.fc2(x))

    net.forward = forward
    return net


class EMNISTDataset(Dataset):
    def __init__(self, split, augment=True):
        self.ds = datasets.EMNIST(root=DATA_ROOT, split='letters', train=(split == 'train'), download=True)
        self.augment = KidAugment() if augment else None

    def __len__(self):
        return len(self.ds)

    def __getitem__(self, i):
        img, label = self.ds[i]
        arr = np.asarray(img, dtype=np.float32) / 255.0
        if self.augment:
            arr = self.augment(arr)
        return arr[None], int(label) - 1


class FontDataset(Dataset):
    """渲染字体合成样本（旧模型擅长的分布：Arial/Georgia/Chalkboard/BradleyHand），
    多字号/多位置抖动，走同一 EMNIST 风格预处理。"""

    FONT_PATHS = {
        'Arial': os.path.join(FONT_DIR, 'Arial.ttf'),
        'Georgia': os.path.join(FONT_DIR, 'Georgia.ttf'),
        'Chalkboard': os.path.join(FONT_DIR, 'Chalkboard.ttc'),
        'BradleyHand': os.path.join(FONT_DIR, 'Bradley Hand Bold.ttf'),
    }

    def __init__(self, augment=True, variants=16):
        self.augment = KidAugment() if augment else None
        samples = []
        sizes = [90, 110, 130]
        for ch in map(chr, range(97, 123)):
            for fname, fpath in self.FONT_PATHS.items():
                if not os.path.exists(fpath):
                    continue
                for v in range(variants):
                    size = sizes[v % 3]
                    jx = (v % 5) * 6 - 12
                    jy = ((v // 5) % 3) * 8 - 8
                    img = render_glyph(fpath, ch, size=size, jx=jx, jy=jy)
                    x = preprocess_emnist(img)
                    if x is not None:
                        samples.append((x, ord(ch) - 97))
        self.samples = samples
        self.repeat = 24  # 字体样本重复次数，EMNIST:字体 ≈ 3:1

    def __len__(self):
        return len(self.samples) * self.repeat

    def __getitem__(self, i):
        x, y = self.samples[i % len(self.samples)]
        if self.augment:
            x = self.augment(x)
        return x[None].copy(), y


def render_strokes(strokes, canvas=360, pen=18, glyph_h=150, angle=0, jx=0, jy=0):
    """骨架折线 -> 圆头圆角笔画渲染（PIL，镜像 app canvas stroke 语义：白色圆头笔画画在透明底上）。
    返回 HxWx4 RGBA uint8。"""
    pts = [p for s in strokes for p in s]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    min_x, min_y, max_x, max_y = min(xs), min(ys), max(xs), max(ys)
    bw, bh = max_x - min_x + 1, max_y - min_y + 1
    scale = glyph_h / max(bw, bh)
    cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
    rot = math.radians(angle)
    R = np.array([[math.cos(rot), -math.sin(rot)], [math.sin(rot), math.cos(rot)]])
    c2 = canvas / 2

    def xf(p):
        v = (np.array(p, dtype=float) - np.array([cx, cy])) * scale
        v = R @ v
        return tuple(v + np.array([c2 + jx, c2 + jy]))

    img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = pen / 2
    for s in strokes:
        line = [xf(p) for p in s]
        if len(line) == 1:
            px, py = line[0]
            d.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, 255))
        elif len(line) >= 2:
            d.line(line, fill=(255, 255, 255, 255), width=int(round(pen)), joint='curve')
            for p in (line[0], line[-1]):
                d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))
    return np.asarray(img)


def _deform_bend(line, k):
    """弯曲量缩放：中间点对首尾弦线的垂距 ×k（k<1 写直，k>1 写弯）。"""
    if len(line) < 3:
        return line
    a = np.array(line[0])
    b = np.array(line[-1])
    seg = b - a
    l2 = float(seg @ seg)
    if l2 < 1e-6:
        return line
    n = np.array([-seg[1], seg[0]]) / np.sqrt(l2)
    out = []
    for p in line:
        v = np.array(p, dtype=float)
        t = float((v - a) @ seg) / l2
        proj = a + t * seg
        d = float((v - proj) @ n)
        out.append(tuple(proj + n * d * k))
    return out


def _deform_gap(strokes, h, rng):
    """闭合空隙调整：最近跨笔画端点对 → 40% 完全闭合 / 30% 拉开成开口(0.10~0.25h) / 30% 保持。"""
    ends = []
    for si, s in enumerate(strokes):
        ends.append((si, 0, np.array(s[0], dtype=float)))
        ends.append((si, -1, np.array(s[-1], dtype=float)))
    best = None
    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            if ends[i][0] == ends[j][0]:
                continue
            d = float(np.linalg.norm(ends[i][2] - ends[j][2]))
            if d < 0.28 * h and (best is None or d < best[0]):
                best = (d, i, j)
    if not best:
        return strokes
    _, i, j = best
    pi, pj = ends[i], ends[j]
    v = pj[2] - pi[2]
    l = float(np.linalg.norm(v))
    u = v / (l + 1e-9)
    r = rng.rand()
    if r < 0.4:
        mid = tuple((pi[2] + pj[2]) / 2)
        strokes[pi[0]][pi[1]] = mid
        strokes[pj[0]][pj[1]] = mid
    elif r < 0.7:
        g = rng.uniform(0.10, 0.25) * h
        strokes[pi[0]][pi[1]] = tuple(pi[2] - u * g / 2)
        strokes[pj[0]][pj[1]] = tuple(pj[2] + u * g / 2)
    return strokes


def _deform_corner(line, rng):
    """顶点尖圆角：沿角平分线移动 ±50% 邻段长（正=更尖，负=更圆钝）。"""
    if len(line) < 3:
        return line
    out = [line[0]]
    for i in range(1, len(line) - 1):
        p0 = np.array(line[i - 1], dtype=float)
        p1 = np.array(line[i], dtype=float)
        p2 = np.array(line[i + 1], dtype=float)
        v1 = p1 - p0
        v2 = p2 - p1
        l1, l2 = float(np.linalg.norm(v1)), float(np.linalg.norm(v2))
        if l1 < 1e-6 or l2 < 1e-6:
            out.append(line[i])
            continue
        bis = v1 / l1 + v2 / l2
        nb = float(np.linalg.norm(bis))
        if nb < 1e-6:
            out.append(line[i])
            continue
        bis = bis / nb
        shift = rng.uniform(-0.5, 0.5) * min(l1, l2)
        out.append(tuple(p1 + bis * shift))
    out.append(line[-1])
    return out


def deform_strokes(strokes, rng):
    """孩子书写误差模拟（折线级形状变形，镜像真实儿童的书写偏差）：
    - bend:   弯曲量缩放 0.6~1.5（弯的写直 / 直的写弯）         ~45%
    - gap:    圈开口/闭合调整（闭合圈留空隙 / 开口圈闭合）     ~35%
    - corner: 顶点尖圆角 ±（弧度不够圆 / 过度锋利）            ~40%
    - join:   近笔画连笔合并（按手写习惯一笔连写）             ~30%
    """
    strokes = [list(s) for s in strokes]
    pts = [p for s in strokes for p in s]
    if not pts:
        return strokes
    h = max(p[1] for p in pts) - min(p[1] for p in pts)
    h = max(h, 6.0)
    # 1) join 连笔（先做，合并后 gap/bend/corner 在合并笔画上更合理）
    if len(strokes) >= 2 and rng.rand() < 0.30:
        ends = []
        for si, s in enumerate(strokes):
            ends.append((si, np.array(s[0], dtype=float), 0))
            ends.append((si, np.array(s[-1], dtype=float), -1))
        best = None
        for i in range(len(ends)):
            for j in range(i + 1, len(ends)):
                if ends[i][0] == ends[j][0]:
                    continue
                d = float(np.linalg.norm(ends[i][1] - ends[j][1]))
                if d < 0.25 * h and (best is None or d < best[0]):
                    best = (d, i, j)
        if best:
            _, i, j = best
            si, sj = ends[i][0], ends[j][0]
            a, b = ends[i][1], ends[j][1]
            mid = tuple((a + b) / 2)
            if ends[i][2] == -1 and ends[j][2] == 0:
                merged = strokes[si] + [mid] + strokes[sj]
            elif ends[i][2] == 0 and ends[j][2] == -1:
                merged = strokes[sj] + [mid] + strokes[si]
            else:
                merged = strokes[si] + [mid] + strokes[sj][::-1]
            strokes = [merged] + [s for k, s in enumerate(strokes) if k not in (si, sj)]
    # 2) bend 弯曲量
    out = []
    for s in strokes:
        if len(s) >= 3 and rng.rand() < 0.45:
            s = _deform_bend(s, rng.uniform(0.6, 1.5))
        if len(s) >= 3 and rng.rand() < 0.40:
            s = _deform_corner(s, rng)
        out.append(s)
    strokes = out
    # 3) gap 闭合空隙
    if rng.rand() < 0.35:
        strokes = _deform_gap(strokes, h, rng)
    return strokes


class StrokeDataset(Dataset):
    """EMNIST 笔画化渲染数据集（镜像 app 真实绘制管线，方向A3 关键新增）：
    骨架折线 -> 画布渲染（笔宽/字号/旋转/位置随机）-> preprocess_emnist。
    目的：让模型学到 app 里真实笔画的分布（细笔画、圆头圆角、降采样淡墨），
    修复『EMNIST 位图 92% 但笔画渲染只有 ~78%』的 sim-to-real 缺口。"""

    STROKE_JSON = os.path.join(DATA_ROOT, 'emnist-strokes-train.json')

    def __init__(self, pen_rng=(6, 24), glyph_rng=(120, 260), canvas=360):
        with open(self.STROKE_JSON) as f:
            items = json.load(f)
        # 碗状/相似形弱字母过采样 ×2（笔画渲染下 g/p/b/q/i/o/d 最易混）
        weak = [it for it in items if it['letter'] in 'gpbqiod']
        self.items = items + weak
        self.pen_rng = pen_rng
        self.glyph_rng = glyph_rng
        self.canvas = canvas
        self.rng = np.random.RandomState(SEED + 7)
        print(f'[strokes] {len(self.items)} samples (含弱字母过采样 {len(weak)} 条) from {self.STROKE_JSON}')

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        it = self.items[i]
        y = ord(it['letter']) - 97
        strokes = deform_strokes(it['strokes'], self.rng)
        img = render_strokes(strokes, canvas=self.canvas,
                             pen=np.random.uniform(*self.pen_rng),
                             glyph_h=np.random.uniform(*self.glyph_rng),
                             angle=np.random.uniform(-18, 18),
                             jx=np.random.uniform(-24, 24), jy=np.random.uniform(-24, 24))
        x = preprocess_emnist(img)
        return x[None], y


# ---------------------------------------------------------------------------
# 推理预处理（与 index.html recognizeLetterCNN / test/recognition-test.js 镜像）
# 新（方向A4）：bbox -> 等比缩放至 20×20 -> 28×28 居中 -> 笔画质心对齐 (14,14)
# 旧（对照）：bbox -> 15% 内边距 -> 方形居中缩放到 28×28
# ---------------------------------------------------------------------------

def preprocess_emnist(img_rgba):
    """EMNIST 风格预处理（镜像 JS 新逻辑）。img_rgba: HxWx4 uint8。"""
    a = img_rgba[..., 3]
    ys, xs = np.nonzero(a > 20)
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    scale = 20 / max(bw, bh)
    dw, dh = max(1, round(bw * scale)), max(1, round(bh * scale))
    crop = Image.fromarray(img_rgba[y0:y1 + 1, x0:x1 + 1]).resize((dw, dh), Image.BILINEAR)
    tmp = Image.new('RGBA', (28, 28), (0, 0, 0, 0))
    tmp.paste(crop, (int(math.floor((28 - dw) / 2)), int(math.floor((28 - dh) / 2))))
    arr = np.asarray(tmp, dtype=np.float32)
    # 质心对齐：alpha>20 二值质心 -> (14,14)，整数位移 + 画布内钳制
    mask = arr[..., 3] > 20
    if not mask.any():
        return None
    ys2, xs2 = np.nonzero(mask)
    cx, cy = xs2.mean(), ys2.mean()
    m_x0, m_y0, m_x1, m_y1 = xs2.min(), ys2.min(), xs2.max(), ys2.max()
    dx = int(round(14 - cx))
    dy = int(round(14 - cy))
    dx = max(int(-m_x0), min(dx, int(27 - m_x1)))
    dy = max(int(-m_y0), min(dy, int(27 - m_y1)))
    out = np.zeros((28, 28), dtype=np.float32)
    # 镜像 canvas source-over 合成：ink 以 alpha 叠加到黑底，灰度 = 预乘亮度
    lum = _premult_luminance(arr)
    sy0, sy1 = max(0, dy), min(28, 28 + dy)
    sx0, sx1 = max(0, dx), min(28, 28 + dx)
    if sy1 > sy0 and sx1 > sx0:
        out[sy0:sy1, sx0:sx1] = lum[sy0 - dy:sy1 - dy, sx0 - dx:sx1 - dx]
    return out / 255.0


def preprocess_old(img_rgba):
    """旧预处理（镜像 JS 旧逻辑：bbox+15%内边距+方形居中）。"""
    a = img_rgba[..., 3]
    ys, xs = np.nonzero(a > 20)
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    pad = max(6, round(max(bw, bh) * 0.15))
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(219, x1 + pad); y1 = min(219, y1 + pad)
    crop_w, crop_h = x1 - x0 + 1, y1 - y0 + 1
    size = max(crop_w, crop_h)
    off_x = int(math.floor((size - crop_w) / 2))
    off_y = int(math.floor((size - crop_h) / 2))
    tmp = Image.new('RGBA', (28, 28), (0, 0, 0, 0))
    crop = Image.fromarray(img_rgba[y0:y1 + 1, x0:x1 + 1]).resize(
        (max(1, round(crop_w * 28 / size)), max(1, round(crop_h * 28 / size))), Image.BILINEAR)
    tmp.paste(crop, (round(off_x * 28 / size), round(off_y * 28 / size)))
    arr = np.asarray(tmp, dtype=np.float32)
    return _premult_luminance(arr) / 255.0


def _premult_luminance(rgba):
    """canvas source-over 合成到黑底后的亮度：color*(alpha/255)。"""
    a = rgba[..., 3] / 255.0
    rgb = rgba[..., :3] * a[..., None]
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


# ---------------------------------------------------------------------------
# 字体验收（PIL 渲染，镜像 test/recognition-test.js drawGlyph：220×220，110px，中心锚点）
# ---------------------------------------------------------------------------

from PIL import Image, ImageDraw, ImageFont

FONTS = {
    'Arial': os.path.join(FONT_DIR, 'Arial.ttf'),
    'Georgia': os.path.join(FONT_DIR, 'Georgia.ttf'),
    'Chalkboard': os.path.join(FONT_DIR, 'Chalkboard.ttc'),
    'BradleyHand': os.path.join(FONT_DIR, 'Bradley Hand Bold.ttf'),
}


def render_glyph(font_path, ch, size=110, canvas=220, jx=0, jy=0):
    img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((canvas / 2 + jx, canvas / 2 + jy), ch, font=ImageFont.truetype(font_path, size), fill=(255, 255, 255, 255), anchor='mm')
    return np.asarray(img)


def predict_batch(session, xs):
    """xs: list[np 28x28 或 1x28x28 float32] -> 每样本 top-1 字母。"""
    norm = [np.asarray(a, dtype=np.float32) for a in xs]
    norm = [a[None] if a.ndim == 2 else a for a in norm]
    x = np.stack(norm)
    p = session.run(['output'], {'input': x})[0]
    return [chr(97 + int(np.argmax(r))) for r in p]


def eval_fonts(session, preproc, jitter=False):
    res = {}
    for name, path in FONTS.items():
        if not os.path.exists(path):
            print(f'  [skip] {name}: {path} 不存在')
            continue
        all_x, all_ch = [], []
        for ch in map(chr, range(97, 123)):
            variants = [(0, 0), (-3, 3), (3, -3)] if jitter else [(0, 0)]
            for jx, jy in variants:
                img = render_glyph(path, ch, jx=jx, jy=jy)
                x = preproc(img)
                if x is None:
                    continue
                all_x.append(x)
                all_ch.append(ch)
        outs = predict_batch(session, all_x)
        ok = sum(1 for o, ch in zip(outs, all_ch) if o == ch)
        res[name] = (ok, len(all_x))
    return res


def eval_strokes(session, strokes_json, pen, glyph_h=150, canvas=360, samples_per_letter=None):
    """笔画渲染验收（镜像浏览器蒙层测试台：固定渲染参数，确定性）。
    pen 4.3 = 当前 app 细笔（max(4, 360*0.012)）；pen 18 = 修复后 app 粗笔（0.05*360）。"""
    with open(strokes_json) as f:
        data = json.load(f)
    per_letter = {}
    for it in data:
        per_letter.setdefault(it['letter'], []).append(it)
    all_x, all_y = [], []
    for letter in map(chr, range(97, 123)):
        items = per_letter.get(letter, [])
        if samples_per_letter:
            items = items[:samples_per_letter]
        for it in items:
            img = render_strokes(it['strokes'], canvas=canvas, pen=pen, glyph_h=glyph_h)
            x = preprocess_emnist(img)
            if x is None:
                continue
            all_x.append(x)
            all_y.append(letter)
    outs = predict_batch(session, all_x)
    ok = sum(1 for o, y in zip(outs, all_y) if o == y)
    per_ok = {}
    for o, y in zip(outs, all_y):
        per_ok.setdefault(y, [0, 0])
        per_ok[y][1] += 1
        if o == y:
            per_ok[y][0] += 1
    return ok, len(all_x), {k: (v[0], v[1]) for k, v in per_ok.items()}


# ---------------------------------------------------------------------------
# 训练 + 评估
# ---------------------------------------------------------------------------

@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    correct = total = 0
    for xb, yb in loader:
        xb, yb = xb.to(device), yb.to(device)
        pred = model(xb).argmax(1)
        correct += (pred == yb).sum().item()
        total += yb.size(0)
    return correct / total


def main():
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    center = selftest_affine()
    print(f'[selftest] affine center convention = {center}')

    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    print(f'[device] {device}')

    emnist_tr = EMNISTDataset('train', augment=True)
    font_tr = FontDataset(augment=True)
    stroke_tr = StrokeDataset()
    train_ds = ConcatDataset([emnist_tr, stroke_tr, font_tr])
    test_ds = EMNISTDataset('test', augment=False)
    train_loader = DataLoader(train_ds, batch_size=BATCH, shuffle=True, num_workers=NUM_WORKERS,
                              persistent_workers=True, worker_init_fn=worker_init, drop_last=False)
    test_loader = DataLoader(test_ds, batch_size=512, shuffle=False, num_workers=2,
                             persistent_workers=True, worker_init_fn=worker_init)
    print(f'[data] train={len(train_ds)} (EMNIST 124800 + 笔画渲染 {len(stroke_tr)} + 字体合成) test={len(test_ds)}')

    model = LetterCNN().to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f'[model] params={n_params:,}  fp32={n_params * 4 / 1e6:.2f}MB')
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS, eta_min=LR_MIN)
    crit = nn.CrossEntropyLoss()

    best_acc = 0.0
    for ep in range(1, EPOCHS + FINE_EPOCHS + 1):
        if ep == EPOCHS + 1:
            emnist_tr.augment = KidAugment(intensity='light')
            font_tr.augment = KidAugment(intensity='light')
            opt = torch.optim.Adam(model.parameters(), lr=2e-4)
            sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=FINE_EPOCHS, eta_min=1e-6)
            print(f'--- 微调阶段：低强度增强 {FINE_EPOCHS} epochs ---')
        model.train()
        t0 = time.time()
        tot, cum = 0, 0.0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            loss = crit(model(xb), yb)
            loss.backward()
            opt.step()
            cum += loss.item() * len(xb)
            tot += len(xb)
        sched.step()
        acc = evaluate(model, test_loader, device)
        best_acc = max(best_acc, acc)
        print(f'[epoch {ep}] loss={cum / tot:.4f} test_acc={acc * 100:.2f}% '
              f'lr={sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s')
    print(f'[best] test_acc={best_acc * 100:.2f}%')

    # ---------- 导出 ONNX（opset 13，Softmax 结尾，input/output 命名） ----------
    model.eval()
    model.to('cpu')
    export_net = make_export_net(model)  # BN 已折叠，规避导出器 BN 折叠 bug
    dummy = torch.zeros(1, 1, 28, 28)
    torch.onnx.export(export_net, dummy, OUT_ONNX, opset_version=13,
                      input_names=['input'], output_names=['output'],
                      dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
                      do_constant_folding=True, dynamo=False)
    size_mb = os.path.getsize(OUT_ONNX) / 1e6
    print(f'[onnx] saved {OUT_ONNX} ({size_mb:.2f}MB)')

    import onnxruntime as ort
    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(OUT_ONNX, so)
    assert sess.get_inputs()[0].name == 'input' and list(sess.get_inputs()[0].shape[1:]) == [1, 28, 28]
    assert sess.get_outputs()[0].name == 'output' and list(sess.get_outputs()[0].shape[1:]) == [26]

    # torch vs onnxruntime 数值一致性
    xs = torch.randn(8, 1, 28, 28)
    with torch.no_grad():
        torch_out = export_net(xs)
    ort_out = sess.run(['output'], {'input': xs.numpy()})[0]
    md = np.abs(torch_out.numpy() - ort_out).max()
    print(f'[verify] torch vs onnxruntime max diff = {md:.2e}')
    assert md < 1e-4, 'onnx export mismatch'

    # ---------- 验收：EMNIST test + 字体集 ----------
    model.to(device)
    acc = evaluate(model, test_loader, device)
    print(f'\n===== 新模型 emnist_cnn.onnx =====')
    print(f'EMNIST test 准确率: {acc * 100:.2f}%  (目标 >= 97%)')

    old_sess = None
    if os.path.exists(OLD_ONNX):
        old_sess = ort.InferenceSession(OLD_ONNX, so)
        model.eval()
        # 旧模型走 onnxruntime 直接跑 test 集（同口径）
        n_ok = n_tot = 0
        for xb, yb in test_loader:
            outs = predict_batch(old_sess, [xb[i].cpu().numpy() for i in range(len(xb))])
            n_ok += sum(1 for i, o in enumerate(outs) if o == chr(97 + int(yb[i])))
            n_tot += len(xb)
        print(f'旧模型 EMNIST test 准确率: {n_ok / n_tot * 100:.2f}%')

    for jit in (False, True):
        label = '抖动3变体' if jit else '居中1变体'
        print(f'\n-- 字体验收（{label}，新预处理 EMNIST质心对齐）--')
        for name, (ok, total) in eval_fonts(sess, preprocess_emnist, jitter=jit).items():
            print(f'  新模型 {name}: {ok}/{total} = {ok / total * 100:.1f}%')
        if old_sess:
            for name, (ok, total) in eval_fonts(old_sess, preprocess_emnist, jitter=jit).items():
                print(f'  旧模型 {name}: {ok}/{total} = {ok / total * 100:.1f}%')
        print(f'-- 字体验收（{label}，旧预处理 bbox+15%内边距，对照）--')
        for name, (ok, total) in eval_fonts(sess, preprocess_old, jitter=jit).items():
            print(f'  新模型 {name}: {ok}/{total} = {ok / total * 100:.1f}%')
        if old_sess:
            for name, (ok, total) in eval_fonts(old_sess, preprocess_old, jitter=jit).items():
                print(f'  旧模型 {name}: {ok}/{total} = {ok / total * 100:.1f}%')

    # ---------- 笔画渲染验收（真实手写代理指标，镜像浏览器蒙层测试台） ----------
    stroke_json = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'test', 'emnist-strokes.json')
    if os.path.exists(stroke_json):
        for pen, pen_label in ((4.3, '当前app细笔 4.3px'), (18, '修复后app粗笔 18px')):
            print(f'\n-- 笔画渲染验收（{pen_label}，360画布/150px字形）--')
            for sess2, name2 in ((sess, '新模型'), (old_sess, '旧模型')):
                if sess2 is None:
                    continue
                ok, total, per = eval_strokes(sess2, stroke_json, pen=pen)
                worst = min(per.items(), key=lambda kv: kv[1][0] / kv[1][1])
                print(f'  {name2}: {ok}/{total} = {ok / total * 100:.1f}%  最差: {worst[0]} {worst[1][0]}/{worst[1][1]}')

    print('\n[done]')


if __name__ == '__main__':
    sys.exit(main())
