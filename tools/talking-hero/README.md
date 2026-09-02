# BookKaro AI — talking hero (Hindi voice + gestures)

Horizontal (3:2) mobile-homepage hero where the BookKaro AI concierge **speaks
Hindi and gestures**: namaste → open-palm present → questioning tilt, with the
speech bubble typing word-by-word in sync with the real TTS audio, a Devanagari
subtitle line, a live waveform and a pulsing "Online" dot.

```
app/assets/hero-talking.mp4     1.3 MB  H.264 + AAC, 1440x960, 24 fps, 12.2 s  <- use this
app/assets/hero-talking.webm    0.7 MB  VP9 (no audio), smaller for the web
app/assets/hero-talking.gif     3.3 MB  silent fallback (e-mail / README / no-video)
app/assets/hero-concept-3x2.jpg 151 kB  static poster of the same composition
app/assets/pose-{1,2,3}-*.jpg    ~80 kB the three avatar poses (used by the live pages)
app/assets/greeting-hi-full.mp3  42 kB  the Hindi greeting used by the hero
```

Live pages
* `app/hero.html` — the hero video with an "Awaaz chalu karein" (unmute) button,
  GIF + poster fallbacks, download links.
* `app/index.html` and `app/talking-demo.html` — the app shell now layers the
  three pose images inside `.avatar-ring` and cross-fades them while speaking
  (`setGesture()`), plus a `.sub-hi` Devanagari subtitle that reveals in sync.

## Re-rendering

```bash
# one-off deps (network here only reaches pypi.org + the npm registry)
python3 -m venv /home/user/.venv-img
/home/user/.venv-img/bin/pip install pillow numpy uharfbuzz fonttools brotli imageio-ffmpeg

/home/user/.venv-img/bin/python tools/talking-hero/build_hero.py
# quality / speed knobs
HERO_SS=2 HERO_FPS=30 python ... build_hero.py   # crisper, ~3x slower
HERO_LIMIT=60 python ... build_hero.py           # short smoke render
```

The script pipes raw frames straight into ffmpeg (`imageio-ffmpeg` ships a
static binary; the sandbox has no ffmpeg/apt access) and writes
`renders/bookkaro-talking-hero.{mp4,webm,gif}`. Copy the finished files into
`app/assets/` afterwards (the repo keeps the compressed `.jpg`/smaller builds).

### Inputs the script expects

| file | what |
|---|---|
| `renders/hero-voice-hi.mp3` | TTS in Hindi (Devanagari text, female voice) |
| `renders/pose-a-namaste.png` | waist-up avatar, hands folded |
| `renders/pose-b-welcome.png` | same avatar, open palm, mid-speech |
| `renders/pose-c-question.png` | same avatar, head tilt, questioning |
| `app/assets/fonts/*.ttf` | Inter + Noto Sans Devanagari (from `@fontsource`) |

Poses must keep the identical framing / camera / background; the renderer keys
out the flat cream background automatically (`cutout()`).

## Sandbox caveats worth knowing

* **No fonts installed** (`fc-list` = 0) and network is restricted, so the
  TTFs come from `@fontsource/*` npm packages; the variable TTFs were converted
  to static instances with `fonttools` and live in `app/assets/fonts/`.
* **Pillow has no raqm**, so `draw.text()` cannot shape Devanagari (matras and
  conjuncts come out wrong) — `tools/talking-hero/shaper.py` shapes with
  uharfbuzz and rasterises through `hb.RasterDraw` instead. That path is what
  renders the "हिन्दी" subtitle line in the MP4.
* `ImageFont` in Pillow 12 exposes no public per-glyph API, so Latin text is
  drawn directly (no shaping needed) and the mixed Devanagari/Latin line is
  composed run-by-run.
