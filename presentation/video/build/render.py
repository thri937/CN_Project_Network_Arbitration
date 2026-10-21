"""Render the explainer: animated scenes + burned-in subtitles, synced to timeline.json.

    python render.py --stills 12.0,30.5      # PNG previews into build/stills/
    python render.py --video                 # full render -> video/explainer.mp4 (+ .srt)

Frames are drawn at 2x and box-filtered down (cheap anti-aliasing), rendered in
parallel chunks, then concatenated and muxed with the narration + sound effects.
"""
import argparse
import json
import math
import subprocess
import sys
import wave
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BUILD = Path(__file__).resolve().parent
VIDEO = BUILD.parent
FONTS = Path("C:/Windows/Fonts")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
W, H, FPS, S = 1920, 1080, 30, 2

sys.path.insert(0, str(BUILD))
from script_data import SCENES  # noqa: E402

TL = json.loads((BUILD / "timeline.json").read_text(encoding="utf-8"))
MK, CUES, DUR = TL["marks"], TL["cues"], TL["duration"]
NFRAMES = int(math.ceil(DUR * FPS))


# ---------------------------------------------------------------- palette & easing

def C(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


INK, PAPER, WHITE = C("#17212F"), C("#FAF7F1"), (255, 255, 255)
BLUE, ORANGE, LORANGE = C("#2F62A8"), C("#D9622B"), C("#F4A259")
CARD_D, CARD_D2, LINE_D, MUTED_D = C("#202D40"), C("#2A3A51"), C("#34465F"), C("#A3AFBF")
LINE_L, MUTED_L = C("#E4DCCD"), C("#646D7A")
BLUE_L, BLUE_M, BLUE_T = C("#86AAE0"), C("#5B8FD6"), C("#DCE6F4")
ORANGE_T, GREEN, GREEN_L, RED = C("#F8E1D3"), C("#2E8A57"), C("#6CC497"), C("#C4402B")
ROAD = C("#26344A")


def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def out3(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def back(x):
    x = clamp(x)
    c = 1.7
    return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2


def mix(a, b, k):
    k = clamp(k)
    return tuple(int(round(a[i] + (b[i] - a[i]) * k)) for i in range(3))


def M(name):
    return MK[name]


def prog(t, name, dur=0.5, delay=0.0):
    return clamp((t - MK[name] - delay) / dur)


def appear(t, start, dur=0.4):
    return smooth((t - start) / dur)


def window(t, start, end, fade=0.3):
    return smooth((t - start) / fade) * smooth((end - t) / fade)


# ---------------------------------------------------------------- drawing

FONT_FILES = {"reg": "segoeui.ttf", "semi": "seguisb.ttf", "bold": "segoeuib.ttf",
              "black": "seguibl.ttf", "emoji": "seguiemj.ttf"}


@lru_cache(maxsize=None)
def font(kind, px):
    return ImageFont.truetype(str(FONTS / FONT_FILES[kind]), max(4, int(round(px))))


@lru_cache(maxsize=None)
def emoji_patch(ch, px):
    f = font("emoji", px)
    im = Image.new("RGBA", (int(px * 1.5), int(px * 1.5)), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((im.width / 2, im.height / 2), ch, font=f, embedded_color=True, anchor="mm")
    return im


@lru_cache(maxsize=256)
def stamp_patch(text, px, color, angle, border):
    f = font("black", px)
    tw = f.getlength(text)
    pad = px * 0.35
    im = Image.new("RGBA", (int(tw + 2 * pad), int(px * 1.5)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([border / 2, border / 2, im.width - border / 2, im.height - border / 2],
                        radius=int(px * 0.25), outline=color + (255,), width=int(border))
    d.text((im.width / 2, im.height / 2), text, font=f, fill=color + (255,), anchor="mm")
    return im.rotate(angle, resample=Image.BICUBIC, expand=True)


class Canvas:
    """2x supersampled RGB canvas. Alpha is faked by mixing toward the colour underneath
    (`on`, default the scene background), which is exact on flat backgrounds."""

    def __init__(self, bg):
        self.bg = bg
        self.im = Image.new("RGB", (W * S, H * S), bg)
        self.d = ImageDraw.Draw(self.im)

    def _c(self, color, a, on):
        return mix(on or self.bg, color, a)

    def rect(self, x, y, w, h, fill=None, r=0, outline=None, width=2, a=1.0, on=None):
        if w <= 0.5 or h <= 0.5 or a <= 0.004:
            return
        box = [x * S, y * S, (x + w) * S - 1, (y + h) * S - 1]
        f = self._c(fill, a, on) if fill is not None else None
        o = self._c(outline, a, on) if outline is not None else None
        rr = int(min(r, w / 2, h / 2) * S)
        wd = int(width * S) if o else 0
        if rr >= 1:
            self.d.rounded_rectangle(box, radius=rr, fill=f, outline=o, width=wd)
        else:
            self.d.rectangle(box, fill=f, outline=o, width=wd)

    def shadow_of(self, on):
        base = on or self.bg
        return mix(base, (0, 0, 0), 0.07 if sum(base) > 400 else 0.35)

    def card(self, x, y, w, h, fill, r=24, a=1.0, on=None, shadow=True, outline=None, width=3):
        if shadow:
            self.rect(x, y + 8, w, h, fill=self.shadow_of(on), r=r, a=a, on=on)
        self.rect(x, y, w, h, fill=fill, r=r, a=a, on=on, outline=outline, width=width)

    def circle(self, cx, cy, rad, fill=None, outline=None, width=3, a=1.0, on=None):
        if rad <= 0.3 or a <= 0.004:
            return
        box = [(cx - rad) * S, (cy - rad) * S, (cx + rad) * S, (cy + rad) * S]
        self.d.ellipse(box, fill=self._c(fill, a, on) if fill is not None else None,
                       outline=self._c(outline, a, on) if outline is not None else None,
                       width=int(width * S) if outline is not None else 0)

    def arc(self, cx, cy, rad, a0, a1, color, width, a=1.0, on=None):
        if a1 - a0 <= 0.2 or a <= 0.004:
            return
        box = [(cx - rad) * S, (cy - rad) * S, (cx + rad) * S, (cy + rad) * S]
        self.d.arc(box, a0, a1, fill=self._c(color, a, on), width=int(width * S))

    def line(self, pts, color, width=3, a=1.0, on=None):
        if a <= 0.004 or len(pts) < 2:
            return
        self.d.line([(x * S, y * S) for x, y in pts], fill=self._c(color, a, on), width=int(width * S),
                    joint="curve")

    def dashed(self, x0, y0, x1, y1, color, width=3, dash=14, gap=10, a=1.0, on=None):
        length = math.hypot(x1 - x0, y1 - y0)
        n = int(length // (dash + gap)) + 1
        for i in range(n):
            s0 = i * (dash + gap) / length
            s1 = min(1.0, (i * (dash + gap) + dash) / length)
            if s0 >= 1:
                break
            self.line([(x0 + (x1 - x0) * s0, y0 + (y1 - y0) * s0), (x0 + (x1 - x0) * s1, y0 + (y1 - y0) * s1)],
                      color, width, a, on)

    def poly(self, pts, fill, a=1.0, on=None):
        if a <= 0.004:
            return
        self.d.polygon([(x * S, y * S) for x, y in pts], fill=self._c(fill, a, on))

    def text(self, x, y, s, kind, px, color, anchor="la", a=1.0, on=None):
        if a <= 0.004 or not s:
            return
        self.d.text((x * S, y * S), s, font=font(kind, px * S), fill=self._c(color, a, on), anchor=anchor)

    def tw(self, s, kind, px):
        return font(kind, px * S).getlength(s) / S

    def rich(self, x, y, parts, px, align="l", a=1.0, on=None):
        """Baseline-aligned runs of (text, kind, color). align: l / m / r around x."""
        total = sum(self.tw(s, k, px) for s, k, _ in parts)
        cx = x - (total / 2 if align == "m" else total if align == "r" else 0)
        for s, k, col in parts:
            self.text(cx, y, s, k, px, col, anchor="ls", a=a, on=on)
            cx += self.tw(s, k, px)
        return total

    def wrap(self, s, kind, px, maxw):
        lines, cur = [], ""
        for word in s.split():
            trial = (cur + " " + word).strip()
            if cur and self.tw(trial, kind, px) > maxw:
                lines.append(cur)
                cur = word
            else:
                cur = trial
        if cur:
            lines.append(cur)
        return lines

    def para(self, x, y, s, kind, px, color, maxw, lh=1.3, a=1.0, on=None, anchor="ls"):
        lines = self.wrap(s, kind, px, maxw)
        for i, ln in enumerate(lines):
            self.text(x, y + i * px * lh, ln, kind, px, color, anchor=anchor, a=a, on=on)
        return len(lines)

    def emoji(self, cx, cy, ch, px, a=1.0):
        if a <= 0.004:
            return
        patch = emoji_patch(ch, int(px * S))
        mask = patch.getchannel("A")
        if a < 0.999:
            mask = mask.point(lambda v: int(v * a))
        self.im.paste(patch, (int(cx * S - patch.width / 2), int(cy * S - patch.height / 2)), mask)

    def stamp(self, cx, cy, text, px, color, angle=-8, a=1.0, scale=1.0):
        if a <= 0.004:
            return
        patch = stamp_patch(text, int(px * scale * S), color, angle, max(2, int(6 * scale * S)))
        mask = patch.getchannel("A")
        if a < 0.999:
            mask = mask.point(lambda v: int(v * a))
        self.im.paste(patch, (int(cx * S - patch.width / 2), int(cy * S - patch.height / 2)), mask)

    def pill(self, x, y, s, px, fill, color, kind="bold", padx=20, h=None, a=1.0, on=None, align="l",
             icon=None, outline=None):
        h = h or px * 1.9
        iw = px * 1.25 if icon else 0
        w = self.tw(s, kind, px) + 2 * padx + iw
        if align == "r":
            x -= w
        elif align == "m":
            x -= w / 2
        self.rect(x, y, w, h, fill=fill, r=h / 2, a=a, on=on, outline=outline, width=2)
        if icon:
            self.emoji(x + padx + px * 0.5, y + h / 2, icon, px * 0.95, a=a)
        self.text(x + padx + iw, y + h / 2, s, kind, px, color, anchor="lm", a=a,
                  on=fill if fill is not None else on)
        return w

    def check(self, cx, cy, size, color, width=4, a=1.0, on=None):
        self.line([(cx - size * 0.5, cy), (cx - size * 0.15, cy + size * 0.35), (cx + size * 0.55, cy - size * 0.4)],
                  color, width, a, on)

    def hatch(self, x, y, w, h, color, a=1.0, on=None, step=14, width=4):
        """Diagonal stripes clipped to a box (marks capacity that was cut or reserved)."""
        if w <= 1 or h <= 1:
            return
        for k in range(-int(h), int(w), step):
            x0, y0, x1, y1 = x + k, y + h, x + k + h, y
            if x0 < x:
                y0 -= x - x0
                x0 = x
            if x1 > x + w:
                y1 += x1 - (x + w)
                x1 = x + w
            if x1 > x0:
                self.line([(x0, y0), (x1, y1)], color, width, a, on)

    def finish(self):
        return self.im.reduce(S)


def rise(t, start, dist=26, dur=0.45):
    """(alpha, y-offset) for a fade-and-rise entrance."""
    k = out3((t - start) / dur)
    return smooth((t - start) / (dur * 0.8)), (1 - k) * dist


# ---------------------------------------------------------------- chrome

CHAPTERS = [(s["id"], s["chapter"]) for s in SCENES if s["chapter"]]
DARK_SCENES = {"hook", "loop", "new", "close"}


def chrome(c, t, sid):
    dark = sid in DARK_SCENES
    c.rect(0, 0, W, 8, fill=LINE_D if dark else LINE_L)
    c.rect(0, 0, W * clamp(t / DUR), 8, fill=ORANGE)
    for cid, _ in CHAPTERS:
        x = W * TL["scenes"][cid]["start"] / DUR
        c.rect(x - 2, 0, 4, 8, fill=c.bg)
    names = dict(CHAPTERS)
    if sid in names:
        n = [cid for cid, _ in CHAPTERS].index(sid) + 1
        c.circle(84, 52, 22, fill=ORANGE)
        c.text(84, 52, str(n), "bold", 24, WHITE, anchor="mm", on=ORANGE)
        c.text(118, 52, names[sid], "semi", 26, WHITE if dark else INK, anchor="lm")
        c.text(118 + c.tw(names[sid], "semi", 26) + 14, 52, f"{n} of {len(CHAPTERS)}", "reg", 22,
               MUTED_D if dark else MUTED_L, anchor="lm")


# ---------------------------------------------------------------- scene: hook

CAR_TYPES = [("🏭", "Factory", BLUE_M), ("🏥", "Clinic", GREEN_L), ("💼", "Office", BLUE_L),
             ("🍽", "Canteen", ORANGE), ("📹", "CCTV", C("#A08BD0")), ("📦", "Warehouse", LORANGE),
             ("🔬", "Lab", C("#5FB7C9"))]
ROAD_Y, ROAD_H, LANE_H = 380, 270, 90
CAR_W, CAR_H, CAR_V = 200, 58, 520
STOP_X, EASE_D = 1650, 130


def build_cars():
    rush, jam = M("rush"), M("rush") + 0.1
    cars = [{"enter": -4.0 + k * 0.55, "lane": k % 3, "kind": k % 7} for k in range(10)]
    cars += [{"enter": rush - 3.4 + k * 0.2, "lane": k % 3, "kind": (k * 3 + 2) % 7} for k in range(36)]
    for lane in range(3):
        slot = 0
        for car in sorted((c for c in cars if c["lane"] == lane), key=lambda c: c["enter"]):
            free_at_jam = -CAR_W + CAR_V * (jam - car["enter"])
            target = STOP_X - CAR_W - slot * (CAR_W + 16)
            if free_at_jam < target - EASE_D:
                car["slot"] = target
                slot += 1
    return cars, jam


CARS, JAM = build_cars()


def car_x(car, t):
    free = -CAR_W + CAR_V * (t - car["enter"])
    if t < JAM or "slot" not in car:
        return free
    target = car["slot"]
    if free < target - EASE_D:
        return free
    return target - EASE_D * math.exp(-(free - (target - EASE_D)) / EASE_D)


def scene_hook(t):
    c = Canvas(INK)
    q0 = M("h4")
    road_a = 1 - smooth((t - (q0 - 0.2)) / 0.5)
    if road_a > 0:
        a = road_a
        c.text(80, 112, "NETWORK ARBITRATION", "bold", 24, LORANGE, anchor="ls", a=a * appear(t, 0.2))
        c.text(80 + c.tw("NETWORK ARBITRATION", "bold", 24) + 16, 112, "explained in 3 minutes", "reg", 24,
               MUTED_D, anchor="ls", a=a * appear(t, 0.4))
        rw = W * out3((t - 0.1) / 1.1)
        c.rect(0, ROAD_Y, rw, ROAD_H, fill=ROAD, a=a)
        c.rect(0, ROAD_Y, rw, 5, fill=LINE_D, a=a)
        c.rect(0, ROAD_Y + ROAD_H - 5, rw, 5, fill=LINE_D, a=a)
        for k in (1, 2):
            y = ROAD_Y + k * LANE_H
            for x in range(0, int(rw), 110):
                c.rect(x + 20, y - 3, 60, 6, fill=LORANGE, a=a * 0.45, on=ROAD)
        # the shared link is full: a barrier at the end of the road
        ba = a * appear(t, JAM, 0.4)
        if ba > 0:
            flash = 0.6 + 0.4 * math.sin(t * 9) if t > M("h3") else 1.0
            c.rect(STOP_X + 6, ROAD_Y - 30, 34, ROAD_H + 60, fill=ORANGE, r=8, a=ba * flash)
            for k in range(6):
                c.rect(STOP_X + 6, ROAD_Y - 10 + k * 52, 34, 18, fill=WHITE, a=ba * flash, on=ORANGE)
            c.text(STOP_X + 23, ROAD_Y - 52, "LINK FULL", "black", 28, ORANGE, anchor="ms", a=ba)
        for car in CARS:
            x = car_x(car, t)
            if x < -CAR_W or x > W:
                continue
            emo, label, col = CAR_TYPES[car["kind"]]
            y = ROAD_Y + car["lane"] * LANE_H + (LANE_H - CAR_H) / 2
            c.rect(x, y, CAR_W, CAR_H, fill=WHITE, r=16, a=a, on=ROAD)
            c.rect(x, y, 12, CAR_H, fill=col, r=6, a=a, on=WHITE)
            c.emoji(x + 40, y + CAR_H / 2, emo, 30, a=a)
            c.text(x + 64, y + CAR_H / 2, label, "semi", 24, INK, anchor="lm", a=a, on=WHITE)
        # Monday 9 a.m.
        ka, dy = rise(t, M("h2") + 0.2)
        if ka > 0:
            ka *= a
            c.card(1440, 150 + dy, 400, 120, CARD_D, a=ka)
            c.emoji(1510, 210 + dy, "🕘", 58, a=ka)
            c.text(1565, 196 + dy, "Lunch hour", "semi", 26, MUTED_D, anchor="ls", a=ka, on=CARD_D)
            c.text(1565, 246 + dy, "12:30 p.m.", "black", 46, WHITE, anchor="ls", a=ka, on=CARD_D)
        ka, dy = rise(t, M("h3"))
        if ka > 0:
            ka *= a
            c.text(W / 2 - 160, 735 + dy, "Something has to slow down.", "black", 64, WHITE, anchor="ms", a=ka)
            uw = c.tw("Something has to slow down.", "black", 64) * out3((t - M("h3") - 0.3) / 0.6)
            c.rect(W / 2 - 160 - c.tw("Something has to slow down.", "black", 64) / 2, 760 + dy, uw, 8,
                   fill=ORANGE, r=4, a=ka)
    qa = appear(t, q0 - 0.1, 0.5)
    if qa > 0:
        c.rich(W / 2, 215, [("Who would ", "black", WHITE), ("YOU", "black", LORANGE),
                            (" slow down?", "black", WHITE)], 84, align="m", a=qa)
        options = [("🏭", "Factory line", "makes the product"), ("🏥", "Patient monitors", "watch over patients"),
                   ("💼", "Office Wi-Fi", "email and calls"), ("🍽", "Canteen screens", "show the lunch menu")]
        cw, gap = 370, 36
        x0 = (W - (4 * cw + 3 * gap)) / 2
        cd0 = M("h4_end") - 0.2
        for i, (emo, label, hint) in enumerate(options):
            ka, dy = rise(t, q0 + 0.25 + i * 0.18, 40)
            if ka <= 0:
                continue
            x, y = x0 + i * (cw + gap), 290 + dy
            pulse = 0.35 + 0.35 * math.sin((t - cd0) * 2 * math.pi) if cd0 < t < cd0 + 3 else 0
            c.card(x, y, cw, 250, CARD_D, r=28, a=ka, outline=mix(CARD_D, LORANGE, pulse) if pulse else None)
            c.emoji(x + cw / 2, y + 88, emo, 92, a=ka)
            c.text(x + cw / 2, y + 180, label, "bold", 36, WHITE, anchor="ms", a=ka, on=CARD_D)
            c.text(x + cw / 2, y + 220, hint, "reg", 24, MUTED_D, anchor="ms", a=ka, on=CARD_D)
        # 3-2-1 countdown, then "hold that thought"
        if cd0 < t < cd0 + 3.0:
            k = int(t - cd0)
            frac = (t - cd0) - k
            ra = appear(t, cd0, 0.3)
            c.circle(W / 2, 690, 60, outline=LINE_D, width=10, a=ra)
            c.arc(W / 2, 690, 60, -90, -90 + 360 * (1 - frac), ORANGE, 10, a=ra)
            c.text(W / 2, 690, str(3 - k), "black", 64, WHITE, anchor="mm", a=ra)
            c.text(W / 2, 790, "Pick one…", "semi", 30, MUTED_D, anchor="ms", a=ra)
        ha = appear(t, cd0 + 3.0, 0.35)
        if ha > 0:
            c.text(W / 2, 705, "Hold that thought —", "black", 46, LORANGE, anchor="ms", a=ha)
            c.text(W / 2, 760, "we'll check your answer later.", "semi", 34, WHITE, anchor="ms", a=ha)
    chrome(c, t, "hook")
    return c


# ---------------------------------------------------------------- scene: problem

SLICES = [("Patient Telemetry", "Clinic", 96.0), ("Factory Automation", "Factory", 81.7),
          ("Lab Instrumentation", "Quality lab", 70.9), ("Warehouse Operations", "Warehouse", 59.1),
          ("CCTV", "Security", 48.8), ("Office Wi-Fi", "Office IT", 43.4),
          ("Canteen Signage", "Canteen", 8.0)]


def lane_color(i):
    if i == 0:
        return BLUE
    if i == len(SLICES) - 1:
        return ORANGE
    return BLUE_M if i % 2 else C("#4E7DC0")


def header(c, t, start, title, sub, a=1.0, dark=False):
    ka, dy = rise(t, start, 18)
    ka *= a
    c.text(120, 160 + dy, title, "black", 58, WHITE if dark else INK, anchor="ls", a=ka)
    if sub:
        c.text(120, 206 + dy, sub, "reg", 30, MUTED_D if dark else MUTED_L, anchor="ls", a=ka)


def scene_problem(t):
    c = Canvas(PAPER)
    a_lanes = 1 - smooth((t - (M("p3") - 0.35)) / 0.4)
    a_cap = smooth((t - (M("p3") - 0.15)) / 0.4) * (1 - smooth((t - (M("p5") - 0.35)) / 0.4))
    a_lab = smooth((t - (M("p5") - 0.15)) / 0.4)

    if a_lanes > 0:
        a = a_lanes
        header(c, t, M("p1") - 0.3, "Network slicing", "one network, split into reserved virtual lanes", a)
        chips = [(M("p2") + 0.9, "7", "departments"), (M("nine"), "7", "slices"), (M("link"), "1 Mbps", "shared link")]
        for i, (st, big, small) in enumerate(chips):
            ka, dy = rise(t, st)
            ka *= a
            x = 1060 + i * 260
            c.card(x, 96 + dy, 240, 116, WHITE, r=20, a=ka)
            c.text(x + 24, 158 + dy, big, "black", 46, BLUE if i < 2 else ORANGE, anchor="ls", a=ka, on=WHITE)
            c.text(x + 24, 192 + dy, small, "semi", 22, MUTED_L, anchor="ls", a=ka, on=WHITE)
        pa = a * appear(t, M("p1") + 0.1, 0.5)
        if pa > 0:
            split = smooth((t - (M("p1") + 1.3)) / 1.1)
            x0, w = 120, 1680
            c.card(x0, 252, w, 590, WHITE, r=30, a=pa)
            lh, gap = 60, 12 * split
            total = len(SLICES) * lh + (len(SLICES) - 1) * gap
            y0 = 252 + (590 - total) / 2
            for i, (name, dept, _) in enumerate(SLICES):
                y = y0 + i * (lh + gap)
                col = mix(BLUE, lane_color(i), split)
                c.rect(x0 + 30, y, w - 60, lh, fill=col, r=12 * split, a=pa, on=WHITE)
                speed = 160 + (i * 37) % 120
                off = (t * speed) % 140
                for k in range(-1, 12):
                    xx = x0 + 300 + k * 140 + off
                    if x0 + 420 < xx < x0 + w - 260:
                        c.rect(xx, y + lh / 2 - 3, 34, 6, fill=WHITE, r=3, a=pa * 0.35 * split, on=col)
                la = pa * smooth((t - (M("p1") + 1.6 + i * 0.12)) / 0.4)
                c.text(x0 + 56, y + lh / 2, name, "semi", 26, WHITE, anchor="lm", a=la, on=col)
                c.text(x0 + w - 56, y + lh / 2, dept, "reg", 22, WHITE, anchor="rm", a=la * 0.85, on=col)
            if split < 0.5:
                c.text(x0 + w / 2, 252 + 295, "ONE NETWORK", "black", 44, WHITE, anchor="mm",
                       a=pa * (1 - split * 2), on=BLUE)

    if a_cap > 0:
        a = a_cap
        header(c, t, M("p3") - 0.15, "Capacity vs. promises", "what the link can carry — and what was promised", a)
        X0, PX = 400, 92
        lim = X0 + 9.5 * PX
        # row 1: the link
        c.text(120, 318, "The link", "bold", 32, INK, anchor="ls", a=a)
        c.text(120, 352, "1 Mbps", "reg", 26, MUTED_L, anchor="ls", a=a)
        g = out3((t - M("p3")) / 0.7)
        c.rect(X0, 286, 10 * PX * g, 80, fill=BLUE, r=14, a=a)
        ua = a * appear(t, M("usable") + 0.3, 0.5)
        if ua > 0:
            c.rect(lim, 286, 0.5 * PX, 80, fill=C("#B9C3CF"), r=0, a=ua)
            c.hatch(lim, 286, 0.5 * PX, 80, C("#8E99A6"), a=ua, step=12, width=3)
            c.text(X0 + 26, 326, "950 kbps usable", "bold", 32, WHITE, anchor="lm", a=ua, on=BLUE)
            c.text(lim + 0.5 * PX + 18, 326, "50 kbps kept in reserve", "semi", 24, MUTED_L, anchor="lm", a=ua)
        # row 2: promised
        c.text(120, 458, "Promised", "bold", 32, INK, anchor="ls", a=a * appear(t, M("promised") - 0.2))
        c.text(120, 492, "to all 7 slices", "reg", 26, MUTED_L, anchor="ls", a=a * appear(t, M("promised") - 0.2))
        pg = out3((t - M("promised")) / 1.3)
        pw = 14.8 * PX * pg
        c.rect(X0, 426, pw, 80, fill=ORANGE, r=14, a=a)
        if X0 + pw > lim:
            c.hatch(lim, 426, X0 + pw - lim, 80, C("#B84E1E"), a=a, step=16, width=5)
        c.text(X0 + 26, 466, "1,480 kbps", "bold", 32, WHITE, anchor="lm", a=a * appear(t, M("promised") + 0.4),
               on=ORANGE)
        oa = a * appear(t, M("promised") + 1.2)
        c.text(lim + (X0 + 14.8 * PX - lim) / 2, 540, "more than the link can carry", "bold", 26, ORANGE,
               anchor="ms", a=oa)
        la = a * appear(t, M("usable") + 0.2)
        c.dashed(lim, 262, lim, 520, INK, width=3, a=la)
        c.text(lim, 252, "usable limit", "semi", 22, INK, anchor="ms", a=la)
        # gym analogy
        ga = a * appear(t, M("p4") - 0.1)
        if ga > 0:
            c.card(120, 590, 1680, 250, WHITE, r=28, a=ga)
            c.text(170, 660, "Like a gym", "black", 40, INK, anchor="ls", a=ga, on=WHITE)
            c.para(170, 708, "selling more memberships than it has machines. Fine most days —"
                   " until everyone turns up at once.", "reg", 26, MUTED_L, 560, a=ga, on=WHITE)
            c.text(800, 652, "members", "semi", 22, MUTED_L, anchor="ls", a=ga, on=WHITE)
            for k in range(16):
                pa = ga * appear(t, M("p4") + 0.2 + k * 0.06, 0.25)
                px = 800 + k * 60
                c.circle(px + 18, 684, 12, fill=BLUE_M, a=pa, on=WHITE)
                c.rect(px + 4, 700, 28, 34, fill=BLUE_M, r=12, a=pa, on=WHITE)
            c.text(800, 770, "machines", "semi", 22, MUTED_L, anchor="ls", a=ga, on=WHITE)
            for k in range(4):
                pa = ga * appear(t, M("p4") + 1.3 + k * 0.12, 0.25)
                mx = 800 + k * 120
                c.rect(mx, 784, 96, 36, fill=INK, r=10, a=pa, on=WHITE)
                c.rect(mx + 14, 799, 68, 6, fill=LORANGE, r=3, a=pa, on=INK)

    if a_lab > 0:
        a = a_lab
        header(c, t, M("p5") - 0.15, "How normal networks decide", "technical labels, set at install time", a)
        cards = [("🍽", "Canteen menu screens", "shows today's lunch menu", "URLLC · PREMIUM", ORANGE, M("p6") + 0.3),
                 ("🔬", "Quality lab", "regulated quality testing", "eMBB · STANDARD", C("#8B95A2"), M("standard"))]
        for i, (emo, name, desc, tag, tagc, tag_t) in enumerate(cards):
            x, y, w = 160 + i * 840, 250, 760
            ka, dy = rise(t, M("p5") + 0.4 + i * 0.25)
            ka *= a
            if ka <= 0:
                continue
            y += dy
            c.card(x, y, w, 560, WHITE, r=30, a=ka)
            c.emoji(x + 96, y + 104, emo, 86, a=ka)
            c.text(x + 170, y + 104, name, "black", 42, INK, anchor="ls", a=ka, on=WHITE)
            c.text(x + 170, y + 144, desc, "reg", 26, MUTED_L, anchor="ls", a=ka, on=WHITE)
            ta = ka * appear(t, tag_t, 0.3)
            tscale = back((t - tag_t) / 0.45)
            if ta > 0:
                c.text(x + 60, y + 228, "network label:", "semi", 24, MUTED_L, anchor="ls", a=ta, on=WHITE)
                c.pill(x + 250, y + 192, tag, 30 * (0.7 + 0.3 * tscale), tagc, WHITE, kind="black", a=ta, on=WHITE,
                       icon="🏷", h=58)
            c.text(x + 60, y + 330, "network speed", "semi", 24, MUTED_L, anchor="ls", a=ka, on=WHITE)
            c.rect(x + 60, y + 350, 640, 60, fill=LINE_L, r=14, a=ka, on=WHITE)
            if i == 1:
                shrink = out3((t - M("p7") - 0.2) / 1.0)
                fw = 640 * (1 - 0.7 * shrink)
                col = mix(BLUE_M, RED, shrink)
                c.rect(x + 60, y + 350, fw, 60, fill=col, r=14, a=ka, on=WHITE)
                sa = ka * appear(t, M("p7") + 0.7)
                c.emoji(x + 84, y + 456, "🐢", 44, a=sa)
                c.text(x + 120, y + 470, "SLOWED DOWN", "black", 38, RED, anchor="ls", a=sa, on=WHITE)
            else:
                c.rect(x + 60, y + 350, 640, 60, fill=BLUE_M, r=14, a=ka, on=WHITE)
                sa = ka * appear(t, M("lunch"))
                c.emoji(x + 82, y + 456, "🛡", 40, a=sa)
                c.text(x + 112, y + 470, "PROTECTED", "black", 38, BLUE, anchor="ls", a=sa, on=WHITE)
        st = M("lunch") + 0.55
        sa = a * appear(t, st, 0.15)
        if sa > 0:
            c.stamp(1480, 150, "WRONG CALL!", 64, RED, angle=-6, a=sa, scale=1 + 0.5 * (1 - out3((t - st) / 0.3)))
    chrome(c, t, "problem")
    return c


# ---------------------------------------------------------------- scene: solution

QUESTIONS = [("How critical is it?", "Clinic: mission critical · Canteen: nice to have", "q1"),
             ("What does a minute of outage cost?", "Factory line £8,400 · Canteen £15", "q2"),
             ("Any legal or safety rules?", "Clinic: life-safety — never touched", "q3"),
             ("Do customers notice?", "severely · indirectly · not at all", "q4"),
             ("How long can it cope?", "seconds · minutes · hours", "q5"),
             ("Was it slowed recently?", "then spread the pain around", "q6")]


def scene_solution(t):
    c = Canvas(PAPER)
    s1 = M("s1")
    ka, dy = rise(t, s1 - 0.2, 18)
    x = 120
    w1 = c.tw("Technical labels", "black", 56)
    c.text(x, 165 + dy, "Technical labels", "black", 56, MUTED_L, anchor="ls", a=ka)
    sk = out3((t - s1 - 0.7) / 0.5)
    c.rect(x - 6, 142 + dy, (w1 + 12) * sk, 7, fill=RED, r=3, a=ka)
    ba, bdy = rise(t, s1 + 1.1, 18)
    c.text(x + w1 + 30, 165 + bdy, "→", "black", 56, ORANGE, anchor="ls", a=ba)
    c.text(x + w1 + 110, 165 + bdy, "Business questions", "black", 56, BLUE, anchor="ls", a=ba)

    ov = window(t, M("s3") - 0.15, M("s4") - 0.1, 0.35)
    dim = 1 - 0.8 * ov
    cw, ch = 540, 190
    for i, (q, ex, mk) in enumerate(QUESTIONS):
        col, row = i % 3, i // 3
        x, y = 120 + col * (cw + 30), 255 + row * (ch + 30)
        ka, dy = rise(t, M(mk) - 0.1, 30)
        ka *= dim
        if ka <= 0:
            continue
        y += dy
        c.card(x, y, cw, ch, WHITE, r=24, a=ka)
        c.circle(x + 50, y + 56, 26, fill=ORANGE, a=ka, on=WHITE)
        c.text(x + 50, y + 56, str(i + 1), "bold", 28, WHITE, anchor="mm", a=ka, on=ORANGE)
        n = c.para(x + 92, y + 66, q, "bold", 32, INK, cw - 120, lh=1.2, a=ka, on=WHITE)
        c.text(x + 92, y + 66 + n * 38 + 18, ex, "reg", 22, MUTED_L, anchor="ls", a=ka, on=WHITE)
    if ov > 0:
        x, y, w, h = 230, 250, 1460, 520
        c.card(x, y, w, h, WHITE, r=32, a=ov)
        c.text(x + 60, y + 86, "What does one minute of outage cost?", "black", 42, INK, anchor="ls", a=ov, on=WHITE)
        rows = [("🏭", "Factory line", 8400, "£8,400", BLUE, M("s3") + 0.3),
                ("🍽", "Canteen screens", 15, "£15", ORANGE, M("canteen15"))]
        for i, (emo, name, val, label, col, st) in enumerate(rows):
            ra = ov * appear(t, st, 0.35)
            yy = y + 190 + i * 150
            c.emoji(x + 96, yy, emo, 64, a=ra)
            c.text(x + 150, yy, name, "bold", 34, INK, anchor="lm", a=ra, on=WHITE)
            bw = max(8, 700 * val / 8400) * out3((t - st) / 0.9)
            c.rect(x + 470, yy - 32, bw, 64, fill=col, r=12, a=ra, on=WHITE)
            c.text(x + 470 + bw + 24, yy, label, "black", 54, col, anchor="lm", a=ra, on=WHITE)
        c.text(x + 60, y + h - 50, "per minute that the department is down", "reg", 26, MUTED_L, anchor="ls",
               a=ov, on=WHITE)
    chrome(c, t, "solution")
    return c


# ---------------------------------------------------------------- scene: the 7-step loop

STEPS = ["Measure", "Detect", "Score", "Decide", "Apply", "Restore", "Record"]
STEP_CUES = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"]
STEP_DESC = ["traffic · delay · lost data — for every slice",
             "is demand above 102% of capacity, twice in a row?",
             "a business score from 0 to 100 for every slice",
             "many small cuts beat one big cut",
             "the new speed limits go live",
             "bandwidth comes back after a recovery window",
             "a permanent explanation of every decision"]
LOOP_C, LOOP_R = (390, 545), 205
PANEL = (720, 190, 1120, 660)


def step_at(t):
    k = 0
    for i, cue in enumerate(STEP_CUES):
        if t >= M(cue) - 0.15:
            k = i + 1
    return k


def step_alpha(t, k):
    start = M(STEP_CUES[k - 1]) - 0.15
    end = M(STEP_CUES[k]) - 0.15 if k < 7 else 1e9
    return smooth((t - start) / 0.35) * smooth((end - t) / 0.25)


def draw_tracker(c, t, cur):
    x0, y, gap = 120, 96, 14
    w = (1680 - 6 * gap) / 7
    ta = appear(t, M("l0") - 0.2)
    for i, name in enumerate(STEPS):
        k = i + 1
        x = x0 + i * (w + gap)
        if k == cur:
            fill, fg, numc = ORANGE, WHITE, WHITE
        elif k < cur:
            fill, fg, numc = BLUE, WHITE, WHITE
        else:
            fill, fg, numc = CARD_D, MUTED_D, MUTED_D
        a = ta * appear(t, M("l0") + i * 0.12, 0.3)
        c.rect(x, y, w, 56, fill=fill, r=28, a=a)
        c.circle(x + 30, y + 28, 17, fill=mix(fill, WHITE, 0.22), a=a)
        c.text(x + 30, y + 28, str(k), "bold", 20, numc, anchor="mm", a=a, on=mix(fill, WHITE, 0.22))
        c.text(x + 58, y + 28, name, "semi", 24, fg, anchor="lm", a=a, on=fill)


def draw_loop(c, t, cur):
    cx, cy = LOOP_C
    grow = out3((t - M("l0")) / 1.2)
    c.arc(cx, cy, LOOP_R, -90, -90 + 360 * grow, LINE_D, 8)
    ang = (t * 180) % 360
    c.arc(cx, cy, LOOP_R, ang - 90 - 60, ang - 90, LORANGE, 8, a=0.55 * grow)
    dx, dy = math.cos(math.radians(ang - 90)), math.sin(math.radians(ang - 90))
    c.circle(cx + LOOP_R * dx, cy + LOOP_R * dy, 11, fill=LORANGE, a=grow)
    c.text(cx, cy - 46, "every", "semi", 28, MUTED_D, anchor="ms", a=grow)
    c.text(cx, cy + 30, "2 s", "black", 84, WHITE, anchor="ms", a=grow)
    for i in range(7):
        k = i + 1
        th = math.radians(-90 + i * 360 / 7)
        nx, ny = cx + LOOP_R * math.cos(th), cy + LOOP_R * math.sin(th)
        a = appear(t, M("l0") + 0.2 + i * 0.12, 0.3)
        if k == cur:
            since = t - (M(STEP_CUES[i]) - 0.15)
            r = 36 + 8 * back(since / 0.4) - 8 * clamp(since / 0.4) + 3 * math.sin(t * 5)
            c.circle(nx, ny, r + 12, fill=mix(INK, ORANGE, 0.35), a=a)
            c.circle(nx, ny, r, fill=ORANGE, a=a)
            c.text(nx, ny, str(k), "black", 30, WHITE, anchor="mm", a=a, on=ORANGE)
        else:
            fill = BLUE if k < cur else CARD_D2
            c.circle(nx, ny, 32, fill=fill, a=a)
            c.text(nx, ny, str(k), "bold", 26, WHITE if k < cur else MUTED_D, anchor="mm", a=a, on=fill)


def panel_head(c, t, k, a):
    x, y = PANEL[0] + 50, PANEL[1]
    c.text(x, y + 66, f"STEP {k}", "black", 24, LORANGE, anchor="ls", a=a, on=CARD_D)
    c.text(x, y + 124, STEPS[k - 1], "black", 56, WHITE, anchor="ls", a=a, on=CARD_D)
    c.text(x, y + 170, STEP_DESC[k - 1], "reg", 28, MUTED_D, anchor="ls", a=a, on=CARD_D)


def step_measure(c, t, a):
    rows = [("Traffic", "how much data", LORANGE, lambda x, t: 0.55 + 0.25 * math.sin(x * 0.9 + t * 2.1)
             + 0.1 * math.sin(x * 2.3 + t * 3.1)),
            ("Delay", "how long it takes", BLUE_L, lambda x, t: 0.45 + 0.18 * math.sin(x * 1.3 - t * 1.6)
             + 0.08 * math.sin(x * 3.7 + t * 2.0)),
            ("Lost data", "what never arrives", C("#E58F70"), lambda x, t: 0.12 + 0.55 * max(0.0, math.sin(x * 0.8 + t * 1.3)) ** 6)]
    reveal = out3((t - M("l1") - 0.1) / 0.9)
    for i, (name, sub, col, fn) in enumerate(rows):
        y = 470 + i * 125
        ra = a * appear(t, M("l1") + i * 0.15, 0.35)
        c.text(770, y, name, "bold", 32, WHITE, anchor="ls", a=ra, on=CARD_D)
        c.text(770, y + 32, sub, "reg", 22, MUTED_D, anchor="ls", a=ra, on=CARD_D)
        x0, x1, base, hgt = 1040, 1770, y + 40, 90
        c.rect(x0, base, x1 - x0, 2, fill=LINE_D, a=ra, on=CARD_D)
        n = 64
        pts = []
        for j in range(int(n * reveal) + 1):
            u = j / n
            pts.append((x0 + u * (x1 - x0), base - hgt * clamp(fn(u * 10, t), 0.02, 1.0)))
        c.line(pts, col, 4, a=ra, on=CARD_D)
        if pts and reveal > 0.98:
            c.circle(pts[-1][0], pts[-1][1], 7 + 2 * math.sin(t * 6), fill=col, a=ra, on=CARD_D)


DETECT_VALS = [91, 94, 106, 95, 96, 98, 100, 104, 107, 108, 105, 99, 97, 96]


def step_detect(c, t, a):
    x0, x1, y0, y1 = 830, 1760, 430, 800
    vy = lambda v: y1 - (v - 86) / (112 - 86) * (y1 - y0)  # noqa: E731
    c.text(x0, y0 - 8, "demand, as % of capacity", "semi", 22, MUTED_D, anchor="ls", a=a, on=CARD_D)
    c.rect(x0, y1, x1 - x0, 2, fill=LINE_D, a=a, on=CARD_D)
    c.text(x1, y1 + 30, "readings, every 2 s →", "reg", 20, MUTED_D, anchor="rs", a=a, on=CARD_D)
    ty = vy(102)
    c.dashed(x0, ty, x1, ty, LORANGE, width=3, a=a, on=CARD_D)
    c.text(x0 - 12, ty, "102%", "black", 24, LORANGE, anchor="rm", a=a, on=CARD_D)
    l2, tr, sp = M("l2"), M("tworeads"), M("spike")
    times = [l2 + 0.4 + i * (tr - 0.1 - l2 - 0.4) / 8 for i in range(9)]
    times += [tr + 0.3 + i * (sp - 0.1 - tr - 0.3) / 4 for i in range(5)]
    xs = [x0 + 50 + i * 66 for i in range(len(DETECT_VALS))]
    shown = [i for i in range(len(DETECT_VALS)) if t >= times[i]]
    if len(shown) > 1:
        c.line([(xs[i], vy(DETECT_VALS[i])) for i in shown], MUTED_D, 3, a=a * 0.8, on=CARD_D)
    for i in shown:
        v = DETECT_VALS[i]
        da = a * appear(t, times[i], 0.2)
        col = ORANGE if v > 102 else (GREEN_L if i >= 11 else BLUE_L)
        if i in (7, 8) and t >= tr:
            c.circle(xs[i], vy(v), 22 + 3 * math.sin(t * 6), fill=mix(CARD_D, ORANGE, 0.35), a=da, on=CARD_D)
        c.circle(xs[i], vy(v), 10, fill=col, a=da, on=CARD_D)
    ca = a * appear(t, tr, 0.3)
    if ca > 0:
        for n, i in enumerate((7, 8)):
            c.text(xs[i], vy(DETECT_VALS[i]) - 34, str(n + 1), "black", 26, LORANGE, anchor="ms", a=ca, on=CARD_D)
        c.pill(1790, 226, "Congestion detected!", 26, ORANGE, WHITE, kind="black", a=ca, on=CARD_D, h=52,
               icon="🚨", align="r")
    sa = a * appear(t, sp, 0.3)
    if sa > 0:
        i = 2
        c.circle(xs[i], vy(DETECT_VALS[i]), 24, outline=MUTED_D, width=3, a=sa, on=CARD_D)
        c.text(xs[i], vy(DETECT_VALS[i]) - 40, "1 spike: ignored", "bold", 22, WHITE, anchor="ms", a=sa, on=CARD_D)
    qa = a * appear(t, sp + 0.6, 0.3)
    if qa > 0:
        c.text((xs[11] + xs[13]) / 2, vy(96) + 52, "3 calm readings: over", "bold", 22, GREEN_L, anchor="ms",
               a=qa, on=CARD_D)


def step_score(c, t, a):
    for i, (name, dept, score) in enumerate(SLICES):
        y = 422 + i * 46
        st = M("l3") + 0.5 + i * 0.12
        ra = a * appear(t, st - 0.1, 0.3)
        c.text(770, y + 15, name, "semi", 24, WHITE, anchor="lm", a=ra, on=CARD_D)
        g = out3((t - st) / 0.8)
        col = ORANGE if score < 20 else (BLUE_M if score >= 70 else C("#4A6E9E"))
        c.rect(1060, y, 620, 30, fill=CARD_D2, r=8, a=ra, on=CARD_D)
        c.rect(1060, y, 620 * score / 100 * g, 30, fill=col, r=8, a=ra, on=CARD_D2)
        c.text(1060 + 620 * score / 100 * g + 14, y + 15, f"{score * g:.1f}", "black", 24,
               LORANGE if score < 20 else WHITE, anchor="lm", a=ra, on=CARD_D if score * g > 90 else CARD_D2)


def step_decide(c, t, a):
    small, faster, six, l4c, floor = M("small"), M("faster"), M("six"), M("l4c"), M("floor")
    pa = a * window(t, small - 0.1, M("l4b") - 0.1, 0.3)
    if pa > 0:
        # harm grows faster than the cut
        x0, y0, x1, y1 = 820, 430, 1250, 790
        c.line([(x0, y0), (x0, y1), (x1, y1)], MUTED_D, 3, a=pa, on=CARD_D)
        c.text(x1, y1 + 30, "size of the cut →", "semi", 22, MUTED_D, anchor="rs", a=pa, on=CARD_D)
        c.text(x0 + 12, y0 + 6, "harm", "semi", 22, MUTED_D, anchor="lt", a=pa, on=CARD_D)
        g = out3((t - small - 0.5) / 1.6)
        curve = lambda u: (x0 + u * (x1 - x0), y1 - (u * u) * (y1 - y0 - 30))  # noqa: E731
        c.line([curve(j / 40 * g) for j in range(41)], ORANGE, 6, a=pa, on=CARD_D)
        for k, (u, lab, col, st) in enumerate(((0.25, "small cut → tiny harm", GREEN_L, small + 1.2),
                                               (0.85, "big cut → big harm", LORANGE, small + 2.0))):
            da = pa * appear(t, st, 0.3)
            px, py = curve(u)
            c.circle(px, py, 11, fill=col, a=da, on=CARD_D)
            c.circle(1342, 742 + k * 44, 9, fill=col, a=da, on=CARD_D)
            c.text(1362, 742 + k * 44, lab, "bold", 24, col, anchor="lm", a=da, on=CARD_D)
        ha = pa * appear(t, small, 0.4)
        c.para(1330, 520, "Many small cuts beat one big cut.", "black", 40, WHITE, 450, lh=1.15, a=ha, on=CARD_D)
        fa = pa * appear(t, faster, 0.4)
        c.para(1330, 650, "Harm grows faster than the cut.", "bold", 30, WHITE, 450, lh=1.2, a=fa, on=CARD_D)
    ca = a * window(t, M("l4b") - 0.1, l4c - 0.15, 0.3)
    if ca > 0:
        blocks = [("ONE BIG CUT", 1, 0.6, "0.6 × 0.6", "0.36", ORANGE, M("l4b")),
                  ("SIX SMALL CUTS · 10% EACH", 6, 0.1, "6 × 0.1 × 0.1", "0.06", GREEN_L, six)]
        for b, (title, n, cut, expr, harm, hc, st) in enumerate(blocks):
            ba = ca * appear(t, st - 0.1, 0.35)
            bx = 790 + b * 520
            c.text(bx, 430, title, "black", 26, LORANGE if b == 0 else GREEN_L, anchor="ls", a=ba, on=CARD_D)
            cw = 150 if n == 1 else 56
            g = out3((t - st - 0.3) / 0.8)
            for j in range(n):
                x = bx + (60 if n == 1 else j * 74)
                c.rect(x, 460, cw, 260, fill=BLUE_M, r=10, a=ba, on=CARD_D)
                cut_h = 260 * cut * g
                c.rect(x, 460, cw, cut_h, fill=ORANGE, r=10, a=ba, on=BLUE_M)
                c.hatch(x, 460, cw, cut_h, C("#A94A1F"), a=ba, step=12, width=3, on=ORANGE)
            if n == 1:
                c.text(bx + 135, 495 + 260 * cut * g, "−60%", "black", 30, WHITE, anchor="ms",
                       a=ba * appear(t, st + 0.6, 0.3), on=BLUE_M)
            fa = ca * appear(t, st + 0.9, 0.35)
            c.rich(bx, 790, [("harm = " + expr + " = ", "semi", WHITE), (harm, "black", hc)], 34, a=fa, on=CARD_D)
    ra = a * appear(t, l4c - 0.1, 0.35)
    if ra > 0:
        rules = [("🛡", "Life-safety slices: never touched", "taken out before the maths even starts", l4c),
                 ("📶", "Guaranteed minimum", "no slice ever drops below its floor", floor),
                 ("✂", "Maximum cut per department", None, floor + 1.1)]
        for i, (emo, title, sub, st) in enumerate(rules):
            ka, dy = rise(t, st - 0.1, 24)
            ka *= a
            y = 420 + i * 135 + dy
            c.rect(770, y, 1020, 115, fill=CARD_D2, r=20, a=ka, on=CARD_D)
            c.emoji(830, y + 57, emo, 50, a=ka)
            c.text(890, y + 52, title, "bold", 32, WHITE, anchor="ls", a=ka, on=CARD_D2)
            if sub:
                c.text(890, y + 88, sub, "reg", 24, MUTED_D, anchor="ls", a=ka, on=CARD_D2)
            else:
                x = 890
                for j, chip in enumerate(["Canteen 80%", "Quality lab 20%", "Factory 15%"]):
                    x += 12 + c.pill(x, y + 64, chip, 22, mix(CARD_D2, LORANGE, 0.85), INK, kind="bold",
                                     a=ka * appear(t, st + 0.2 + j * 0.2, 0.25), on=CARD_D2, h=38, padx=14)


def step_apply(c, t, a):
    for i, name in enumerate(["Canteen Signage", "Office Wi-Fi", "CCTV"]):
        y = 450 + i * 125
        st = M("l5") + 0.3 + i * 0.25
        ra = a * appear(t, M("l5") + i * 0.1, 0.3)
        c.text(770, y + 30, name, "bold", 28, WHITE, anchor="lm", a=ra, on=CARD_D)
        c.rect(1040, y, 600, 60, fill=CARD_D2, r=14, a=ra, on=CARD_D)
        landed = clamp((t - st) / 0.45)
        speed = 260 - 170 * smooth((t - st - 0.3) / 0.8)
        off = (t * speed) % 90
        for k in range(8):
            xx = 1050 + k * 90 + off
            if xx < 1610:
                c.rect(xx, y + 26, 40, 8, fill=LORANGE, r=4, a=ra * 0.7, on=CARD_D2)
        sy = y + 30 - 50 * (1 - out3(landed))
        sa = a * smooth(landed * 2)
        c.circle(1720, sy, 50, fill=WHITE, a=sa, on=CARD_D)
        c.circle(1720, sy, 50, outline=RED, width=10, a=sa, on=CARD_D)
        c.text(1720, sy - 9, "NEW", "black", 18, INK, anchor="mm", a=sa, on=WHITE)
        c.text(1720, sy + 13, "LIMIT", "black", 18, INK, anchor="mm", a=sa, on=WHITE)


def step_restore(c, t, a):
    st = M("l6")
    timer = clamp((t - st - 0.3) / 1.6)
    refill = out3((t - st - 2.0) / 0.8)
    x, y, w = 790, 480, 760
    c.text(x, y - 24, "Canteen Signage", "bold", 28, WHITE, anchor="ls", a=a, on=CARD_D)
    c.rect(x, y, w, 70, fill=CARD_D2, r=16, a=a, on=CARD_D)
    fw = w * (0.2 + 0.8 * refill)
    col = mix(ORANGE, GREEN_L, refill)
    c.rect(x, y, fw, 70, fill=col, r=16, a=a, on=CARD_D2)
    if refill > 0.95:
        c.text(x + fw - 66, y + 35, "restored", "black", 28, INK, anchor="rm", a=a, on=col)
        c.check(x + fw - 38, y + 35, 26, INK, 5, a=a, on=col)
    cx, cy = 1690, 515
    c.circle(cx, cy, 62, outline=LINE_D, width=12, a=a, on=CARD_D)
    c.arc(cx, cy, 62, -90, -90 + 360 * timer, LORANGE, 12, a=a, on=CARD_D)
    c.emoji(cx, cy, "⏱", 52, a=a)
    c.text(cx, cy + 102, "recovery window", "semi", 22, MUTED_D, anchor="ms", a=a, on=CARD_D)
    ta = a * appear(t, st + 0.6, 0.4)
    c.text(x, 680, "30 seconds to 30 minutes,", "black", 40, WHITE, anchor="ls", a=ta, on=CARD_D)
    c.text(x, 728, "set for each department", "semi", 30, MUTED_D, anchor="ls", a=ta, on=CARD_D)


def step_record(c, t, a):
    st, ne = M("l7"), M("noedit")
    x, y, w, h = 780, 410, 600, 410
    c.rect(x, y, w, h, fill=PAPER, r=18, a=a, on=CARD_D)
    c.text(x + 36, y + 58, "Decision record", "black", 32, INK, anchor="ls", a=a, on=PAPER)
    c.rect(x + 36, y + 76, w - 72, 3, fill=LINE_L, a=a, on=PAPER)
    items = ["What happened", "Who was slowed, how much, how long", "Why — in plain sentences",
             "Alternatives, and why they were worse", "The rules at that moment"]
    for i, item in enumerate(items):
        ia = a * appear(t, st + 0.4 + i * 0.3, 0.3)
        yy = y + 128 + i * 56
        c.circle(x + 52, yy - 8, 13, fill=GREEN, a=ia, on=PAPER)
        c.check(x + 52, yy - 8, 14, WHITE, 3, a=ia, on=GREEN)
        c.text(x + 80, yy, item, "semi", 25, INK, anchor="ls", a=ia, on=PAPER)
    la = a * appear(t, ne - 0.1, 0.35)
    if la > 0:
        sc = back((t - ne + 0.1) / 0.5)
        c.emoji(1610, 540, "🔒", 110 * (0.6 + 0.4 * sc), a=la)
        c.text(1610, 668, "Permanent", "black", 44, WHITE, anchor="ms", a=la, on=CARD_D)
        c.text(1610, 712, "can't be edited or deleted —", "semi", 24, MUTED_D, anchor="ms", a=la, on=CARD_D)
        c.text(1610, 744, "not even by admins", "bold", 26, LORANGE, anchor="ms", a=la, on=CARD_D)


STEP_DRAW = [step_measure, step_detect, step_score, step_decide, step_apply, step_restore, step_record]


def scene_loop(t):
    c = Canvas(INK)
    cur = step_at(t)
    draw_tracker(c, t, cur)
    draw_loop(c, t, cur)
    pa = appear(t, M("l0") + 0.2, 0.5)
    x, y, w, h = PANEL
    c.rect(x, y, w, h, fill=CARD_D, r=30, a=pa)
    ia = pa * (1 - smooth((t - (M("l1") - 0.4)) / 0.3))
    if ia > 0:
        c.text(x + w / 2, y + 290, "Every 2 seconds,", "black", 54, WHITE, anchor="ms", a=ia, on=CARD_D)
        c.text(x + w / 2, y + 360, "seven steps — automatically.", "black", 54, LORANGE, anchor="ms", a=ia, on=CARD_D)
        c.text(x + w / 2, y + 430, "No human has to press a button.", "reg", 30, MUTED_D, anchor="ms", a=ia, on=CARD_D)
    for k in range(1, 8):
        sa = step_alpha(t, k) * pa
        if sa > 0:
            panel_head(c, t, k, sa)
            STEP_DRAW[k - 1](c, t, sa)
    chrome(c, t, "loop")
    return c


# ---------------------------------------------------------------- scene: a real decision

def scene_decision(t):
    c = Canvas(PAPER)
    header(c, t, M("d1") - 0.4, "A real decision", "the lunch-hour rush, on the live link")
    # gauge: demand vs usable
    X0, GW = 120, 1250
    px = GW / 1316
    lim = X0 + 950 * px
    da = appear(t, M("demand") - 0.3)
    c.text(X0, 262, "Demand", "bold", 26, INK, anchor="ls", a=da)
    c.text(X0 + 110, 262, "1,316 kbps", "black", 26, ORANGE, anchor="ls", a=da * appear(t, M("demand") + 0.4))
    c.rect(X0, 280, GW, 64, fill=LINE_L, r=14, a=da)
    g = out3((t - M("demand")) / 1.1)
    ua = appear(t, M("usable2"), 0.4)
    c.rect(X0, 280, GW * g, 64, fill=mix(C("#56657A"), BLUE, ua), r=14, a=da)
    if ua > 0:
        c.rect(lim, 280, X0 + GW - lim, 64, fill=ORANGE, r=14, a=ua)
        c.rect(lim, 280, 20, 64, fill=ORANGE, a=ua)
        c.text(X0 + 24, 312, "950 kbps usable", "bold", 28, WHITE, anchor="lm", a=ua, on=BLUE)
        c.dashed(lim, 266, lim, 360, INK, width=3, a=ua)
        c.text(lim + (X0 + GW - lim) / 2, 312, "too much", "bold", 20, WHITE, anchor="mm", a=ua, on=ORANGE)
    fa, fdy = rise(t, M("free") - 0.1)
    if fa > 0:
        c.card(1420, 222 + fdy, 380, 140, INK, r=24, a=fa)
        c.text(1450, 262 + fdy, "MUST FREE", "black", 22, LORANGE, anchor="ls", a=fa, on=INK)
        c.text(1450, 320 + fdy, "251.5 kbps", "black", 54, WHITE, anchor="ls", a=fa, on=INK)
        c.text(1450, 350 + fdy, "includes a 3% safety margin", "semi", 20, MUTED_D, anchor="ls", a=fa, on=INK)
    qa = window(t, M("free") + 0.7, M("d3") - 0.1, 0.3)
    if qa > 0:
        c.text(W / 2, 600, "Which slices should give it up?", "black", 52, INK, anchor="ms", a=qa)
        c.text(W / 2, 660, "think about it for a second…", "reg", 30, MUTED_L, anchor="ms", a=qa)
    # the outcome, slice by slice
    rows = [("🍽", "Canteen Signage", "140 → 28 kbps", 0.80, "−80%", ORANGE, M("cut80")),
            ("💼", "Office Wi-Fi", "320 → 217 kbps", 0.32, "−32%", ORANGE, M("d4") + 0.2),
            ("📦", "Warehouse Operations", "160 → 121 kbps", 0.24, "−24%", ORANGE, M("wh")),
            ("📹", "CCTV", "240 → 211 kbps", 0.12, "−12%", ORANGE, M("cctv")),
            ("🏥", "Patient Telemetry", "Clinic · life-safety", 0.0, "NEVER CUT", BLUE, M("exempt")),
            ("🏭", "Factory · Quality lab", "2 slices", 0.0, "UNTOUCHED", GREEN, M("d5"))]
    for i, (emo, name, sub, cut, badge, bc, st) in enumerate(rows):
        ka, dy = rise(t, M("d3") - 0.2 + i * 0.12, 24)
        if ka <= 0:
            continue
        y = 384 + i * 80 + dy
        c.card(120, y, 1680, 72, WHITE, r=18, a=ka)
        cy = y + 36
        if i == 5:
            for j, e in enumerate(["🏭", "🔬"]):
                c.emoji(160 + j * 34, cy, e, 30, a=ka)
        else:
            c.emoji(176, cy, emo, 40, a=ka)
        c.text(240, cy - 4, name, "bold", 28, INK, anchor="ls", a=ka, on=WHITE)
        cut_row = cut > 0
        c.text(240, cy + 22, sub, "semi" if cut_row else "reg", 21, ORANGE if cut_row else MUTED_L, anchor="ls",
               a=ka * (appear(t, st, 0.4) if cut_row else 1), on=WHITE)
        bx, bw = 760, 620
        k = out3((t - st) / 0.9)
        c.rect(bx, cy - 15, bw, 30, fill=LINE_L, r=10, a=ka, on=WHITE)
        keep = bw * (1 - cut * k)
        fill = BLUE if i == 4 else (GREEN_L if i == 5 else BLUE_M)
        c.rect(bx, cy - 15, keep, 30, fill=fill, r=10, a=ka, on=WHITE)
        if cut * k > 0.005:
            c.hatch(bx + keep, cy - 15, bw - keep, 30, ORANGE, a=ka, step=10, width=3, on=LINE_L)
        ba = ka * appear(t, st, 0.3)
        sc = back((t - st) / 0.45)
        if ba > 0:
            if i == 4:
                c.emoji(1460, cy, "🛡", 38, a=ba)
            if i == 5:
                c.check(1460, cy, 30, GREEN, 6, a=ba, on=WHITE)
            c.text(1500, cy, badge, "black", 40 * (0.8 + 0.2 * sc), bc, anchor="lm", a=ba, on=WHITE)
    # callback to the opening question, then speed / automation badges
    qa = window(t, M("d3") - 0.1, M("ms2") - 0.2, 0.3)
    if qa > 0:
        c.pill(1800, 108, "Your answer? The canteen screens", 26, ORANGE, WHITE, kind="bold", a=qa, align="r",
               icon="🎯", h=56)
    ma = appear(t, M("ms2") - 0.1, 0.3)
    if ma > 0:
        w = c.pill(1800, 108, "Enforced in 4 s", 26, INK, WHITE, kind="black", a=ma, align="r", icon="⏱", h=56)
        na = appear(t, M("nobutton") - 0.1, 0.3)
        c.pill(1800 - w - 14, 108, "nobody pressed a button", 26, BLUE, WHITE, kind="bold", a=na, align="r",
               icon="🤖", h=56)
    chrome(c, t, "decision")
    return c


# ---------------------------------------------------------------- scene: what's new

IDEAS = [("Business value, not labels", "decides by what each department is worth", "i1"),
         ("Small cuts, not one deep cut", "harm grows faster than the cut", "i2"),
         ("Safety is a hard rule, not a weight", "life-safety slices never enter the maths", "i3"),
         ("Proved on real traffic", "phones, a shaped link, every 2 s recorded", "i4")]


def scene_new(t):
    c = Canvas(INK)
    header(c, t, M("n1") - 0.3, "What's new?", None, dark=True)
    x = 120
    for i, (txt, st) in enumerate([("Not new: network slicing", M("n1") + 0.9),
                                   ("Not new: the sharing maths", M("n1") + 1.9)]):
        a = appear(t, st, 0.3)
        x += 14 + c.pill(x, 196, txt, 24, None, MUTED_D, kind="semi", a=a, outline=LINE_D, h=50)
    a = appear(t, M("combo"), 0.3)
    c.pill(x + 10, 196, "New: the combination", 24, ORANGE, WHITE, kind="black", a=a, h=50, icon="✨")
    for i, (title, sub, mk) in enumerate(IDEAS):
        col, row = i % 2, i // 2
        x, y = 120 + col * 860, 280 + row * 170
        ka, dy = rise(t, M(mk) - 0.1, 26)
        if ka <= 0:
            continue
        y += dy
        hl = window(t, M(mk), M(mk) + 1.8, 0.3)
        c.card(x, y, 820, 150, CARD_D, r=24, a=ka, outline=mix(CARD_D, LORANGE, hl) if hl > 0.02 else None)
        c.circle(x + 66, y + 75, 32, fill=ORANGE, a=ka, on=CARD_D)
        c.text(x + 66, y + 75, str(i + 1), "black", 32, WHITE, anchor="mm", a=ka, on=ORANGE)
        c.text(x + 126, y + 70, title, "bold", 34, WHITE, anchor="ls", a=ka, on=CARD_D)
        c.text(x + 126, y + 110, sub, "reg", 24, MUTED_D, anchor="ls", a=ka, on=CARD_D)
    ea = appear(t, M("eq") - 0.2, 0.35)
    if ea > 0:
        c.text(120, 660, "Clinic latency (p95) in the lunch-hour rush, measured on the testbed", "bold", 24, MUTED_D,
               anchor="ls", a=ea)
        X0, PX = 560, 760 / 503
        rows = [("Arbitration off", "one full shared queue", 0, 503, "503 ms", ORANGE, M("eq") + 0.3),
                ("Arbitration on", "the cheap slices are cut", 0, 23, "23 ms · no loss", GREEN_L, M("alt"))]
        for i, (name, sub, lo, hi, label, col, st) in enumerate(rows):
            y = 712 + i * 78
            ra = ea * appear(t, st - 0.2, 0.3)
            c.text(120, y + 6 if sub else y + 18, name, "bold", 30, WHITE, anchor="ls" if sub else "lm", a=ra)
            if sub:
                c.text(120, y + 36, sub, "reg", 22, MUTED_D, anchor="ls", a=ra)
            c.rect(X0, y, 920, 36, fill=CARD_D, r=10, a=ra)
            g = out3((t - st) / 1.0)
            x_lo = X0 + lo * PX * g
            x_hi = X0 + max(hi * PX, 8) * g
            c.rect(x_lo, y, max(6, x_hi - x_lo), 36, fill=col, r=10, a=ra, on=CARD_D)
            c.text(x_hi + 18, y + 18, label, "black", 30, WHITE, anchor="lm", a=ra * appear(t, st + 0.6, 0.3))
        c.text(X0, 868, "Factory 509 → 22 ms · Lab 505 → 22 ms · their loss up to 21% → 0%", "reg",
               22, MUTED_D, anchor="ls", a=ea * appear(t, M("alt") + 1.0, 0.4))
    chrome(c, t, "new")
    return c


# ---------------------------------------------------------------- scene: today & next

def scene_future(t):
    c = Canvas(PAPER)
    la, ldy = rise(t, M("f1") - 0.3, 20)
    if la > 0:
        x, y = 120, 110 + ldy
        c.card(x, y, 800, 760, WHITE, r=30, a=la)
        c.pill(x + 40, y + 36, "TODAY", 22, INK, WHITE, kind="black", a=la, on=WHITE, h=44)
        c.text(x + 40, y + 148, "A real, small link", "black", 44, INK, anchor="ls", a=la, on=WHITE)
        c.text(x + 40, y + 190, "real traffic · 1 Mbps · our own shaper", "reg", 26, MUTED_L, anchor="ls", a=la,
               on=WHITE)
        c.emoji(x + 720, y + 130, "📶", 64, a=la)
        ra = la * appear(t, M("real") - 0.2, 0.3)
        c.rect(x + 40, y + 226, 720, 3, fill=LINE_L, a=ra, on=WHITE)
        c.text(x + 40, y + 282, "Already real:", "bold", 30, INK, anchor="ls", a=ra, on=WHITE)
        for i, item in enumerate(["Real traffic", "Measured delay", "Phones on a hotspot", "Decision engine", "Dashboard"]):
            ia = la * appear(t, M("real") + 0.4 + i * 0.4, 0.25)
            yy = y + 336 + i * 54
            c.circle(x + 58, yy - 9, 16, fill=GREEN, a=ia, on=WHITE)
            c.check(x + 58, yy - 9, 16, WHITE, 3, a=ia, on=GREEN)
            c.text(x + 88, yy, item, "semi", 30, INK, anchor="ls", a=ia, on=WHITE)
        ta, tdy = rise(t, M("tests") - 0.1)
        if ta > 0:
            ta *= la
            c.rect(x + 40, y + 618 + tdy, 720, 104, fill=GREEN, r=22, a=ta, on=WHITE)
            c.text(x + 76, y + 690 + tdy, "460", "black", 60, WHITE, anchor="ls", a=ta, on=GREEN)
            c.text(x + 76 + c.tw("460", "black", 60) + 18, y + 682 + tdy, "automated tests pass", "bold", 32,
                   WHITE, anchor="ls", a=ta, on=GREEN)
    ra, rdy = rise(t, M("f3") - 0.4, 20)
    if ra > 0:
        x, y = 980, 110 + rdy
        c.card(x, y, 820, 760, WHITE, r=30, a=ra)
        c.pill(x + 40, y + 36, "NEXT", 22, ORANGE, WHITE, kind="black", a=ra, on=WHITE, h=44)
        c.text(x + 40, y + 148, "Bigger, faster, more real", "black", 44, INK, anchor="ls", a=ra, on=WHITE)
        stops = [("Seven phones, measured", ["hotspot", "off vs on"], "r1"),
                 ("Kernel shaping", ["Linux tc", "CoDel"], "r2"),
                 ("A real 5G core", ["Open5GS", "UERANSIM"], "r3"),
                 ("Slicing down to the radio", ["O-RAN"], "r4")]
        lx = x + 72
        top, step = y + 250, 135
        fillp = 0.0
        for i, (_, _, mk) in enumerate(stops):
            if t >= M(mk):
                fillp = i + out3((t - M(mk)) / 0.6) if i < 3 else 3
        c.rect(lx - 4, top, 8, 3 * step, fill=LINE_L, r=4, a=ra, on=WHITE)
        c.rect(lx - 4, top, 8, step * min(3, fillp), fill=ORANGE, r=4, a=ra, on=WHITE)
        for i, (title, chips, mk) in enumerate(stops):
            sa = ra * appear(t, M(mk) - 0.1, 0.3)
            yy = top + i * step
            on = t >= M(mk) - 0.1
            c.circle(lx, yy, 28, fill=ORANGE if on else LINE_L, a=ra, on=WHITE)
            c.text(lx, yy, str(i + 1), "black", 28, WHITE if on else MUTED_L, anchor="mm", a=ra,
                   on=ORANGE if on else LINE_L)
            c.text(lx + 56, yy + 6, title, "bold", 32, INK, anchor="ls", a=max(0.25 * ra, sa), on=WHITE)
            cx = lx + 56
            for chip in chips:
                cx += 10 + c.pill(cx, yy + 22, chip, 22, BLUE_T, BLUE, kind="bold", a=sa, on=WHITE, h=38, padx=14)
    chrome(c, t, "future")
    return c


# ---------------------------------------------------------------- scene: close

def scene_close(t):
    c = Canvas(INK)
    end = M("f6_end") + 0.3
    fa = 1 - smooth((t - end) / 0.5)
    if fa > 0:
        ka, dy = rise(t, M("f5") - 0.2, 20)
        c.text(W / 2, 170 + dy, "When the network is full…", "black", 60, WHITE, anchor="ms", a=ka * fa)
        n = len(SLICES)
        bw, gap = 96, 22
        x0 = (W - (n * bw + (n - 1) * gap)) / 2
        for i, (name, dept, score) in enumerate(SLICES):
            ba = fa * appear(t, M("f5") + 0.3 + i * 0.07, 0.3)
            cut = {6: 0.8, 5: 0.32, 4: 0.12, 3: 0.24}.get(i, 0.0) * out3((t - M("least")) / 1.0)
            h = 300
            x = x0 + i * (bw + gap)
            col = ORANGE if i == n - 1 else (BLUE if i == 0 else BLUE_M)
            c.rect(x, 230, bw, h, fill=CARD_D, r=14, a=ba)
            c.rect(x, 230 + h * cut, bw, h * (1 - cut), fill=col, r=14, a=ba)
            if i == 0:
                c.emoji(x + bw / 2, 230 + h / 2, "🛡", 44, a=ba)
        la = fa * appear(t, M("least") + 0.5, 0.4)
        c.text(x0 + (n - 1) * (bw + gap) + bw / 2, 590, "matters least", "bold", 26, LORANGE, anchor="ms", a=la)
        c.text(x0 + bw / 2, 590, "life-safety", "bold", 26, BLUE_L, anchor="ms", a=la)
        words = [("Small", BLUE, M("wsmall")), ("Fair", BLUE_M, M("wfair")), ("Safe", GREEN, M("wsafe"))]
        pw, pg = 300, 40
        px0 = (W - (3 * pw + 2 * pg)) / 2
        for i, (wd, col, st) in enumerate(words):
            wa = fa * appear(t, st - 0.05, 0.2)
            sc = back((t - st + 0.05) / 0.4)
            cx = px0 + i * (pw + pg) + pw / 2
            ww, hh = pw * (0.7 + 0.3 * sc), 110 * (0.7 + 0.3 * sc)
            c.rect(cx - ww / 2, 690 - hh / 2, ww, hh, fill=col, r=hh / 2, a=wa)
            c.text(cx, 690, wd, "black", 58 * (0.7 + 0.3 * sc), WHITE, anchor="mm", a=wa, on=col)
        ea = fa * appear(t, M("wexp"), 0.35)
        c.text(W / 2, 830, "…and it explains every decision", "black", 40, LORANGE, anchor="ms", a=ea)
    ta = appear(t, end + 0.2, 0.6)
    if ta > 0:
        c.text(W / 2, 430, "NETWORK ARBITRATION", "black", 30, LORANGE, anchor="ms", a=ta)
        c.text(W / 2, 520, "Runtime Arbitration for Contended,", "black", 66, WHITE, anchor="ms", a=ta)
        c.text(W / 2, 600, "SLA-Critical Enterprise Network Slices", "black", 66, WHITE, anchor="ms", a=ta)
        c.text(W / 2, 700, "decides by business value · small cuts · safety first · tested on real traffic",
               "semi", 28, MUTED_D, anchor="ms", a=ta * appear(t, end + 0.7, 0.5))
    chrome(c, t, "close")
    return c


# ---------------------------------------------------------------- timeline of scenes

SCENE_FUNCS = {"hook": scene_hook, "problem": scene_problem, "solution": scene_solution, "loop": scene_loop,
               "decision": scene_decision, "new": scene_new, "future": scene_future, "close": scene_close}


def scene_spans():
    spans = [(s["id"], TL["scenes"][s["id"]]["start"], TL["scenes"][s["id"]]["end"]) for s in SCENES]
    close_at = M("f5") - 0.45
    sid, st, en = spans[-1]
    spans[-1] = (sid, st, close_at)
    spans.append(("close", close_at, en))
    return spans


SPANS = scene_spans()
XFADE = 0.5


def render_scene_frame(t):
    for i, (sid, st, en) in enumerate(SPANS):
        if st <= t < en or i == len(SPANS) - 1:
            break
    img = SCENE_FUNCS[sid](t).finish()
    # crossfade into the next scene around the boundary
    if i + 1 < len(SPANS) and t > en - XFADE / 2:
        k = smooth((t - (en - XFADE / 2)) / XFADE)
        img = Image.blend(img, SCENE_FUNCS[SPANS[i + 1][0]](t).finish(), k)
    if i > 0 and t < st + XFADE / 2:
        k = smooth((t - (st - XFADE / 2)) / XFADE)
        img = Image.blend(SCENE_FUNCS[SPANS[i - 1][0]](t).finish(), img, k)
    return img


# ---------------------------------------------------------------- subtitles

SUB_PX, SUB_MAXW, SUB_LH, SUB_PADX, SUB_PADY, SUB_BOTTOM = 48, 1500, 64, 36, 18, 1046


def sub_lines(text):
    f = font("semi", SUB_PX)
    if f.getlength(text) <= SUB_MAXW:
        return [text]
    words = text.split()
    best = None
    for i in range(1, len(words)):
        l1, l2 = " ".join(words[:i]), " ".join(words[i:])
        w = max(f.getlength(l1), f.getlength(l2))
        last = words[i - 1][-1]
        if max(f.getlength(l1), f.getlength(l2)) > SUB_MAXW + 40:
            continue
        score = w - (500 if last in ".?!…" else 120 if last in ",:;" else 0)
        if best is None or score < best[0]:
            best = (score, [l1, l2])
    return best[1]


def build_subs():
    subs = []
    for i, cue in enumerate(CUES):
        nxt = CUES[i + 1]["start"] if i + 1 < len(CUES) else DUR
        end = min(nxt - 0.04, cue["end"] + 0.5)
        lines = sub_lines(cue["show"])
        f = font("semi", SUB_PX)
        bw = max(f.getlength(ln) for ln in lines) + 2 * SUB_PADX
        bh = len(lines) * SUB_LH + 2 * SUB_PADY
        subs.append({"start": cue["start"], "end": end, "lines": lines, "w": int(bw), "h": int(bh)})
    return subs


SUBS = build_subs()


@lru_cache(maxsize=None)
def sub_mask(w, h):
    big = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], radius=18 * 4, fill=int(255 * 0.86))
    return big.resize((w, h), Image.LANCZOS)


def draw_subtitle(img, t):
    for s in SUBS:
        if s["start"] <= t < s["end"]:
            x, y = (W - s["w"]) // 2, SUB_BOTTOM - s["h"]
            img.paste(Image.new("RGB", (s["w"], s["h"]), C("#0E151F")), (x, y), sub_mask(s["w"], s["h"]))
            d = ImageDraw.Draw(img)
            for i, ln in enumerate(s["lines"]):
                d.text((W / 2, y + SUB_PADY + SUB_LH / 2 + i * SUB_LH), ln, font=font("semi", SUB_PX),
                       fill=WHITE, anchor="mm")
            return


def frame(t):
    img = render_scene_frame(t)
    draw_subtitle(img, t)
    return img


def srt_time(x):
    ms = int(round(x * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt():
    out = []
    for i, s in enumerate(SUBS, 1):
        out.append(f"{i}\n{srt_time(s['start'])} --> {srt_time(s['end'])}\n" + "\n".join(s["lines"]) + "\n")
    (VIDEO / "explainer.srt").write_text("\n".join(out), encoding="utf-8")


# ---------------------------------------------------------------- audio: narration + sound effects

SR = 48000


def tone(freqs, dur, amp, decay, sweep=1.0):
    n = int(SR * dur)
    tt = np.arange(n) / SR
    env = np.exp(-tt / decay) * np.minimum(1, tt / 0.003)
    sig = np.zeros(n)
    for f in freqs:
        inst = f * (1 + (sweep - 1) * tt / dur)
        sig += np.sin(2 * np.pi * np.cumsum(inst) / SR)
    return amp * env * sig / len(freqs)


SCALE = [0, 2, 4, 5, 7, 9, 11, 12]
SOUNDS = {
    "pop": lambda: tone([880], 0.09, 0.10, 0.03, sweep=0.7),
    "tick": lambda: tone([1600], 0.05, 0.07, 0.012),
    "chime": lambda: tone([880, 1318.5], 0.9, 0.08, 0.25),
    "down": lambda: tone([620], 0.32, 0.08, 0.12, sweep=0.45),
    "alert": lambda: np.concatenate([tone([660], 0.09, 0.07, 0.04), np.zeros(int(SR * 0.05)),
                                     tone([660], 0.09, 0.07, 0.04)]),
    "thud": lambda: tone([110, 165], 0.25, 0.18, 0.06, sweep=0.8),
    **{f"step{k}": (lambda k=k: tone([523.25 * 2 ** (SCALE[k - 1] / 12)], 0.22, 0.09, 0.07)) for k in range(1, 8)},
}


def sfx_events():
    ev = [(M("h2") + 0.2, "pop"), (JAM, "alert")]
    ev += [(M("h4") + 0.25 + i * 0.18, "pop") for i in range(4)]
    cd0 = M("h4_end") - 0.2
    ev += [(cd0 + k, "tick") for k in range(3)] + [(cd0 + 3.0, "chime")]
    ev += [(M("p1") + 1.3, "pop"), (M("p2") + 0.9, "pop"), (M("nine"), "pop"), (M("link"), "pop"),
           (M("usable") + 0.3, "pop"), (M("promised"), "pop"), (M("p6") + 0.3, "pop"), (M("standard"), "pop"),
           (M("p7") + 0.2, "down"), (M("lunch") + 0.55, "thud")]
    ev += [(M("s1") + 1.1, "pop")] + [(M(q[2]) - 0.1, "pop") for q in QUESTIONS] + [(M("canteen15"), "pop")]
    ev += [(M("l0") + 0.2, "pop")] + [(M(cue) - 0.15, f"step{i + 1}") for i, cue in enumerate(STEP_CUES)]
    ev += [(M("tworeads"), "alert"), (M("six"), "pop"), (M("floor"), "pop"), (M("noedit"), "thud")]
    ev += [(M("demand"), "pop"), (M("usable2"), "pop"), (M("free"), "pop"), (M("cut80"), "down"),
           (M("d4") + 0.2, "pop"), (M("cctv"), "pop"), (M("wh"), "pop"), (M("exempt"), "chime"), (M("d5"), "pop"),
           (M("ms2"), "pop"), (M("nobutton"), "pop")]
    ev += [(M("combo"), "pop")] + [(M(i[2]) - 0.1, "pop") for i in IDEAS] + [(M("eq") + 0.3, "pop"), (M("alt"), "pop")]
    ev += [(M("real") + 0.4 + i * 0.4, "tick") for i in range(5)] + [(M("tests"), "chime")]
    ev += [(M(m) - 0.1, "pop") for m in ("r1", "r2", "r3", "r4")]
    ev += [(M("wsmall"), "pop"), (M("wfair"), "pop"), (M("wsafe"), "pop"), (M("wexp"), "chime"),
           (M("f6_end") + 0.5, "chime")]
    return ev


def build_audio():
    narr48 = BUILD / "narration_48k.wav"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(VIDEO / "narration.wav"),
                    "-af", "aresample=48000:filter_size=64", "-ar", "48000", str(narr48)], check=True)
    with wave.open(str(narr48)) as w:
        voice = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    voice *= 0.7 / max(1e-6, np.abs(voice).max())
    mixbuf = np.zeros(max(len(voice), int(DUR * SR) + SR))
    mixbuf[:len(voice)] += voice
    for t0, kind in sfx_events():
        snd = SOUNDS[kind]()
        i0 = int(t0 * SR)
        mixbuf[i0:i0 + len(snd)] += snd[:len(mixbuf) - i0]
    mixbuf = mixbuf[:int(DUR * SR)]
    mixbuf /= max(1.0, np.abs(mixbuf).max() / 0.95)
    with wave.open(str(BUILD / "mix.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mixbuf * 32767).astype(np.int16).tobytes())


# ---------------------------------------------------------------- video

def render_chunk(args):
    idx, f0, f1 = args
    out = BUILD / "chunks" / f"chunk_{idx:02d}.mp4"
    proc = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                             "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium",
                             "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), str(out)], stdin=subprocess.PIPE)
    for fi in range(f0, f1):
        proc.stdin.write(frame(fi / FPS).tobytes())
    proc.stdin.close()
    proc.wait()
    return out


def render_video(workers):
    (BUILD / "chunks").mkdir(exist_ok=True)
    write_srt()
    build_audio()
    n = workers * 2
    bounds = [round(i * NFRAMES / n) for i in range(n + 1)]
    jobs = [(i, bounds[i], bounds[i + 1]) for i in range(n)]
    with Pool(workers) as pool:
        chunks = pool.map(render_chunk, jobs)
    lst = BUILD / "chunks" / "list.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in chunks), encoding="utf-8")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-i", str(BUILD / "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-movflags", "+faststart", "-shortest", str(VIDEO / "explainer.mp4")], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stills", help="comma-separated times in seconds")
    ap.add_argument("--video", action="store_true")
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()
    if args.stills:
        out = BUILD / "stills"
        out.mkdir(exist_ok=True)
        for s in args.stills.split(","):
            t = float(s)
            frame(t).save(out / f"t{t:07.2f}.png")
        print(f"wrote {len(args.stills.split(','))} stills to {out}")
    if args.video:
        render_video(args.workers)
        print("wrote", VIDEO / "explainer.mp4")


if __name__ == "__main__":
    main()
