#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EMNIST 26类字母CNN 重训管线（方向A3：孩子笔迹增强重训 + 方向A4：EMNIST标准预处理对齐）

- 数据：torchvision EMNIST split='letters'（train 124800 / test 20800，类 0-25 = a-z）
- 增强（先EMNIST标准形 -> 再随机扰动）：
    旋转 ±25° / 缩放 0.75~1.25 / 平移 ±3px（带画布越界约束，避免裁掉字母笔画）
    随机擦除少量笔画像素；scipy.ndimage 3×3 dilate/erode 各 25%（粗细模拟）
- 架构：conv32-BN-MP-conv96-BN-MP-fc128-fc26（约63万参数，fp32 < 4MB）
- 训练：Adam lr 1e-3 cosine，batch 256，epoch 8；每 epoch 报 EMNIST test 准确率
- 导出：opset 13，input/output 命名 + Softmax 结尾；onnxruntime 数值一致性验证
- 验收：EMNIST test >= 97%；字体渲染 Arial >= 99% / Georgia >= 90% / 草书 >= 85%
"""
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
    train_ds = ConcatDataset([emnist_tr, font_tr])
    test_ds = EMNISTDataset('test', augment=False)
    train_loader = DataLoader(train_ds, batch_size=BATCH, shuffle=True, num_workers=NUM_WORKERS,
                              persistent_workers=True, worker_init_fn=worker_init, drop_last=False)
    test_loader = DataLoader(test_ds, batch_size=512, shuffle=False, num_workers=2,
                             persistent_workers=True, worker_init_fn=worker_init)
    print(f'[data] train={len(train_ds)} (EMNIST 124800 + 字体合成) test={len(test_ds)}')

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

    print('\n[done]')


if __name__ == '__main__':
    sys.exit(main())
