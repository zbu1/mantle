"""Generates icon.svg: an isometric block of strata with a cube cut out of its front-top corner
past its center. A glowing ember core is buried in the rock, and the notch exposes its front-top
corner: a smaller cube nestled in the notch's inner corner.

Each layer boundary is one surface through the block, v = base + amp * (cos 2pi*kA + cos 2pi*kB) / 2,
so it lines up on every face it crosses (outer sides and the notch's walls). A and B are depth
fractions from the front edge toward the left-back and right-back; v is depth below the top face.

Run `python icon.py`, then render with
`pnpm tauri icon src-tauri/icons/demo3/icon.svg -o src-tauri/icons/demo3 -p 32 -p 128 -p 512`.
"""
from math import cos, pi
from pathlib import Path

HEIGHT = 383  # side height, px; equal to the 383px top edge, so the block is a cube
NOTCH = 0.6  # cut-out cube's size, as a fraction of the block's width
NOTCH_DEPTH = NOTCH * 383  # one unit of A/B is a 383px edge on screen, so the cut is a cube
CORE = 0.2  # exposed corner of the core: a cube this size in the notch's inner corner
TOP_Y = 512 + (384 - HEIGHT) / 2  # screen y of the front-top corner, centering the block

# (base v, amplitude) of each boundary: basalt / l1 / l2 / ember. Same amplitude and sign, so
# the waves stay in phase and the layers ripple in parallel.
# The notch floor must land inside one layer (here l2, between b2's max and b3's min).
BOUNDARIES = [(70, 30), (150, 30), (275, 30)]
WAVES = 1.5  # sinusoid periods across each outer face
LIT = ["#3a312b", "#5c3524", "#9e4521", "#e0703a"]
SHADE = ["#2a231f", "#46281b", "#803719", "#c25a2b"]
FLOOR = "#b05a30"  # top of l2, where the notch's floor lands
CORE_TOP, CORE_LIT, CORE_SHADE = "#efb37a", "#d6773f", "#b05628"


def screen(a, b, v):
    return 512 - 332 * a + 332 * b, TOP_Y - 192 * a - 192 * b + v


def boundary(i, a, b):
    base, amp = BOUNDARIES[i]
    return base + amp * (cos(2 * pi * WAVES * a) + cos(2 * pi * WAVES * b)) / 2


def pts(points):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in points)


def face(at, v0, v1, colors, recess=False, n=96):
    """A vertical face; at(t) gives (A, B) for t in [0, 1] along it, v runs v0..v1."""
    ts = [k / n for k in range(n + 1)]
    out = [f'<polygon points="{pts([screen(*at(0), v0), screen(*at(1), v0), screen(*at(1), v1), screen(*at(0), v1)])}" fill="{colors[0]}" />']
    for i in range(len(BOUNDARIES)):
        top = [screen(*at(t), min(max(boundary(i, *at(t)), v0), v1)) for t in ts]
        out.append(f'<polygon points="{pts(top + [screen(*at(1), v1), screen(*at(0), v1)])}" fill="{colors[i + 1]}" />')
    quad = pts([screen(*at(0), v0), screen(*at(1), v0), screen(*at(1), v1), screen(*at(0), v1)])
    out.append(f'<polygon points="{quad}" fill="url(#fade)" />')
    if recess:
        out.append(f'<polygon points="{quad}" fill="#000" fill-opacity="0.1" />')
    return out


s, d = NOTCH, NOTCH_DEPTH
c0, c1 = s - CORE, s
ct = d - CORE * 383  # core top's v
cx, cy = screen(s - CORE / 2, s - CORE / 2, d - CORE * 383 / 2)
notch = pts([screen(s, 0, 0), screen(s, s, 0), screen(0, s, 0), screen(0, s, d), screen(0, 0, d), screen(s, 0, d)])
body = [
    "<!-- Outer left face (lit), outer right face (shade), top. -->",
    *face(lambda t: (1 - t, 0), 0, HEIGHT, LIT),
    *face(lambda t: (0, t), 0, HEIGHT, SHADE),
    f'<polygon points="{pts([screen(1, 1, 0), screen(0, 1, 0), screen(0, 0, 0), screen(1, 0, 0)])}" fill="url(#top)" />',
    "<!-- Notch, painted over the faces it removes: its left wall faces right (shade), its right",
    "     wall faces left (lit), both darkened for sitting in a recess. -->",
    *face(lambda t: (s, t * s), 0, d, SHADE, recess=True),
    *face(lambda t: (s - t * s, s), 0, d, LIT, recess=True),
    f'<polygon points="{pts([screen(0, 0, d), screen(s, 0, d), screen(s, s, d), screen(0, s, d)])}" fill="{FLOOR}" />',
    "<!-- Ember glow from the core onto the notch's walls and floor. -->",
    f'<g clip-path="url(#notch)"><ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="150" ry="110" fill="#ffb066" '
    'fill-opacity="0.2" filter="url(#glow)" /></g>',
    "<!-- Core: shade face, lit face, top, and a highlight on its top's front edges. -->",
    f'<polygon points="{pts([screen(c0, c0, d), screen(c0, c1, d), screen(c0, c1, ct), screen(c0, c0, ct)])}" fill="{CORE_SHADE}" />',
    f'<polygon points="{pts([screen(c1, c0, d), screen(c0, c0, d), screen(c0, c0, ct), screen(c1, c0, ct)])}" fill="{CORE_LIT}" />',
    f'<polygon points="{pts([screen(c0, c0, ct), screen(c1, c0, ct), screen(c1, c1, ct), screen(c0, c1, ct)])}" fill="{CORE_TOP}" />',
    f'<polyline points="{pts([screen(c1, c0, ct), screen(c0, c0, ct), screen(c0, c1, ct)])}" '
    'fill="none" stroke="#fff" stroke-opacity="0.2" stroke-width="3" stroke-linejoin="round" />',
    "<!-- Faint highlight along the top face's front edges. -->",
    f'<polyline points="{pts([screen(1, 0, 0), screen(s, 0, 0), screen(s, s, 0), screen(0, s, 0), screen(0, 1, 0)])}" '
    'fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="4" stroke-linejoin="round" />',
]

svg = f"""<!-- Generated by icon.py; edit that instead. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#54473f" />
      <stop offset="1" stop-color="#42372f" />
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0" />
      <stop offset="1" stop-color="#000" stop-opacity="0.12" />
    </linearGradient>
    <clipPath id="notch">
      <polygon points="{notch}" />
    </clipPath>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="36" />
    </filter>
  </defs>
{chr(10).join("  " + line for line in body)}
</svg>
"""
Path(__file__).with_name("icon.svg").write_text(svg, encoding="utf-8")
