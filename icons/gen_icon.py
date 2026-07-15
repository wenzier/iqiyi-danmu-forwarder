#!/usr/bin/env python3
# 生成爱奇艺实时弹幕转发器 store icon（扁平极简：绿底 + 弹幕气泡 + 转发箭头）
# 4x 超采样绘制后降采样抗锯齿。
from PIL import Image, ImageDraw
import math, os

OUT = os.path.dirname(os.path.abspath(__file__))
SS = 4
S = 128 * SS  # 512 主画布

def lerp(a, b, t):
    return int(a * (1 - t) + b * t)

# --- 背景：竖直渐变 + 圆角裁切 ---
top = (0x22, 0xda, 0x74)   # 顶部亮绿
bot = (0x00, 0xa5, 0x42)   # 底部深绿
col = Image.new("RGBA", (1, S))
for y in range(S):
    t = y / (S - 1)
    col.putpixel((0, y), (lerp(top[0], bot[0], t), lerp(top[1], bot[1], t), lerp(top[2], bot[2], t), 255))
grad = col.resize((S, S))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# --- 白色弹幕气泡 ---
bx0, by0, bx1, by1 = int(S * 0.15), int(S * 0.17), int(S * 0.73), int(S * 0.585)
br = int(S * 0.11)
d.rounded_rectangle([bx0, by0, bx1, by1], radius=br, fill=(255, 255, 255, 255))
# 气泡左下尾巴
d.polygon([(int(S * 0.25), by1 - 4), (int(S * 0.25), by1 + int(S * 0.11)), (int(S * 0.40), by1 - 4)],
          fill=(255, 255, 255, 255))

# --- 气泡内三条弹幕线（主绿渐浅，长度递减，圆头）---
lx = int(S * 0.23)
lw = int(S * 0.05)
rows = [
    (int(S * 0.29), int(S * 0.64), (0x00, 0xc2, 0x50)),
    (int(S * 0.395), int(S * 0.60), (0x35, 0xd1, 0x79)),
    (int(S * 0.50), int(S * 0.55), (0x93, 0xe4, 0xb3)),
]
for y, e, c in rows:
    d.rounded_rectangle([lx, y - lw // 2, e, y + lw // 2], radius=lw // 2, fill=c + (255,))

# --- 右下角循环转发箭头角标 ---
cx, cy = int(S * 0.71), int(S * 0.70)
R = int(S * 0.19)
d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(0x00, 0x87, 0x37, 255),
          outline=(255, 255, 255, 255), width=int(S * 0.022))
# 循环弧（留缺口放箭头）
rr = int(R * 0.52)
aw = int(S * 0.038)
d.arc([cx - rr, cy - rr, cx + rr, cy + rr], start=310, end=180, fill=(255, 255, 255, 255), width=aw)
# 箭头头：弧起点(310°)处沿顺时针切线方向的三角
ang = math.radians(310)
ax = cx + rr * math.cos(ang)
ay = cy + rr * math.sin(ang)
tip = int(S * 0.055)
# 顺时针切线方向 = 角度 +90°
tang = math.radians(310 + 90)
tx = ax + tip * math.cos(tang)
ty = ay + tip * math.sin(tang)
# 三角两翼（垂直切线 = 半径方向）
wing = int(S * 0.045)
rad = math.radians(310)
w1x = ax + wing * math.cos(rad); w1y = ay + wing * math.sin(rad)
w2x = ax - wing * math.cos(rad); w2y = ay - wing * math.sin(rad)
d.polygon([(tx, ty), (w1x, w1y), (w2x, w2y)], fill=(255, 255, 255, 255))

# --- 导出多尺寸 ---
for sz in (128, 48, 16):
    img.resize((sz, sz), Image.LANCZOS).save(os.path.join(OUT, f"icon{sz}.png"))
# 额外存一张 512 大图用于商店 listing
img.save(os.path.join(OUT, "icon512.png"))
print("done: icon16/48/128/512.png")
