"""Genera gli sprite sheet di Clawd (16x16 per frame, 1px = 1 cella griglia, 8 fps).

Versioni precedenti nella cronologia git di clawd-animation/.
"""
import os
from PIL import Image

W = H = 16
GROUND = 14  # ultima riga occupata dai piedi
TOP = 2      # prima riga usabile: altezza massima 13 righe (26 px / 2 px per pixel)
HERE = os.path.dirname(os.path.abspath(__file__))

O = (218, 119, 87, 255)      # corpo
OD = (176, 90, 64, 255)      # fianco / parti lontane
OL = (238, 160, 128, 255)    # viso illuminato dallo schermo (alone)
LIT = (250, 196, 172, 255)   # viso illuminato dallo schermo (pieno)
EYE = (0, 0, 0, 255)
EYE_SHUT = (120, 52, 34, 255)
# laptop moderno: space gray, sottile
LAP_EDGE = (110, 113, 122, 255)  # bordo/spigolo che prende luce
LAP = (66, 68, 76, 255)          # coperchio
LAP_BASE = (46, 48, 54, 255)     # base
LAP_LOGO = (150, 153, 162, 255)  # riflesso che scorre
GLOW = (150, 215, 245, 255)      # luce schermo
GLOW2 = (110, 170, 230, 255)
SPILL = (150, 215, 245, 80)      # luce che si spande davanti allo schermo
SMEAR = (246, 246, 250, 255)
SMEAR2 = (246, 246, 250, 130)
ZC = (170, 178, 215, 255)
ZC2 = (170, 178, 215, 120)
SPARK = (255, 214, 102, 255)
DUST = (225, 215, 205, 200)


class F:
    def __init__(self):
        self.im = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    def px(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.im.putpixel((x, y), c)

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def pattern(self, x0, y0, rows, c):
        for dy, row in enumerate(rows):
            for dx, ch in enumerate(row):
                if ch == "#":
                    self.px(x0 + dx, y0 + dy, c)


def sheet(frames, name):
    s = Image.new("RGBA", (W * len(frames), H), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        s.paste(f.im, (i * W, 0))
    s.save(os.path.join(HERE, name))
    print(name, len(frames), "frame")


# ---------------------------------------------------------------- pose base

def front(f, top=7, legs=2, arms="side", eyes="open", eye_dy=0):
    """Clawd frontale. corpo x4..11, alto 6, occhi a riga top+1."""
    bottom = top + 5
    f.rect(4, top, 11, bottom, O)
    for lx in (4, 6, 9, 11):
        if legs:
            f.rect(lx, bottom + 1, lx, bottom + legs, O)
    if arms == "side":
        f.rect(2, top + 2, 3, top + 3, O); f.rect(12, top + 2, 13, top + 3, O)
    elif arms == "low":
        f.rect(2, top + 3, 3, top + 4, O); f.rect(12, top + 3, 13, top + 4, O)
    elif arms == "up":
        f.rect(2, top - 1, 3, top, O); f.rect(12, top - 1, 13, top, O)
    ey = top + 1 + eye_dy
    if eyes == "open":
        f.px(5, ey, EYE); f.px(10, ey, EYE)
    elif eyes == "shut":
        f.px(5, ey, EYE_SHUT); f.px(10, ey, EYE_SHUT)


def three_q_right(f, top=7, legs=2):
    """Clawd girato di 3/4 verso destra: fianco scuro a sinistra."""
    bottom = top + 5
    f.rect(4, top, 11, bottom, O)
    f.rect(4, top, 5, bottom, OD)
    for lx, c in ((5, OD), (9, OD), (7, O), (11, O)):
        f.rect(lx, bottom + 1, lx, bottom + legs, c)
    f.rect(12, top + 2, 13, top + 3, O)
    f.rect(2, top + 2, 3, top + 3, OD)
    f.px(7, top + 1, EYE); f.px(10, top + 1, EYE)


def back_view(f, top=7, arms="side"):
    """Clawd di spalle: niente occhi, base più scura."""
    bottom = top + 5
    legs = GROUND - bottom
    f.rect(4, top, 11, bottom, O)
    f.rect(4, bottom, 11, bottom, OD)
    for lx in (4, 6, 9, 11):
        f.rect(lx, bottom + 1, lx, bottom + legs, OD)
    if arms == "side":
        f.rect(2, top + 2, 3, top + 3, O); f.rect(12, top + 2, 13, top + 3, O)
    elif arms == "dig_l":                        # una chela davanti (nascosta), l'altra su
        f.rect(2, top + 1, 3, top + 2, O); f.rect(12, top + 3, 12, top + 4, OD)
    elif arms == "dig_r":
        f.rect(3, top + 3, 3, top + 4, OD); f.rect(12, top + 1, 13, top + 2, O)


def three_q_left(f, top=7, arm=None, eyes=True, lit=None):
    """Clawd girato di 3/4 verso sinistra (fianco scuro a destra), come in work.

    lit: None oppure fase 0..3 della luce dello schermo sulla faccia.
    """
    bottom = top + 5
    legs = GROUND - bottom
    f.rect(6, top, 13, bottom, O)
    f.rect(12, top, 13, bottom, OD)
    for lx, c in ((6, O), (8, OD), (10, O), (12, OD)):
        f.rect(lx, bottom + 1, lx, bottom + legs, c)
    f.rect(14, top + 2, 14, top + 3, OD)           # braccio lontano
    if lit is not None:
        # metà sinistra della faccia illuminata; il bordo dell'alone tremola
        full = {0: 2, 1: 3, 2: 2, 3: 1}[lit]       # colonne LIT
        halo = {0: 2, 1: 2, 2: 3, 3: 2}[lit]       # colonne OL dopo le LIT
        for k in range(full + halo):
            c = LIT if k < full else OL
            f.rect(6 + k, top + 1, 6 + k, bottom - 1, c)
        f.px(6, top, OL); f.px(6, bottom, OL)
    if eyes:
        f.px(7, top + 2, EYE); f.px(10, top + 2, EYE)   # sguardo basso verso il pc
    else:
        f.px(7, top + 2, EYE_SHUT); f.px(10, top + 2, EYE_SHUT)
    if arm == "type_up":
        f.rect(4, 11, 5, 12, OL if lit is not None else O)
    elif arm == "type_down":
        f.rect(4, 12, 5, 13, OL if lit is not None else O)
    elif arm == "swing":
        f.px(5, top + 2, O); f.px(4, top + 3, O); f.px(3, top + 4, O); f.px(4, top + 4, O)
    elif arm == "slam":
        f.rect(4, 12, 5, 12, O); f.px(5, 11, O)


# ---------------------------------------------------------------- laptop

def laptop_closed(f, x, y, shine=None, w=6):
    """Laptop chiuso, orizzontale: 2 righe (spigolo + coperchio)."""
    f.rect(x, y, x + w - 1, y, LAP_EDGE)
    f.rect(x, y + 1, x + w - 1, y + 1, LAP)
    if shine is not None:
        f.px(x + shine, y, LAP_LOGO)


def laptop_closed_v(f, x, y, h=6):
    """Laptop chiuso tenuto in verticale: 2 colonne."""
    f.rect(x, y, x, y + h - 1, LAP_EDGE)
    f.rect(x + 1, y, x + 1, y + h - 1, LAP)


def laptop_open(f, screen=None, spill=False):
    """Laptop aperto di lato a sinistra: base 1 riga, coperchio sottile inclinato
    all'indietro, schermo rivolto a destra (verso Clawd). screen: colore o None (spento)."""
    f.rect(0, GROUND, 6, GROUND, LAP_BASE)
    for x, y in ((1, 13), (1, 12), (1, 11), (0, 10), (0, 9)):
        f.px(x, y, LAP)
    f.px(0, 8, LAP_EDGE)
    sc = screen if screen is not None else LAP_BASE
    for x, y in ((2, 12), (2, 11), (1, 10), (1, 9), (1, 8)):
        f.px(x, y, sc)
    if spill:
        for x, y in ((2, 9), (2, 10), (3, 10), (3, 11), (3, 12), (2, 8), (3, 9)):
            f.px(x, y, SPILL)


# ---------------------------------------------------------------- 1. idle

def z_small(f, x, y, c):
    f.pattern(x, y, ["###", ".#.", "###"], c)


def z_big(f, x, y, c):
    f.pattern(x, y, ["####", "..#.", ".#..", "####"], c)


def idle():
    frames = []
    # sollevamento di tutto il bordo superiore (corpo sempre rettangolare)
    breath = [0, 0, 0, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0]
    # traiettoria Z: (frame, tipo, x, y), sempre a destra del corpo
    zpath = {3: ("s", 12, 6), 4: ("s", 12, 6), 5: ("s", 12, 5), 6: ("s", 13, 5),
             7: ("s", 13, 4), 8: ("b", 12, 3), 9: ("b", 12, 3), 10: ("b", 12, 2),
             11: ("b", 12, 2), 12: ("b", 12, 2), 13: ("bf", 12, 2)}
    for i, lift in enumerate(breath):
        f = F()
        top = 9 - lift  # sdraiato: corpo righe top..14
        f.rect(4, top, 11, GROUND, O)
        # braccia mollate a terra
        f.rect(2, GROUND - 1, 3, GROUND, O); f.rect(12, GROUND - 1, 13, GROUND, O)
        # occhi chiusi larghi 2, seguono il respiro
        f.rect(5, top + 2, 6, top + 2, EYE_SHUT); f.rect(9, top + 2, 10, top + 2, EYE_SHUT)
        if i in zpath:
            t, zx, zy = zpath[i]
            if t == "s":
                z_small(f, zx, zy, ZC)
            else:
                z_big(f, zx, zy, ZC2 if t == "bf" else ZC)
        frames.append(f)
    sheet(frames, "idle.png")


# ---------------------------------------------------------------- 3. lavoro

TYPING = [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0]


def work_frame(f, i):
    up = TYPING[i % len(TYPING)]
    blink = i == 9
    laptop_open(f, screen=GLOW if i % 3 else GLOW2, spill=True)
    three_q_left(f, arm="type_up" if up else "type_down", eyes=not blink, lit=i % 4)


def work():
    frames = []
    for i in range(len(TYPING)):
        f = F(); work_frame(f, i); frames.append(f)
    sheet(frames, "work.png")


# ---------------------------------------------------------------- 2. tira fuori il PC

def overhead(f, ly, shine=None, smear=False, back=False):
    """Laptop sollevato sopra la testa con due chele (visto di fronte: è largo 10)."""
    if back:
        back_view(f, arms=None)
    else:
        front(f, arms=None)
    f.rect(2, ly + 2, 3, 8, O); f.rect(12, ly + 2, 13, 8, O)
    laptop_closed(f, 3, ly, shine=shine, w=10)
    if smear:
        f.rect(4, ly + 2, 11, ly + 2, SMEAR2)


def slam_ending():
    """Comune a A e B: pausa in alto, carica, sbatte a sinistra, apre (fino a work)."""
    frames = []
    # pausa in alto con riflesso che scorre
    for s in (None, 2, 5, 8):
        f = F(); overhead(f, 3, shine=s); frames.append(f)
    # carica: si gira a 3/4 sinistra, laptop (ora di taglio) sopra la testa, un po' indietro
    f = F(); three_q_left(f, top=8); f.rect(4, 5, 5, 10, O); f.rect(14, 5, 14, 10, OD)
    laptop_closed(f, 5, 3, w=9); frames.append(f)
    # swing: scia ad arco verso sinistra, laptop in verticale a metà corsa
    f = F()
    f.rect(4, 2, 6, 2, SMEAR2); f.rect(2, 3, 3, 4, SMEAR2); f.rect(1, 5, 1, 6, SMEAR)
    three_q_left(f, arm="swing")
    laptop_closed_v(f, 0, 7)
    frames.append(f)
    # impatto: laptop piatto a terra, Clawd schiacciato, polvere
    f = F()
    three_q_left(f, top=8, arm="slam")
    laptop_closed(f, 0, 13)
    for x, y in ((0, 12), (6, 13), (7, 12)):
        f.px(x, y, DUST)
    frames.append(f)
    f = F()
    three_q_left(f, arm="slam")
    laptop_closed(f, 0, 13)
    frames.append(f)
    # apre: coperchio dritto, poi inclinato con schermo spento
    f = F()
    three_q_left(f, arm="type_down")
    f.rect(0, GROUND, 6, GROUND, LAP_BASE)
    f.rect(1, 9, 1, 13, LAP); f.px(1, 8, LAP_EDGE)
    frames.append(f)
    f = F()
    three_q_left(f, arm="type_down")
    laptop_open(f)
    frames.append(f)
    return frames


def laptop_out():
    """Si gira di spalle e fruga davanti a sé."""
    frames = []
    for _ in range(2):
        f = F(); front(f); frames.append(f)
    f = F(); three_q_right(f); frames.append(f)
    f = F(); back_view(f); frames.append(f)
    for arms, top in (("dig_l", 8), ("dig_r", 8), ("dig_l", 7), ("dig_r", 8)):
        f = F(); back_view(f, top=top, arms=arms); frames.append(f)
    # lo alza sopra la testa (sempre di spalle)
    f = F(); overhead(f, 4, smear=True, back=True); frames.append(f)
    f = F(); overhead(f, 2, back=True); frames.append(f)
    # si gira verso di noi con il laptop in alto
    f = F(); overhead(f, 2); frames.append(f)
    frames += slam_ending()
    sheet(frames, "laptop_out.png")


# ---------------------------------------------------------------- 4. successo

def success():
    frames = []

    def stand():
        f = F(); front(f); return f

    def squash():
        f = F()
        f.rect(4, 8, 11, 13, O)                # corpo abbassato
        for lx in (4, 6, 9, 11):
            f.px(lx, 14, O)
        f.rect(2, 11, 3, 12, O); f.rect(12, 11, 13, 12, O)
        f.px(5, 9, EYE); f.px(10, 9, EYE)
        return f

    def air(top, arms, sparks=0, dust=False):
        f = F(); front(f, top=top, arms=arms)
        if sparks == 1:
            for x, y in ((0, 4), (15, 3), (1, 7)):
                f.px(x, y, SPARK)
        elif sparks == 2:
            for x, y in ((0, 3), (1, 4), (0, 5), (15, 4), (14, 3), (15, 2)):
                f.px(x, y, SPARK)
        if dust:
            for x in (2, 3, 12, 13):
                f.px(x, GROUND, DUST)
        return f

    for _ in range(2):
        frames += [stand(), squash(), air(4, "up", dust=True), air(3, "up", 1),
                   air(3, "up", 2), air(4, "side"), squash()]
    frames += [stand(), stand()]
    sheet(frames, "success.png")


if __name__ == "__main__":
    idle(); laptop_out(); work(); success()
