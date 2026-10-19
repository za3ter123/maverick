# python desktop/make-icon.py   Writes desktop/icon.ico (Windows app, taskbar and tray icon), desktop/icon.png and
# ../icon.svg (favicon) from one geometry: the helmet mark, a navy disc with an M cut out of it, on a bone tile.
# The disc's dome above the M is the helmet; the M's legs run out through the bottom of the disc.
# Every frame is drawn at its own size, 16x supersampled, not shrunk from 256 px. At 48 px and under the tile is
# full bleed, the disc is larger, and the M's legs and top edge sit on whole pixels, so the cut stays crisp at
# 16 px. 20, 30, 36 and 40 are there for 125 %, 150 %, 225 % and 250 % scaling of the 16 px tray and 24 px taskbar.
import math
from pathlib import Path
from PIL import Image, ImageDraw

NAVY, BONE = '#0B1426', '#F2EFE8'
SS = 16  # supersampling
SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 64, 128, 256]
DISC = {16: .42, 20: .41, 24: .40, 30: .395, 32: .39, 36: .385, 40: .38, 48: .36}  # disc radius / size, small frames


def geometry(s):
    """Tile, disc and the M cut for an s px frame. Units u = r / 12.5 (the 32-grid design has r = 12.5)."""
    small = s <= 48
    r = s * DISC[s] if s in DISC else s * 10 / 32
    cx = cy = s / 2
    u = r / 12.5
    snap = round if small else (lambda v: v)
    lo, li = snap(cx - 9 * u), snap(cx - 5 * u)          # left leg, outer and inner edge
    if small and li - lo < 1:
        li = lo + 1
    top = snap(cy - 3.5 * u)                             # the M's top edge, under the dome
    vtop = top + 1.2 * (cx - li)                         # the V's point (the diagonals rise 6 for every 5 across)
    ileg = top + 6.1 * u                                 # where the diagonal's lower edge leaves the leg (parallel edges)
    ch = 1 * u                                           # half width of the flat cut under the V
    chy = ileg + 1.2 * (cx - ch - li)
    return dict(s=s, small=small, cx=cx, cy=cy, r=r, lo=lo, li=li, ro=s - lo, ri=s - li, top=top, vtop=vtop,
                ileg=ileg, ch=ch, chy=chy, tile_r=s * .225 if small else s * .2, inset=0 if small else s / 32)


def hole(g, bottom):
    """The M cut as a polygon, legs running down to y = bottom."""
    return [(g['lo'], bottom), (g['lo'], g['top']), (g['li'], g['top']), (g['cx'], g['vtop']), (g['ri'], g['top']),
            (g['ro'], g['top']), (g['ro'], bottom), (g['ri'], bottom), (g['ri'], g['ileg']),
            (g['cx'] + g['ch'], g['chy']), (g['cx'] - g['ch'], g['chy']), (g['li'], g['ileg']), (g['li'], bottom)]


def mark_path(g, dx=0.0, dy=0.0):
    """SVG path of the disc minus the M (two pieces: dome and cheeks, then the chin), exact arcs."""
    cx, cy, r = g['cx'], g['cy'], g['r']
    yat = lambda x: cy + math.sqrt(r * r - (x - cx) ** 2)
    n = lambda v: f"{v:.3f}".rstrip('0').rstrip('.')
    X = lambda x: n(x + dx); Y = lambda y: n(y + dy)
    lo, li, ro, ri, top = g['lo'], g['li'], g['ro'], g['ri'], g['top']
    return (f"M{X(lo)} {Y(yat(lo))}V{Y(top)}H{X(li)}L{X(cx)} {Y(g['vtop'])}L{X(ri)} {Y(top)}H{X(ro)}V{Y(yat(ro))}"
            f"A{n(r)} {n(r)} 0 1 0 {X(lo)} {Y(yat(lo))}Z"
            f"M{X(li)} {Y(g['ileg'])}L{X(cx - g['ch'])} {Y(g['chy'])}H{X(cx + g['ch'])}L{X(ri)} {Y(g['ileg'])}V{Y(yat(ri))}"
            f"A{n(r)} {n(r)} 0 0 1 {X(li)} {Y(yat(li))}Z")


def tile_svg(s, tile=BONE, ink=NAVY, title='Maverick'):
    g = geometry(s)
    i = g['inset']
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="{s}" height="{s}"><title>{title}</title>'
            f'<rect x="{i:g}" y="{i:g}" width="{s - 2 * i:g}" height="{s - 2 * i:g}" rx="{g["tile_r"]:g}" fill="{tile}"/>'
            f'<path d="{mark_path(g)}" fill="{ink}"/></svg>\n')


def frame(s, tile=BONE, ink=NAVY):
    g = geometry(s)
    S = s * SS
    k = lambda pts: [(x * SS, y * SS) for x, y in pts]
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    i = g['inset'] * SS
    ImageDraw.Draw(im).rounded_rectangle((i, i, S - i, S - i), radius=g['tile_r'] * SS, fill=tile)
    disc = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(disc)
    cx, cy, r = g['cx'] * SS, g['cy'] * SS, g['r'] * SS
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    d.polygon(k(hole(g, s + 1)), fill=0)
    im.paste(Image.new('RGBA', (S, S), ink), (0, 0), disc)
    return im.resize((s, s), Image.Resampling.BOX)


if __name__ == '__main__':
    for s in SIZES:  # the cut stays inside the disc, symmetric, and on whole pixels where the frame is small
        g = geometry(s)
        assert g['lo'] + g['ro'] == s and g['li'] < g['cx'] - g['ch'] and g['chy'] < g['cy'] + g['r'], s
        assert not g['small'] or all(float(g[k]).is_integer() for k in ('lo', 'li', 'top')), s
    here = Path(__file__).parent
    frames = [frame(s) for s in SIZES]
    out = here / 'icon.ico'
    frames[-1].save(out, sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    frame(256).save(here / 'icon.png')
    (here.parent / 'icon.svg').write_text(tile_svg(32), encoding='utf-8')
    check = Image.open(out)
    print(out, sorted(check.info['sizes']))
