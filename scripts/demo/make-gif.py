# SPDX-License-Identifier: GPL-3.0-only
"""Join the frames from shoot-gif.mjs into docs/img/demo.gif (pointer drawn on afterwards).
Usage: python scripts/demo/make-gif.py [out.gif]"""
import json, sys, os
from PIL import Image, ImageDraw, ImageFilter

root = os.path.join(os.path.dirname(__file__), '..', '..')
src = os.path.join(root, '_testserver', 'demo-shots', 'gif')
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'docs', 'img', 'demo.gif')
meta = json.load(open(os.path.join(src, 'frames.json')))

K = 8
PTS = [(3, 2), (17, 10.5), (10.8, 12.1), (14.5, 18.5), (11.9, 20), (8.2, 13.6), (4.8, 18)]

def sprite(scale):
    w = 26
    base = Image.new('RGBA', (w * K, w * K), (0, 0, 0, 0))
    shadow = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x * K + 1.5 * K, y * K + 2 * K) for x, y in PTS], fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.6 * K))
    d = ImageDraw.Draw(base)
    pts = [(x * K, y * K) for x, y in PTS]
    d.polygon(pts, fill=(27, 32, 41, 255))
    inner = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(inner).polygon(pts, fill=(255, 255, 255, 255))
    inner = inner.filter(ImageFilter.MinFilter(int(1.4 * K) // 2 * 2 + 1))
    base.alpha_composite(inner)
    shadow.alpha_composite(base)
    return shadow.resize((round(w * scale), round(w * scale)), Image.LANCZOS)

SCALE = Image.open(os.path.join(src, '000.png')).width / 790
cur = sprite(SCALE)
frames, durs = [], []
for i, m in enumerate(meta):
    im = Image.open(os.path.join(src, f'{i:03d}.png')).convert('RGBA')
    if m['pos']:
        im.alpha_composite(cur, (round((m['pos']['x'] - 3) * SCALE), round((m['pos']['y'] - 2) * SCALE)))
    frames.append(im.convert('RGB'))
    durs.append(m['ms'])

# One shared palette keeps colors steady between frames (a sample of every distinct scene, half size).
small = [f.resize((f.width // 2, f.height // 2), Image.LANCZOS) for f in frames[::2] + [frames[-1]]]
sheet = Image.new('RGB', (small[0].width, small[0].height * len(small)))
for k, f in enumerate(small):
    sheet.paste(f, (0, k * f.height))
pal = sheet.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(out, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(out, os.path.getsize(out) // 1024, 'KB', len(frames), 'frames', sum(durs) / 1000, 's')
