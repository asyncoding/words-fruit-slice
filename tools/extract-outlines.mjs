// 拼音描红 v2 轮廓提取工具（一次性离线）
// 从系统字体（Arial）提取 26 小写字母 + 'ü' 的轮廓：
//   d     = SVG path data（可直接 new Path2D(d) 使用；运行时采样边缘点）
//   bbox  = 归一化包围盒 [minX, minY, maxX, maxY]
// 归一化坐标系（四线三格）：基线 y=130，x-height 顶 y=65（与 TRACE_TEMPLATES 体系一致）
// 字母 'a' 采用 U+0251（拉丁字母 ɑ，手写单层形，见 TONE_TO_KEY 声调归并），其余保持 Arial
// 用法: npm i opentype.js && node tools/extract-outlines.mjs > tools/pinyin-outlines.json
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import opentype from 'opentype.js';
const { parse } = opentype;

const FONT = process.argv[2] || '/System/Library/Fonts/Supplemental/Arial.ttf';
const OUT = new URL('./pinyin-outlines.json', import.meta.url);

// 字母 → 实际取形码位：'a' 用手写单层 ɑ（U+0251）
const CHAR_SRC = { 'a': '\u0251' };

const font = parse(readFileSync(FONT));
const upe = font.unitsPerEm;

// 缩放基准：'x' 字形实测高度（x-height）→ 65px（四线三格第 2 线）
const xH = -font.charToGlyph('x').getPath(0, 0, upe).getBoundingBox().y1;
const scale = 65 / xH;
const tx = (x) => x * scale;
const ty = (y) => 130 + y * scale;   // 该字体 y 向上为正、基线 0 → 画布 y 向下、基线 130

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
LETTERS.push('ü');
const out = {};
const missing = [];
const R = v => Math.round(v * 100) / 100;
for (const ch of LETTERS) {
  const src = CHAR_SRC[ch] || ch;
  const glyph = font.charToGlyph(src);
  if (!glyph || glyph.index === 0) { missing.push(ch + '←' + src); continue; }
  const path = glyph.getPath(0, 0, upe);
  // 路径数据坐标一并归一化（直接交给 Path2D / isPointInPath）
  let d = '';
  for (const c of path.commands) {
    if (c.type === 'M') d += 'M' + R(tx(c.x)) + ' ' + R(ty(c.y));
    else if (c.type === 'L') d += 'L' + R(tx(c.x)) + ' ' + R(ty(c.y));
    else if (c.type === 'Q') d += 'Q' + R(tx(c.x1)) + ' ' + R(ty(c.y1)) + ' ' + R(tx(c.x)) + ' ' + R(ty(c.y));
    else if (c.type === 'C') d += 'C' + R(tx(c.x1)) + ' ' + R(ty(c.y1)) + ' ' + R(tx(c.x2)) + ' ' + R(ty(c.y2)) + ' ' + R(tx(c.x)) + ' ' + R(ty(c.y));
    else if (c.type === 'Z') d += 'Z';
  }
  const bb = path.getBoundingBox();
  out[ch] = {
    d,
    bbox: [R(tx(bb.x1)), R(ty(bb.y1)), R(tx(bb.x2)), R(ty(bb.y2))],
  };
}
if (missing.length) { console.error('缺失字形: ' + missing.join(',')); process.exit(1); }
writeFileSync(OUT, JSON.stringify(out));
console.error(`OK: ${Object.keys(out).length} 个字母, xHeight=${xH}, 输出 ${statSync(OUT).size} 字节`);
