#!/usr/bin/env python3
# Builds preview/clawd.gif (shown in the README) from the spritesheets in clawd-animation/:
# idle x2 -> laptop_out -> work x2 -> success (its `seconds`), looping, 8x on the dark top-bar colour.
# Dev-only (needs Pillow), not packaged. Usage: python3 tools/make-preview-gif.py
import json, os
from PIL import Image
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
anim_dir = os.path.join(root, 'clawd-animation')
m = json.load(open(os.path.join(anim_dir, 'animations.json')))
SCALE, TOP, ROWS = 8, 2, 13          # rows 2..14 = installed 16x13 grid
BG = (0, 0, 0, 255)                  # GNOME top bar
W, H = 256, 208
fps = m['fps']
def frames(name):
    a = m['animations'][name]
    sheet = Image.open(os.path.join(anim_dir, a['file'])).convert('RGBA')
    fw = a.get('frameWidth', sheet.height)
    out = []
    for i in range(sheet.width // fw):
        f = sheet.crop((i * fw, TOP, i * fw + fw, TOP + ROWS)).resize((fw * SCALE, ROWS * SCALE), Image.NEAREST)
        c = Image.new('RGBA', (W, H), BG)
        c.alpha_composite(f, ((W - f.width) // 2, (H - f.height) // 2))
        out.append(c.convert('RGB'))
    return out
st = m['states']
idle, start, work, done = frames(st['sleep']), frames(st['start']), frames(st['work'][0]), frames(st['done'])
done = (done * 10)[:round(m['animations'][st['done']]['seconds'] * fps)]
seq = idle * 2 + start + work * 2 + done
os.makedirs(os.path.join(root, 'preview'), exist_ok=True)
out = os.path.join(root, 'preview', 'clawd.gif')
seq[0].save(out, save_all=True, append_images=seq[1:], duration=round(1000 / fps), loop=0, optimize=True, disposal=1)
print(out, len(seq), 'frames', os.path.getsize(out), 'bytes')
