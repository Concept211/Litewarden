# SPDX-License-Identifier: GPL-3.0-only
"""Copy and crop the 2x screenshots into docs/img, and make the store images 24-bit (no alpha).
Usage: python scripts/demo/finish.py   (after shoot-popup.mjs, shoot-inpage.mjs --scale 2, compose.mjs)"""
import os, shutil
from PIL import Image

root = os.path.join(os.path.dirname(__file__), '..', '..')
raw = os.path.join(root, '_testserver', 'demo-shots')
img = os.path.join(root, 'docs', 'img')

for n in ['main-light', 'main-dark', 'item-view-dark', 'unlock-pin-light', 'unlock-pin-dark', 'settings-home-dark', 'edit-light']:
    shutil.copy(os.path.join(raw, 'popup@2x', n + '.png'), os.path.join(img, n + '.png'))

def crop(src, dst, box, scale=2):
    im = Image.open(os.path.join(raw, 'inpage@2x', src)).convert('RGB')
    im.crop(tuple(int(v * scale) for v in box)).save(os.path.join(img, dst), optimize=True)

crop('menu-light.png', 'inpage-menu-light.png', (480, 120, 1280, 530))
crop('save-light.png', 'inpage-save-light.png', (232, 0, 1280, 480))

for rel in ['brand/store/screenshot-%d.png' % i for i in range(1, 6)] + ['brand/store/marquee-1400x560.png', 'brand/social-preview.png']:
    p = os.path.join(root, rel)
    Image.open(p).convert('RGB').save(p, optimize=True)
for f in ['hero.png']:
    p = os.path.join(img, f)
    Image.open(p).convert('RGB').save(p, optimize=True)
for f in ['inpage-teach-light.png', 'search-notes-light.png']:
    p = os.path.join(img, f)
    if os.path.exists(p):
        os.remove(p)
for f in sorted(os.listdir(img)):
    p = os.path.join(img, f); im = Image.open(p) if f.endswith('.png') else None
    print(f, os.path.getsize(p) // 1024, 'KB', im.size if im else '')
