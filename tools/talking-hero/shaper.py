"""HarfBuzz-shaped text rendering into PIL images.

The sandbox has no fontconfig and Pillow was built without raqm, so PIL alone
cannot shape complex scripts (Devanagari conjuncts / matras come out wrong).
This module drives uharfbuzz's own outline rasteriser instead: shape the line
with HarfBuzz, rasterise it into one bottom-up bitmap, then blit it onto a PIL
image with a fixed baseline, so word-by-word reveals stay aligned.

Calibration (uharfbuzz 0.56 / harfbuzz 14.3):
  * ``font.scale`` is 26.6 fixed point -> ``(px * 64, px * 64)``
  * ``RasterDraw.scale_factor = 64``   -> the rasteriser works in device pixels
  * per-glyph ``RasterDraw.transform`` translation is in *font* (26.6) units,
    y points UP from the baseline
  * ``render()`` returns a tight, y-flipped (bottom-up) bitmap; ``y_origin`` is
    the distance from the baseline to the bottom of that bitmap.
"""
from __future__ import annotations

import numpy as np
import uharfbuzz as hb
from PIL import Image, ImageDraw, ImageFont

K = 64.0
DEVANAGARI_PUNCT = {"!": "\u0964"}      # the Devanagari subset lacks U+0021
_FACES: dict[str, hb.Face] = {}
_FE: dict[int, tuple[int, int]] = {}
_PROBE: dict[int, tuple[int, int]] = {}

_PROBE_STRINGS = (
    "\u0915\u094d\u0937\u094d\u091f\u094d\u0930\u094d\u091c\u094d\u091e"
    "\u0930\u094d\u0915\u094d\u0937\u093f\u094d\u0924\u094d\u0924\u094d"
    "\u0900\u0901\u0902\u0950\u0964\u0939\u094d\u0923\u094d\u0921"
    "\u0907\u0947\u094b\u0943\u090c\u0960\u0961\u0970"
    "gfjhklqpy|_,;%#()?VXZ",
)


def _face(path: str) -> hb.Face:
    if path not in _FACES:
        _FACES[path] = hb.Face(hb.Blob(open(path, "rb").read()))
    return _FACES[path]


class ShapedText:
    """One font at one pixel size. ``baseline`` is shared by all its images."""

    def __init__(self, path: str, size: int, supersample: int = 2,
                 devanagari_punct: bool = False):
        self.path = path
        self.ss = supersample
        self.size = int(size) * supersample
        self.face = _face(path)
        self.font = hb.Font(self.face)
        self.font.scale = (int(self.size * K), int(self.size * K))
        self.devpunct = devanagari_punct
        self._cache: dict[tuple, tuple] = {}
        self.pad = max(2, int(self.size * 0.06))
        asc, desc = self._extents()
        self.ascent, self.descent = asc, desc
        self.baseline = asc + self.pad
        self.height = asc + desc + 2 * self.pad

    # ── internals ─────────────────────────────────────────────────────────
    def prep(self, text: str) -> str:
        if self.devpunct:
            return "".join(DEVANAGARI_PUNCT.get(c, c) for c in text)
        return text

    def _shape(self, text: str):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.font, buf, {"kern": True, "liga": True, "calt": True,
                                 "akhn": True, "rphf": True, "half": True,
                                 "pres": True})
        return buf

    def _extents(self) -> tuple[int, int]:
        key = id(self.face)
        if key not in _FE:
            try:
                fe = self.face.get_font_extents("dflt")
                _FE[key] = (int(fe.ascender / K), int(-fe.descender / K))
            except Exception:
                asc, desc = ImageFont.truetype(self.path, self.size).getmetrics()
                _FE[key] = (int(asc * self.ss), int(desc * self.ss))
        return _FE[key]

    def _rasterise_line(self, text: str):
        """-> (bottom-up uint8 array, x_origin_px, y_origin_px, advance_26.6)"""
        buf = self._shape(self.prep(text))
        gi, gp = buf.glyph_infos, buf.glyph_positions
        if not gi:
            return None
        rd = hb.RasterDraw(self.font)
        rd.scale_factor = (K, K)
        pen = 0.0
        for info, pos in zip(gi, gp):
            if info.codepoint:
                rd.transform = (1, 0, 0, 1, int(pen * K + pos.x_offset),
                                int(pos.y_offset))
                rd.draw_glyph(self.font, info.codepoint)
            pen += pos.x_advance / K
        img = rd.render()
        if img is None:
            return None
        e = img.extents
        a = np.frombuffer(bytes(img.buffer), dtype=np.uint8).reshape(
            e.height, e.stride)[:, : e.width]
        return a, int(e.x_origin / K), int(e.y_origin), sum(
            p.x_advance for p in gp)

    def _probe(self) -> tuple[int, int]:
        """Ink extents above / below the baseline for this face."""
        key = id(self.face)
        if key in _PROBE:
            return _PROBE[key]
        fa, fd = self._extents()
        top = bot = 0
        for probe in _PROBE_STRINGS:
            got = self._rasterise_line(probe)
            if got is None:
                continue
            a, xo, yo, adv = got
            ys, _ = np.where(a > 6)
            if not len(ys):
                continue
            top = max(top, int(ys.max() - yo))                 # above baseline
            bot = max(bot, int(yo - ys.min()))                  # below baseline
        asc = max(fa, top + 1, int(self.size * 0.86))
        desc = max(fd, bot + 1, int(self.size * 0.24))
        _PROBE[key] = (asc, desc)
        return asc, desc

    # ── public ──────────────────────────────────────────────────────────────
    def advance(self, text: str) -> int:
        buf = self._shape(self.prep(text))
        return int(round(sum(p.x_advance for p in buf.glyph_positions) / K
                         / self.ss))

    def render(self, text: str, colour=(0, 0, 0, 255)):
        """-> (RGBA image of fixed height, advance_px, baseline_y)."""
        key = (text, tuple(colour))
        if key in self._cache:
            return self._cache[key]
        adv = self.advance(text)
        blank = (Image.new("RGBA", (1, self.height // self.ss), (0, 0, 0, 0)),
                 adv, self.baseline // self.ss)
        got = self._rasterise_line(text)
        if got is None:
            self._cache[key] = blank
            return blank
        a, xo, yo, adv26 = got
        ys, xs = np.where(a > 6)
        if not len(ys):
            self._cache[key] = blank
            return blank
        flip = a[::-1]                                     # bottom-up -> top-down
        h = a.shape[0]
        c_top, c_bot = h - ys.max() - 1, h - ys.min()      # rows in flip space
        c_left, c_right = xs.min(), xs.max() + 1
        crop = flip[c_top:c_bot, c_left:c_right]
        # bottom-most ink row (c_bot-1 in flip space) must sit on the baseline row
        oy = self.height - 1 - (yo + self.pad) - (c_bot - 1)
        ox = xo + c_left
        W = max(ox + crop.shape[1], 1)
        canvas = np.zeros((self.height, W), dtype=np.uint8)
        y0, y1 = max(0, oy), min(self.height, oy + crop.shape[0])
        x0, x1 = max(0, ox), min(W, ox + crop.shape[1])
        if y1 > y0 and x1 > x0:
            canvas[y0:y1, x0:x1] = crop[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
        mask = Image.fromarray(canvas, "L")
        if self.ss > 1:
            mask = mask.resize((max(1, mask.width // self.ss),
                                max(1, mask.height // self.ss)), Image.LANCZOS)
        out = Image.new("RGBA", mask.size, tuple(colour))
        out.putalpha(mask)
        res = (out, int(round(adv26 / K / self.ss)), int(round(self.baseline
                                                                / self.ss)))
        self._cache[key] = res
        return res

    def paint(self, target: Image.Image, xy, text: str, colour=(0, 0, 0, 255)):
        im, adv, _ = self.render(text, colour)
        if im.width > 1 and im.height > 1:
            target.alpha_composite(im, (int(xy[0]), int(xy[1])))
        return adv

    def paint_baseline(self, target: Image.Image, x, baseline_y, text,
                       colour=(0, 0, 0, 255)):
        """Blit ``text`` so its baseline lands on ``baseline_y``; -> advance."""
        im, adv, b = self.render(text, colour)
        if im.width > 1 and im.height > 1:
            target.alpha_composite(im, (int(x), int(baseline_y - b)))
        return adv


def wrap(text: str, font: ShapedText, max_w: int):
    lines, cur = [], ""
    for w in text.split():
        trial = (cur + " " + w) if cur else w
        if font.advance(trial) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ── mixed-script line helper ───────────────────────────────────────────────
def _is_latin(ch: str) -> bool:
    o = ord(ch)
    return not (0x0900 <= o <= 0x097F or 0xA5E0 <= o <= 0xA5FF or o in (0x0964, 0x0965))


def composite_line(dev: ShapedText, latin_font, text: str, colour=(0, 0, 0, 255)):
    """Paint a mixed Devanagari/Latin line on one baseline.

    Devanagari runs go through the HarfBuzz raster (correct conjuncts and
    matras); Latin runs are drawn with a plain PIL font, because the Devanagari
    subset lacks ASCII punctuation and Latin letters.
    Returns (RGBA image, advance_px, baseline_px).
    """
    runs, cur, flag = [], "", None
    for ch in text:
        f = _is_latin(ch)
        if flag is None or f == flag:
            cur += ch
        else:
            runs.append((flag, cur))
            cur = ch
        flag = f
    if cur:
        runs.append((bool(flag), cur))

    def width(flag, seg):
        return int(latin_font.getlength(seg)) if flag else dev.advance(seg)

    adv = sum(width(flag, seg) for flag, seg in runs if seg)
    img = Image.new("RGBA", (max(1, adv + 4), dev.height), (0, 0, 0, 0))
    x = 2
    for flag, seg in runs:
        if not seg:
            continue
        if flag:
            w = int(latin_font.getlength(seg))
            ImageDraw.Draw(img).text((x, dev.baseline - latin_font.getmetrics()[0]),
                                     seg, font=latin_font, fill=colour)
            x += w
        else:
            im, a, b = dev.render(seg, colour)
            if im.width > 1:
                img.alpha_composite(im, (x, dev.baseline - b))
            x += a
    bbox = img.getbbox()
    if bbox:
        img = img.crop((0, 0, min(img.width, bbox[2] + 2), img.height))
    return img, x - 2, dev.baseline
