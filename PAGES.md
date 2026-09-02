# Live public link

**https://mohitmalhotra2527-gif.github.io/Bookkroai/**

| page | what |
|---|---|
| `/hero.html` | talking hero — concierge speaks Hindi + gestures (namaste → open palm → questioning), audio included. Press **“Awaaz chalu karein”** to unmute |
| `/index.html` | app home: avatar pose-cycling while speaking + हिन्दी subtitle |
| `/talking-demo.html` | play/replay demo of the greeting |
| `/landscape.html` | horizontal (landscape) UI |
| `/assets/hero-talking.mp4` | the video file itself (1.3 MB, H.264 + AAC) |
| `/assets/hero-talking.gif` | silent GIF fallback |

Deploy: `.github/workflows/deploy-pages.yml` publishes the `app/` folder on every
push to `main` (so the site is fully static — `chat.html` still needs a backend,
everything else works without one). `app/.nojekyll` keeps the asset paths verbatim.
