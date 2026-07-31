"""离线拒识分析：624 笔画样本，模拟浏览器识别流水线（质心对齐预处理 + 候选集约束），
扫描置信度策略：当前 p_best_in_candidate vs 候选集归一化 vs 组合，找最优拒识阈值。"""
import json
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

EMNIST_CLASSES = 'abcdefghijklmnopqrstuvwxyz'

def render_strokes_to_canvas(strokes, W=360, H=420, pen=None, scale_to_h=0.62):
    """与浏览器一致：笔画缩放到画布高度 62% 居中，圆头画笔"""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pen = pen or max(8, min(W, H) * 0.05)
    scale = H * scale_to_h / 28
    ox = W / 2 - 14 * scale
    oy = H * 0.18
    for stroke in strokes:
        pts = [((x * scale + ox), (y * scale + oy)) for x, y in stroke]
        if len(pts) == 1:
            pts.append((pts[0][0] + 0.4, pts[0][1]))
        draw.line(pts, fill=(255, 255, 255, 255), width=int(pen), joint='curve')
        for p in pts:
            r = pen / 2
            draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(255, 255, 255, 255))
    return img

def preprocess(img, size=28):
    """镜像 index.html recognizeLetterCNN 的 EMNIST 质心对齐预处理"""
    a = np.array(img)
    alpha = a[:, :, 3]
    ys, xs = np.nonzero(alpha > 20)
    if len(xs) == 0:
        return None
    minX, maxX, minY, maxY = xs.min(), xs.max(), ys.min(), ys.max()
    bw, bh = maxX - minX + 1, maxY - minY + 1
    scale20 = 20 / max(bw, bh)
    dw, dh = max(1, round(bw * scale20)), max(1, round(bh * scale20))
    tmp = Image.new('RGBA', (28, 28), (0, 0, 0, 0))
    tmp.paste(img.crop((minX, minY, maxX + 1, maxY + 1)).resize((dw, dh)), ((28 - dw) // 2, (28 - dh) // 2))
    ta = np.array(tmp)
    talpha = ta[:, :, 3]
    tys, txs = np.nonzero(talpha > 20)
    if len(txs) == 0:
        return None
    cx, cy = txs.mean(), tys.mean()
    dx = round(14 - cx)
    dy = round(14 - cy)
    dx = max(-txs.min(), min(dx, 27 - txs.max()))
    dy = max(-tys.min(), min(dy, 27 - tys.max()))
    out = np.zeros((28, 28), dtype=np.float32)
    src = (ta[:, :, 0] * 0.299 + ta[:, :, 1] * 0.587 + ta[:, :, 2] * 0.114) * (talpha / 255.0) / 255.0
    for y in range(28):
        sy = y - dy
        if 0 <= sy < 28:
            for x in range(28):
                sx = x - dx
                if 0 <= sx < 28:
                    out[y, x] = src[sy, sx]
    return out

def main():
    with open('test/emnist-strokes.json') as f:
        data = json.load(f)
    sess = ort.InferenceSession('emnist_cnn.onnx', providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    results = []
    for smp in data:
        img = render_strokes_to_canvas(smp['strokes'])
        feat = preprocess(img)
        if feat is None:
            results.append({'letter': smp['letter'], 'err': 'no-ink'})
            continue
        probs = sess.run([out_name], {in_name: feat[None, None].astype(np.float32)})[0][0]
        results.append({'letter': smp['letter'], 'probs': probs})

    letters = 'abcdefghijklmnopqrstuvwxyz'
    idx = {c: i for i, c in enumerate(letters)}

    # 真实拼音候选集（课文常见）；每个字母分配代表性拼音（贴近真实关卡）
    pinyin_sets = {
        'chun': set('chun'), 'ru': set('ru'), 'shuang': set('shuang'),
        'you': set('you'), 'cai': set('cai'), 'gua': set('gua'),
        'dong': set('dong'), 'qiu': set('qiu'), 'tian': set('tian'),
        'sheng': set('sheng'), 'zi': set('zi'), 'lai': set('lai'),
        'ye': set('ye'), 'wan': set('wan'), 'an': set('an'),
    }
    L2PY = {
        'a': 'an', 'b': 'ba', 'c': 'cai', 'd': 'dong', 'e': 'ye', 'f': 'fa',
        'g': 'gua', 'h': 'shuang', 'i': 'zi', 'j': 'j', 'k': 'k', 'l': 'lai',
        'm': 'm', 'n': 'an', 'o': 'dong', 'p': 'p', 'q': 'qiu', 'r': 'ru',
        's': 'sheng', 't': 'tian', 'u': 'ru', 'v': 'shuang', 'w': 'wan',
        'x': 'x', 'y': 'ye', 'z': 'zi',
    }

    for mode in ['single', 'multi']:
        for th in [0.20, 0.25, 0.30, 0.35]:
            ok = rej = err = 0
            wrongs = {}
            for r in results:
                if 'err' in r:
                    err += 1
                    continue
                p = r['probs']
                allowed = {r['letter']} if mode == 'single' else pinyin_sets.get(L2PY.get(r['letter'], r['letter']), {r['letter']})
                allowed_idx = sorted(idx[c] for c in allowed)
                p_best = max(p[i] for i in allowed_idx)
                best_letter = letters[allowed_idx[np.argmax([p[i] for i in allowed_idx])]]
                if p_best >= th:
                    if best_letter == r['letter']:
                        ok += 1
                    else:
                        err += 1
                        wrongs[best_letter] = wrongs.get(best_letter, 0) + 1
                else:
                    rej += 1
            total = len(results)
            print(f"{mode:6s} th={th:.2f}: ok={ok}/{total} ({ok/total*100:.1f}%) rej={rej} err={err} wrongs={wrongs}")

    # 归一化置信度策略：conf = p_best / (p_best + p_outside_max)
    print("\n=== 归一化置信度 conf_norm = p_best/(p_best+p_outside_max) (multi) ===")
    for th in [0.30, 0.35, 0.40, 0.45, 0.50]:
        ok = rej = err = 0
        wrongs = {}
        for r in results:
            if 'err' in r:
                continue
            p = r['probs']
            allowed = pinyin_sets.get(L2PY.get(r['letter'], r['letter']), {r['letter']})
            allowed_idx = sorted(idx[c] for c in allowed)
            p_best = max(p[i] for i in allowed_idx)
            best_letter = letters[allowed_idx[np.argmax([p[i] for i in allowed_idx])]]
            outside = [p[i] for i in range(26) if i not in allowed_idx]
            p_out = max(outside) if outside else 0.0
            conf = p_best / (p_best + p_out)
            if conf >= th:
                if best_letter == r['letter']:
                    ok += 1
                else:
                    err += 1
                    wrongs[best_letter] = wrongs.get(best_letter, 0) + 1
            else:
                rej += 1
        total = len(results)
        print(f"th={th:.2f}: ok={ok}/{total} ({ok/total*100:.1f}%) rej={rej} err={err} wrongs={wrongs}")

    # 混合策略：绝对阈值 0.22 OR 归一化 0.45
    print("\n=== 混合策略: p_best>=0.22 OR conf_norm>=0.45 (multi) ===")
    ok = rej = err = 0
    wrongs = {}
    for r in results:
        if 'err' in r:
            continue
        p = r['probs']
        allowed = pinyin_sets.get(L2PY.get(r['letter'], r['letter']), {r['letter']})
        allowed_idx = sorted(idx[c] for c in allowed)
        p_best = max(p[i] for i in allowed_idx)
        best_letter = letters[allowed_idx[np.argmax([p[i] for i in allowed_idx])]]
        outside = [p[i] for i in range(26) if i not in allowed_idx]
        p_out = max(outside) if outside else 0.0
        conf = p_best / (p_best + p_out)
        if p_best >= 0.22 or conf >= 0.45:
            if best_letter == r['letter']:
                ok += 1
            else:
                err += 1
                wrongs[best_letter] = wrongs.get(best_letter, 0) + 1
        else:
            rej += 1
    total = len(results)
    print(f"ok={ok}/{total} ({ok/total*100:.1f}%) rej={rej} err={err} wrongs={wrongs}")
    # 混合策略错误样本明细
    print("\n=== 混合策略 err 样本明细 ===")
    for r in results:
        if 'err' in r:
            continue
        p = r['probs']
        allowed = pinyin_sets.get(L2PY.get(r['letter'], r['letter']), {r['letter']})
        allowed_idx = sorted(idx[c] for c in allowed)
        p_best = max(p[i] for i in allowed_idx)
        best_letter = letters[allowed_idx[np.argmax([p[i] for i in allowed_idx])]]
        outside = [p[i] for i in range(26) if i not in allowed_idx]
        p_out = max(outside) if outside else 0.0
        conf = p_best / (p_best + p_out)
        if best_letter != r['letter'] and (p_best >= 0.22 or conf >= 0.45):
            top5 = np.argsort(p)[::-1][:5]
            top5s = ' '.join(f"{letters[i]}:{p[i]:.2f}" for i in top5)
            print(f"{r['letter']}→{best_letter} (p_best={p_best:.2f} conf={conf:.2f}): {top5s}")


    # 网格扫描：绝对 vs 归一化 vs 混合
    print("\n=== 网格扫描 (multi) ===")
    for strat in ['abs', 'norm', 'mix']:
        for th in [0.18, 0.20, 0.22, 0.25, 0.28]:
            ok = rej = err = 0
            for r in results:
                if 'err' in r:
                    err += 1
                    continue
                p = r['probs']
                allowed = pinyin_sets.get(L2PY.get(r['letter'], r['letter']), {r['letter']})
                allowed_idx = sorted(idx[c] for c in allowed)
                p_best = max(p[i] for i in allowed_idx)
                best_letter = letters[allowed_idx[np.argmax([p[i] for i in allowed_idx])]]
                outside = [p[i] for i in range(26) if i not in allowed_idx]
                p_out = max(outside) if outside else 0.0
                conf = p_best / (p_best + p_out)
                pass_ = (strat == 'abs' and p_best >= th) or \
                        (strat == 'norm' and conf >= th) or \
                        (strat == 'mix' and (p_best >= th or conf >= th + 0.15))
                if pass_:
                    if best_letter == r['letter']:
                        ok += 1
                    else:
                        err += 1
                else:
                    rej += 1
            print(f"{strat:4s} th={th:.2f}: ok={ok}/624 ({ok/624*100:.1f}%) rej={rej} err={err}")

    # 深入：拒识样本的概率画像（single，th=0.30）
    print("\n=== 拒识样本画像 (single, th=0.30) ===")
    for r in results:
        if 'err' in r:
            continue
        p = r['probs']
        li = idx[r['letter']]
        p_best = p[li]
        if p_best < 0.30:
            top5 = np.argsort(p)[::-1][:5]
            top5s = ' '.join(f"{letters[i]}:{p[i]:.2f}" for i in top5)
            print(f"{r['letter']}: p_self={p_best:.2f} | top5: {top5s}")

if __name__ == '__main__':
    main()
