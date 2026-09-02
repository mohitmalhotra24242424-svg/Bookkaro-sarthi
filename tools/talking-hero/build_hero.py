#!/usr/bin/env python3
"""BookKaro AI - talking hero renderer (the avatar speaks Hindi + gestures).

Builds the horizontal mobile-homepage hero as an animated sequence:
  * the concierge avatar (3 AI poses) gestures, bobs and breathes, driven by the
    real audio envelope; poses crossfade on the beat of the dialogue
  * the speech bubble types the exact dialogue word-by-word, in sync with TTS
  * a Devanagari subtitle pill (shaped with HarfBuzz) reveals as she speaks
  * live waveform, pulsing "Online" dot, AI-voice badge, quick-action chips

Frames are piped straight into ffmpeg (imageio-ffmpeg's static binary), so no
frame dump is written into the repo.

Run:  /home/user/.venv-img/bin/python tools/talking-hero/build_hero.py
Env:  HERO_LIMIT=<frames>  -> short test render
"""
from __future__ import annotations

import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shaper import ShapedText, composite_line, wrap  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
R = os.path.join(ROOT, "renders")
FD = os.path.join(ROOT, "app", "assets", "fonts")
AUDIO = os.path.join(R, "hero-voice-hi.mp3")
POSES = tuple(os.path.join(R, n) for n in
              ("pose-a-namaste.png", "pose-b-welcome.png", "pose-c-question.png"))
FFMPEG = ("/home/user/.venv-img/lib/python3.11/site-packages/imageio_ffmpeg/"
          "binaries/ffmpeg-linux-x86_64-v7.0.2")

# ── palette ────────────────────────────────────────────────────────────────
ORANGE = (245, 107, 42)
ORANGE_DEEP = (232, 88, 20)
NAVY = (16, 42, 67)
NAVY_SOFT = (62, 88, 108)
CREAM = (255, 248, 239)
OFFWHITE = (252, 250, 246)
TEAL = (21, 152, 137)
GOLD = (226, 176, 44)
CORAL = (242, 107, 74)
LINE = (232, 225, 216)
MUTED = (138, 146, 152)
AVATAR_BG = (252, 244, 229)

S = float(os.environ.get("HERO_SS", "1.5"))     # supersample factor (quality/speed)
W, H = int(round(1440 * S)), int(round(960 * S))
OW, OH = 1440, 960
FPS = int(os.environ.get("HERO_FPS", "24"))
LEAD = 0.45
TAIL = 1.30
XFADE = 0.34

CARD = (44, 24, 1396, 936)
HDR_H = 82
HEADER_BOTTOM = CARD[1] + HDR_H
STAGE_B = 808
PANEL = (92, 128, 656, 772)
BUB = (714, 208, 1352, 712)
PILL_X0 = 742
CHIP_TOP, CHIP_H = 826, 56
SAFE_Y = 900
DEV_LH = 2.05


def p(v):
    return int(round(v * S))


def pil_font(size, weight=800):
    w = {400: "400", 500: "400", 600: "600", 700: "600", 800: "800"}.get(
        int(weight), "800")
    return ImageFont.truetype(os.path.join(FD, f"Inter-{w}.ttf"), p(size))


class Txt:
    """Small PIL text helper: word images + baseline placement (no shaping)."""

    def __init__(self, size, weight=800):
        self.font = pil_font(size, weight)
        self.asc, self.desc = self.font.getmetrics()

    def adv(self, text):
        return self.font.getlength(text) / S

    def img(self, text, colour):
        im = Image.new("RGBA", (p(self.adv(text)) + 4, self.asc + self.desc + 4),
                       (0, 0, 0, 0))
        ImageDraw.Draw(im).text((2, 2), text, font=self.font, fill=(*colour, 255))
        return im, self.asc + 2, self.adv(text)

    def paint(self, target, x, baseline, text, colour):
        im, b, a = self.img(text, colour)
        target.alpha_composite(im, (p(x), p(baseline) - b))
        return a


def shaped(size, weight=800, dev=False):   # kept for parity / future use
    fam = {400: 400, 500: 400, 600: 600, 700: 600, 800: 800}.get(int(weight), 800)
    return pil_font(size, fam)


def shadow(size, radius, alpha=52, blur=18, spread=12, colour=(20, 43, 61)):
    w, h = size[0] + 2 * spread, size[1] + 2 * spread
    im = Image.new("RGBA", (p(w), p(h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, p(w) - 1, p(h) - 1], radius=p(radius + spread),
                        fill=(*colour, alpha))
    return im.filter(ImageFilter.GaussianBlur(p(blur)))


def namaste_glyph(size, colour=ORANGE):
    """A folded-hands (\U0001F64F) mark drawn as two cupped palms."""
    s = size
    im = Image.new("RGBA", (int(1.9 * s), int(1.5 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for side in (-1, 1):
        cx = im.width / 2 + side * 0.20 * s
        pts = []
        for k in range(60):
            th = k / 59 * math.pi * 2
            x = side * (0.42 * s) * max(0.0, math.cos(th)) ** 0.75
            y = (0.62 * s) * math.sin(th)
            if y < 0:
                y *= 0.86
                x *= 0.42
            pts.append((cx + x, s * 0.78 + y))
        d.polygon(pts, fill=(*colour, 255))
        # thumb
        d.ellipse([cx - 0.30 * s, s * 0.62, cx + 0.16 * s, s * 1.02],
                  fill=(*colour, 255))
    return im


# ── avatar ──────────────────────────────────────────────────────────────────
def cutout(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    edges = np.concatenate([r.reshape(-1, 3) for r in
                            (a[:8], a[-8:], a[:, :8], a[:, -8:])], axis=0)
    bg = np.median(edges, axis=0)
    m = Image.fromarray((np.abs(a - bg).sum(axis=2) > 48).astype(np.uint8) * 255, "L")
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5))
    m = m.filter(ImageFilter.GaussianBlur(2 * S))
    ys, xs = np.where(np.asarray(m) > 40)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    return im.crop(box), m.crop(box)


def avatar_layer(path, tw, th):
    body, mask = cutout(path)
    sc = min(tw / body.width, th / body.height) * 0.98
    nw, nh = int(body.width * sc), int(body.height * sc)
    body = body.resize((nw, nh), Image.LANCZOS)
    mask = mask.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (tw, th), (*AVATAR_BG, 255))
    canvas.paste(body, ((tw - nw) // 2, th - nh), mask)
    return canvas


# ── static chrome ───────────────────────────────────────────────────────────
def build_static():
    base = Image.new("RGBA", (W, H), (*OFFWHITE, 255))
    wash = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wash)
    wd.ellipse([p(-440), p(-470), p(700), p(540)], fill=(*ORANGE, 32))
    wd.ellipse([p(1000), p(540), p(2060), p(1540)], fill=(*TEAL, 26))
    wd.ellipse([p(300), p(1400), p(1540), p(2140)], fill=(*GOLD, 22))
    base = Image.alpha_composite(base, wash.filter(ImageFilter.GaussianBlur(p(60))))

    cw, ch = CARD[2] - CARD[0], CARD[3] - CARD[1]
    base.alpha_composite(shadow((cw, ch), 30, alpha=44, blur=20, spread=14),
                         (p(CARD[0] - 14), p(CARD[1] + 8)))
    d = ImageDraw.Draw(base, "RGBA")
    d.rounded_rectangle([p(CARD[0]), p(CARD[1]), p(CARD[2]) - 1, p(CARD[3]) - 1],
                        radius=p(30), fill=(255, 255, 255, 255))
    d.rectangle([p(CARD[0]) + 1, p(HEADER_BOTTOM), p(CARD[2]) - 1, p(STAGE_B)],
                fill=CREAM + (255,))

    # ---- faint Indian-railway backdrop, clipped to the stage ----
    bg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    bd.ellipse([p(1096), p(158), p(1224), p(286)], fill=(*ORANGE, 30))
    for cx, cy, w2 in [(1200, 258, 138), (918, 306, 108)]:
        bd.rounded_rectangle([p(cx), p(cy), p(cx + w2), p(cy + 26)], radius=p(13),
                             fill=(*CORAL, 28))
    bd.polygon([(p(700), p(396)), (p(880), p(250)), (p(1064), p(396))], fill=(*TEAL, 22))
    bd.polygon([(p(950), p(396)), (p(1170), p(228)), (p(1396), p(396))],
               fill=(*TEAL, 17))
    ty = p(368)
    for cx in (152, 340, 528):
        bd.rounded_rectangle([p(cx), ty - p(44), p(cx + 156), ty], radius=p(12),
                             fill=(*NAVY, 18))
        for k in range(3):
            bd.rounded_rectangle([p(cx + 15) + k * p(48), ty - p(34),
                                  p(cx + 47) + k * p(48), ty - p(15)], radius=p(5),
                                 fill=(255, 255, 255, 32))
    bd.line([p(118), ty + p(6), p(1378), ty + p(6)], fill=(*NAVY, 26), width=p(2))
    for bx in range(0, 1250, 44):
        bd.line([p(120 + bx), ty + p(12), p(134 + bx), ty + p(12)], fill=(*NAVY, 16),
                width=p(2))
    bd.rectangle([p(1252), p(318), p(1336), p(396)], fill=(*NAVY, 14))
    bd.polygon([(p(1244), p(320)), (p(1294), p(292)), (p(1344), p(320))],
               fill=(*CORAL, 28))
    for bx, by, sc in [(1128, 244, 1.0), (1064, 208, .78)]:
        bd.line([p(bx), p(by), p(bx + 12 * sc), p(by - 8 * sc)], fill=(*NAVY, 46),
                width=p(1.6))
        bd.line([p(bx + 12 * sc), p(by - 8 * sc), p(bx + 24 * sc), p(by)],
                fill=(*NAVY, 46), width=p(1.6))
    clip = Image.new("L", (W, H), 0)
    ImageDraw.Draw(clip).rectangle([p(CARD[0]) + 1, p(HEADER_BOTTOM),
                                    p(CARD[2]) - 1, p(STAGE_B)], fill=255)
    bg = ImageChops.multiply(bg, Image.merge("RGBA", (clip, clip, clip, clip)))
    base.alpha_composite(bg)
    d = ImageDraw.Draw(base, "RGBA")

    # ---- header ----
    d.line([p(CARD[0]), p(HEADER_BOTTOM), p(CARD[2]), p(HEADER_BOTTOM)], fill=LINE,
           width=p(1))
    lgx, lgy = p(CARD[0] + 22), p(CARD[1] + 19)
    d.rounded_rectangle([lgx, lgy, lgx + p(44), lgy + p(44)], radius=p(13), fill=ORANGE)
    gx, gy = lgx + p(10), lgy + p(11)
    d.rounded_rectangle([gx, gy, gx + p(24), gy + p(16)], radius=p(5),
                        fill=(255, 255, 255, 255))
    d.polygon([(gx + p(4), gy + p(16)), (gx + p(20), gy + p(16)),
               (gx + p(23), gy + p(22)), (gx + p(1), gy + p(22))],
              fill=(255, 255, 255, 255))
    d.line([gx + p(6), gy + p(26), gx + p(18), gy + p(26)], fill=(255, 255, 255, 255),
           width=p(2))
    d.text((p(CARD[0] + 80), p(CARD[1] + 14)), "BookKaro AI", font=pil_font(18),
           fill=NAVY)
    d.text((p(CARD[0] + 98), p(CARD[1] + 46)), "Online", font=pil_font(10.5, 600),
           fill=MUTED)
    for i in range(3):
        yy = p(CARD[1] + 27) + i * p(13)
        d.ellipse([p(CARD[2]) - p(48), yy, p(CARD[2]) - p(41), yy + p(7)],
                  fill=(91, 100, 112, 255))

    # ---- avatar plate ----
    d.rounded_rectangle([p(PANEL[0]), p(PANEL[1]), p(PANEL[2]) - 1, p(PANEL[3]) - 1],
                        radius=p(26), fill=(255, 255, 255, 244), outline=LINE,
                        width=p(1))

    # ---- bubble plate + tail ----
    base.alpha_composite(shadow((BUB[2] - BUB[0], BUB[3] - BUB[1]), 28, alpha=38,
                                blur=14, spread=8), (p(BUB[0] - 8), p(BUB[1] + 6)))
    d = ImageDraw.Draw(base, "RGBA")
    d.rounded_rectangle([p(BUB[0]), p(BUB[1]), p(BUB[2]) - 1, p(BUB[3]) - 1],
                        radius=p(28), fill=(255, 255, 255, 255), outline=LINE,
                        width=p(1))
    tyy = p(BUB[1] + 46)
    d.polygon([(p(BUB[0]) - p(11), tyy + p(15)), (p(BUB[0]) + p(3), tyy - p(2)),
               (p(BUB[0]) + p(3), tyy + p(32))], fill=(255, 255, 255, 255))
    lbl = "BookKaro AI"
    lw = d.textlength(lbl, font=pil_font(11.5, 600)) / S + 52
    d.rounded_rectangle([p(BUB[0] + 18), p(BUB[1] - 40), p(BUB[0] + 18 + lw),
                         p(BUB[1] - 8)], radius=p(16), fill=(246, 242, 234, 255))
    d.text((p(BUB[0] + 38), p(BUB[1] - 36)), lbl, font=pil_font(11.5, 600), fill=MUTED)
    d.ellipse([p(BUB[0] + 25), p(BUB[1] - 29), p(BUB[0] + 33), p(BUB[1] - 21)],
              fill=ORANGE)

    # ---- quick action chips ----
    chips = [("Train search", TEAL, "train"), ("Live status", CORAL, "pin"),
             ("PNR status", GOLD, "ticket")]
    cw, gap = 200, 21
    x = CARD[0] + 92
    for label, colour, icon in chips:
        d.rounded_rectangle([p(x), p(CHIP_TOP), p(x + cw) - 1,
                             p(CHIP_TOP + CHIP_H) - 1], radius=p(28),
                            fill=(255, 255, 255, 255), outline=LINE, width=p(1))
        tw = d.textlength(label, font=pil_font(14, 600)) / S
        total = 22 + 10 + tw
        ix = x + (cw - total) / 2
        iy = CHIP_TOP + (CHIP_H - 22) / 2
        icx, icy = p(ix), p(iy)
        if icon == "train":
            d.rounded_rectangle([icx, icy + p(2), icx + p(22), icy + p(16)],
                                radius=p(6), outline=colour, width=p(2))
            d.line([icx + p(4), icy + p(21), icx + p(18), icy + p(21)], fill=colour,
                   width=p(2))
            d.line([icx + p(11), icy + p(2), icx + p(11), icy + p(16)], fill=colour,
                   width=p(2))
        elif icon == "pin":
            d.ellipse([icx + p(3), icy, icx + p(19), icy + p(16)], outline=colour,
                      width=p(2))
            d.ellipse([icx + p(8), icy + p(5), icx + p(14), icy + p(11)], fill=colour)
            d.polygon([(icx + p(7), icy + p(14)), (icx + p(15), icy + p(14)),
                       (icx + p(11), icy + p(22))], fill=colour)
        else:
            d.rounded_rectangle([icx, icy + p(3), icx + p(22), icy + p(19)],
                                radius=p(4), outline=(214, 158, 20, 255), width=p(2))
            d.line([icx + p(11), icy + p(4), icx + p(11), icy + p(18)], fill=colour,
                   width=p(2))
        d.text((p(ix + 32), p(iy + 2)), label, font=pil_font(14, 600), fill=NAVY)
        x += cw + gap

    # ---- privacy note ----
    note = "Your conversations are safe with BookKaro AI"
    nw = d.textlength(note, font=pil_font(11, 400)) / S
    cx0 = (CARD[0] + CARD[2]) / 2 - (nw + 24) / 2
    lkx, lky = p(cx0), p(SAFE_Y + 2)
    d.rounded_rectangle([lkx, lky + p(5), lkx + p(11), lky + p(14)], radius=p(2),
                        outline=MUTED, width=p(2))
    d.arc([lkx + p(2), lky, lkx + p(9), lky + p(8)], 180, 360, fill=MUTED, width=p(2))
    d.text((p(cx0 + 20), p(SAFE_Y)), note, font=pil_font(11, 400), fill=MUTED)
    return base


# ── main ────────────────────────────────────────────────────────────────────
def main():
    if not os.path.exists(AUDIO):
        sys.exit(f"missing audio: {AUDIO}")
    info = subprocess.run([FFMPEG, "-hide_banner", "-i", AUDIO],
                          capture_output=True, text=True).stderr
    mm, ss = info.split("Duration:")[1].split(",")[0].strip().split(":")[1:3]
    dur = float(mm) * 60 + float(ss)
    LIMIT = int(os.environ.get("HERO_LIMIT", "0"))
    if LIMIT:
        dur = min(dur, LIMIT / FPS)
    total = dur + LEAD + TAIL
    n_frames = int(round(total * FPS))

    # audio envelope at frame rate
    probe = subprocess.run([FFMPEG, "-v", "error", "-i", AUDIO, "-ac", "1",
                            "-ar", "16000", "-acodec", "pcm_s16le", "-f", "s16le", "-"],
                           capture_output=True)
    samples = np.frombuffer(probe.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    win = int(16000 / FPS)
    env = np.array([float(np.sqrt(np.mean(samples[i * win:(i + 1) * win] ** 2)))
                    for i in range(max(1, len(samples) // win))])
    env = env / (env.max() + 1e-9)
    env = np.convolve(env, np.array([.2, .6, .2]), mode="same")
    a = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        j = int((i / FPS - LEAD) * FPS)
        a[i] = env[j] if 0 <= j < len(env) else 0.0
    a = np.clip(a, 0, 1)

    base = build_static()
    pw, ph = p(PANEL[2] - PANEL[0]), p(PANEL[3] - PANEL[1])
    avatars = [avatar_layer(pp, pw, ph) for pp in POSES]
    avatar_np = [np.asarray(x, dtype=np.float32) for x in avatars]

    # ---- text (PIL, no shaping needed for the Hinglish dialogue) ----
    body = Txt(21.5, 800)
    small = Txt(13, 600)
    badge_f = Txt(8.5, 800)
    dev_small = Txt(12.5, 600)
    pad_x = 28
    max_w = (BUB[2] - BUB[0]) - 2 * pad_x
    LINES = [
        [("@", ORANGE), ("Namaste!", ORANGE)],
        [("Main ", NAVY), ("BookKaro Railway Assistant", ORANGE), (" hoon.", NAVY)],
        [("Aapki train journey ko simple aur", NAVY)],
        [("stress-free", ORANGE), (" banane ke liye main", NAVY)],
        [("yahan hoon.", NAVY)],
        [("Bataiye, main aapki ", NAVY), ("kya madad", ORANGE),
         (" kar sakti hoon?", NAVY)],
    ]
    hands = namaste_glyph(p(16), ORANGE)
    body_lh = 21.5 * 1.42
    words, y = [], float(BUB[1])
    for parts in LINES:
        x = float(BUB[0] + pad_x)
        y += body_lh
        for txt, colour in parts:
            if txt == "@":
                words.append({"kind": "glyph", "img": hands, "x": x, "y": y,
                              "adv": hands.width / S + 9})
                x += hands.width / S + 9
                continue
            for wd in txt.split(" "):
                if not wd:
                    continue
                im, bl, adv = body.img(wd, colour)
                words.append({"kind": "word", "img": im, "x": x, "y": y,
                              "bl": bl, "adv": adv})
                x += body.adv(wd + " ")
    block_h = (y - BUB[1]) + body.desc + 6
    inner = BUB[3] - BUB[1]
    shift = max(0.0, (inner - block_h) / 2 - body_lh * 0.55)
    for wd in words:
        wd["y"] += shift
    text_bottom = y + shift + body.desc + 6

    dev_font = ImageFont.truetype(os.path.join(FD, "Inter-600.ttf"), p(12.5))
    dev_sh = ShapedText(os.path.join(FD, "NotoDevanagari-600.ttf"), p(12.5),
                        supersample=1, devanagari_punct=True)
    dev_text = ("नमस्ते! मैं BookKaro AI हूँ। आपकी ट्रेन यात्रा को आसान और "
                "तनाव-मुक्त बनाने के लिए यहाँ हूँ। बताइए, क्या मदद करूँ?")
    # greedy wrap on the mixed line (measure with the real composited width)
    words_d = dev_text.split()
    dlines, cur = [], ""
    for w in words_d:
        trial = f"{cur} {w}".strip()
        _, tw, _ = composite_line(dev_sh, dev_font, trial, (0, 0, 0, 255))
        if tw <= p(BUB[2] - PILL_X0) - 100 or not cur:
            cur = trial
        else:
            dlines.append(cur)
            cur = w
    if cur:
        dlines.append(cur)
    line_h = int(dev_sh.height / S) + 3
    dev_imgs = [composite_line(dev_sh, dev_font, ln, (*NAVY, 255))[0] for ln in dlines]
    pill = (PILL_X0, min(text_bottom + 16, BUB[3] + 6), BUB[2],
            min(text_bottom + 16, BUB[3] + 6) + len(dev_imgs) * line_h + 16)
    pill_h = pill[3] - pill[1]
    wf_y = max(CHIP_TOP - 14, pill[3] + 10)

    # ---- encoders ----
    os.makedirs(R, exist_ok=True)
    mp4 = os.path.join(R, "bookkaro-talking-hero.mp4")
    webm = os.path.join(R, "bookkaro-talking-hero.webm")
    gif = os.path.join(R, "bookkaro-talking-hero.gif")
    enc = subprocess.Popen(
        [FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", AUDIO,
         "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium",
         "-crf", "20", "-pix_fmt", "yuv420p", "-tune", "stillimage", "-vf",
         f"scale={OW}:{OH}:flags=lanczos", "-movflags", "+faststart",
         "-c:a", "aac", "-b:a", "112k", "-shortest_buf_duration", "1",
         "-max_muxing_queue_size", "4096", mp4],
        stdin=subprocess.PIPE)

    marks = [(0.0, 0), (LEAD - 0.10, 1), (2.45, 2), (6.10, 1), (dur + 0.15, 0)]

    def pose_weights(t):
        wgt = np.zeros(3, dtype=np.float32)
        cur = marks[0][1]
        nxt = None
        for m, idx in marks:
            if t >= m:
                cur = idx
            elif nxt is None:
                nxt = (m, idx)
        if nxt and t > nxt[0] - XFADE:
            k = (t - (nxt[0] - XFADE)) / XFADE
            k = k * k * (3 - 2 * k)
            wgt[cur] = 1 - k
            wgt[nxt[1]] = k
        else:
            wgt[cur] = 1.0
        return wgt

    for i in range(n_frames):
        t = i / FPS
        vol = float(a[i])
        speaking = LEAD * 0.8 < t < dur + LEAD + 0.20
        comp = base.copy()
        d = ImageDraw.Draw(comp, "RGBA")

        # ---------------- avatar ----------------
        w = pose_weights(t)
        stack = np.zeros((ph, pw, 4), dtype=np.float32)
        for k in range(3):
            if w[k] > 1e-3:
                stack += avatar_np[k] * np.float32(w[k])
        img = Image.fromarray(np.clip(stack, 0, 255).astype(np.uint8), "RGBA")
        bob = math.sin(t * math.pi * 2 * 0.61) * (1.8 + 7.0 * vol)
        sway = math.sin(t * math.pi * 2 * 0.29 + 1.1) * (1.4 + 2.6 * vol)
        sc = 1.0 + (0.005 * math.sin(t * math.pi * 2 * 0.55) + 0.009 * vol)
        iw, ih = img.size
        img = img.resize((int(iw * sc), int(ih * sc)), Image.BILINEAR)
        cx, cy = img.width // 2, img.height // 2
        dy = int(round(bob * S))
        img = img.crop((cx - iw // 2, cy - ih // 2 - dy, cx + iw // 2,
                        cy + ih // 2 - dy))
        plate = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
        plate.paste(img, (int(sway * S), 0))
        if speaking:
            glow = int(60 + 165 * vol)
            pulse = 0.55 + 0.45 * math.sin(t * math.pi * 2 * 1.2)
            for ring, alpha in ((5, int(glow * 0.25 * pulse)),
                                (3, int(glow * 0.45 * pulse)),
                                (1, int(glow * 0.85))):
                ImageDraw.Draw(plate).rounded_rectangle(
                    [ring, ring, pw - 1 - ring, ph - 1 - ring],
                    radius=p(26 - ring), outline=(*ORANGE, min(255, alpha)),
                    width=p(2))
        comp.alpha_composite(plate, (p(PANEL[0]), p(PANEL[1])))
        d = ImageDraw.Draw(comp, "RGBA")

        # AI-voice badge on the plate (also serves as uniform branding)
        bw = badge_f.adv("BookKaro AI") + 26
        bx, by = PANEL[0] + 18, PANEL[3] - 42
        d.rounded_rectangle([p(bx), p(by), p(bx + bw), p(by + 26)], radius=p(13),
                            fill=(255, 255, 255, 232), outline=(*ORANGE, 170),
                            width=p(1))
        badge_f.paint(comp, bx + 22, by + 19, "BookKaro AI", ORANGE_DEEP)
        d.rounded_rectangle([p(bx + 8), p(by + 9), p(bx + 11), p(by + 17)],
                            radius=p(1), fill=ORANGE)
        d.rounded_rectangle([p(bx + 13), p(by + 7), p(bx + 16), p(by + 19)],
                            radius=p(1), fill=ORANGE)

        # ---------------- bubble words ----------------
        prog = min(1.0, max(0.0, (t - LEAD) / (dur * 0.985))) if t > LEAD * .4 else 0.0
        shown = int(prog * len(words)) if prog < 1 else len(words)
        for idx, wd in enumerate(words):
            if idx >= shown:
                break
            if wd["kind"] == "glyph":
                comp.alpha_composite(wd["img"], (p(wd["x"]), p(wd["y"] - 20)))
            else:
                comp.alpha_composite(wd["img"], (p(wd["x"]), p(wd["y"]) - wd["bl"]))
        d = ImageDraw.Draw(comp, "RGBA")
        if t < LEAD * 0.8:                     # thinking dots
            for k in range(3):
                ph2 = 0.5 + 0.5 * math.sin(t * 7 + k)
                rr = 4.0 + 2.2 * ph2
                ccx, ccy = p(BUB[0] + pad_x + 12 + k * 21), p(words[0]["y"] - 10)
                d.ellipse([ccx - p(rr), ccy - p(rr), ccx + p(rr), ccy + p(rr)],
                          fill=(*ORANGE, int(80 + 140 * ph2)))
        elif 0 < shown < len(words) and int(t * 2.6) % 2 == 0:
            nx = words[shown]
            d.rectangle([p(nx["x"] + 1), p(nx["y"] - 19), p(nx["x"] + 3),
                         p(nx["y"] + 3)], fill=ORANGE)
        if t > dur + LEAD - 0.35:               # prompt back to the user
            q = "Aap bataiye?"
            qw = small.adv(q)
            d.rounded_rectangle([p(BUB[2] - qw - 42), p(BUB[3] - 44), p(BUB[2] - 20),
                                 p(BUB[3] - 14)], radius=p(15), fill=(*TEAL, 26),
                                outline=(*TEAL, 130), width=p(1))
            small.paint(comp, BUB[2] - qw - 31, BUB[3] - 22, q, TEAL)

        # ---------------- devanagari subtitle pill ----------------
        d.rounded_rectangle([p(pill[0]), p(pill[1]), p(pill[2]) - 1, p(pill[3]) - 1],
                            radius=p(20), fill=(255, 244, 229, 208),
                            outline=(*ORANGE, 95), width=p(1))
        d.text((p(pill[0] + 18), p(pill[1] + 8)), "हिन्दी",
               font=ImageFont.truetype(os.path.join(FD, "NotoDevanagari-600.ttf"),
                                       p(11)), fill=ORANGE_DEEP)
        reveal = min(1.0, max(0.0, (t - LEAD) / (dur * 0.8)))
        for j, im in enumerate(dev_imgs):
            if j / max(1, len(dev_imgs)) > reveal + 0.55:
                continue
            comp.alpha_composite(im, (p(pill[0] + 74),
                                     p(pill[1] + 8 + j * line_h)))
        d = ImageDraw.Draw(comp, "RGBA")

        # ---------------- waveform ----------------
        nbars = 30
        span = BUB[2] - BUB[0] - 16
        for k in range(nbars):
            ph2 = 0.5 + 0.5 * math.sin(t * math.pi * 2 * 1.7 + k * 0.5)
            amp = (1.4 + 12 * vol * ph2) if speaking else (1.4 + 2.0 * ph2)
            x0 = p(BUB[0] + 8 + k * (span / nbars))
            col = ORANGE if k % 5 == 0 else TEAL
            d.rounded_rectangle([x0, p(wf_y - amp), x0 + p(7), p(wf_y + amp)],
                                radius=p(3.5), fill=(*col, 205 if speaking else 80))

        # header online dot pulse
        dp = 0.5 + 0.5 * math.sin(t * math.pi * 2 * (2.2 if speaking else 0.9))
        opx, opy = p(CARD[0] + 90), p(CARD[1] + 55)
        rr = 4.5 + 2.4 * dp
        d.ellipse([opx - p(rr), opy - p(rr), opx + p(rr), opy + p(rr)],
                  fill=(*TEAL, 60))
        d.ellipse([opx - p(4), opy - p(4), opx + p(4), opy + p(4)], fill=TEAL)

        enc.stdin.write(np.asarray(comp.convert("RGB"), dtype=np.uint8).tobytes())

    enc.stdin.close()
    rc = enc.wait()
    print("mp4 rc", rc, os.path.getsize(mp4) if os.path.exists(mp4) else "FAILED")

    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", mp4, "-c:v", "libvpx-vp9",
                    "-b:v", "0", "-crf", "34", "-row-mt", "1", "-tile-columns", "2",
                    "-cpu-used", "4", "-pix_fmt", "yuv420p", "-an", webm],
                   capture_output=True)
    print("webm", os.path.getsize(webm) if os.path.exists(webm) else "skip")

    tlen = min(total, 9.2)
    pal = "/tmp/bookkaro-pal.png"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", mp4, "-frames:v", "1",
                    "-vf", f"select='eq(n\\,0)+eq(n\\,{int(tlen * FPS)})'",
                    "-vsync", "0", f"/tmp/bookkaro-seek-%d.png"], capture_output=True)
    subprocess.run([FFMPEG, "-y", "-v", "error", "-t", f"{tlen:.2f}", "-i", mp4, "-vf",
                    "fps=12,scale=800:-2:flags=lanczos,palettegen=stats_mode=diff",
                    pal], capture_output=True)
    subprocess.run([FFMPEG, "-y", "-v", "error", "-t", f"{tlen:.2f}", "-i", mp4,
                    "-i", pal, "-filter_complex",
                    "[0:v]fps=12,scale=800:-2:flags=lanczos[x];[x][1:v]"
                    "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
                    "-loop", "0", gif], capture_output=True)
    print("gif", os.path.getsize(gif) if os.path.exists(gif) else "skip")
    print(f"frames {n_frames} | dur {dur:.2f}s | total {total:.2f}s | "
          f"words {len(words)} | dev lines {len(dev_imgs)}")


if __name__ == "__main__":
    main()
