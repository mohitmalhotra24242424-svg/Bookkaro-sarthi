# Deploy BookKaro to Render

Render is a **better fit than Vercel for this app** because it runs a single
long-lived Node process instead of per-request serverless functions. The real AI
gateway (`GPT-OSS-20B → Nemotron`) legitimately takes **11–22 seconds** to
respond — Vercel Hobby caps a function at ~10s, which is exactly why the AI used
to time out and fall back to the bot. On Render there is **no per-request
duration cap**, so the AI answers reliably.

Every env value we've already tested against the production API works on Render
too — the server is identical; only the host changes.

---

## Prerequisites
- A [Render](https://render.com) account (free tier is fine to start; `starter`
  is recommended for live AI).
- This project's GitHub repo (Render deploys from a Git repo). If you don't have
  a repo, push `bookkro/` (the zip) to one first.

---

## Option A — Deploy from the Render Dashboard (easiest)

1. **Push this project to GitHub** (public or private).
   ```
   cd bookkro
   git init && git add -A && git commit -m "Render deploy"
   git remote add origin https://github.com/<you>/bookkro.git
   git push -u origin main
   ```
2. In the Render dashboard: **New → Blueprint**.
3. Select your repo. Render reads `render.yaml` automatically and pre-fills the
   service (name `bookkroai`, runtime node, build + start commands).
4. Click **Apply / Deploy**. Render builds `npm ci && npm run build`.
5. **Set the environment variables** (this is the critical step). In the
   service's **Environment** tab, add the secrets. All keys **must** be set for
   live AI + live train data:

   | Key | Required | Example value |
   |---|---|---|
   | `RAILWAY_PROVIDER` | yes | `RAILCORE` |
   | `RAILCORE_API_KEY` | yes | your RailCore key |
   | `RAILKIT_API_KEY` | yes | your RailKit key |
   | `AI_PROVIDER` | yes | `nvidia` |
   | `NVIDIA_API_KEY` | yes | your NVIDIA key |
   | `GPT_OSS_MODEL` | yes | `openai/gpt-oss-20b` |
   | `NVIDIA_MODEL` | yes | `nvidia/nemotron-3.5-lightning-30b-a3b` |
   | `CORS_ORIGIN` | no | `*` (default) or comma-separated origins |
   | `PORT` | no | set automatically by Render |

   > Do **not** set `PORT` yourself — Render injects it.

6. Save, then **Redeploy**. Your service gets a URL like
   `https://bookkroai.onrender.com`.

---

## Option B — Deploy from the CLI

```bash
npm i -g @render/cli
render login                      # pastes a token from your dashboard
render blueprint launch           # Render reads render.yaml
render services deploy            # push + deploy
```

---

## Verify it's live
- **Health:** `curl https://<your-app>.onrender.com/api/health`
  → look for `"aiProvider":"nvidia-gateway:..."` and
  `"aiOrchestrator":"IMPLEMENTED"`.
- **AI understands (not the bot):**
  ```bash
  curl -X POST https://<your-app>.onrender.com/api/chat \
    -H 'content-type: application/json' \
    -d '{"message":"12014 ka live status batao","userId":"u","conversationId":"t1"}'
  ```
  The response should show `"usedFallbackNlu": false` with
  `"intent":"LIVE_TRAIN_STATUS"` and `"executedTools":["getLiveStatus"]`. If it
  shows `true`, the AI env vars are missing — check the Environment tab.
- **Frontend:** open `https://<your-app>.onrender.com/` → the chat UI loads.

---

## Notes & differences vs Vercel
- **Long-running process**: conversation state is kept in memory across turns
  (more reliable for multi-turn chats than Vercel's recycling serverless).
- **No function-duration cap**: 11–22s AI calls are fine. No `maxDuration`
  hacks needed.
- **This app is dual-mode.** `api/main.ts` is the long-running server Render
  uses (`npm start`). `api/index.ts` is the Vercel serverless adapter and is
  ignored on Render.
- **Static frontend** is served by the same Node process from `dist/public`
  (copied by `npm run build`). No separate static host needed.

---

## Retiring Vercel (optional)
`bookkroai.vercel.app` stays live unless you say otherwise. To retire it, just
delete the Vercel project from the dashboard — the Render URL becomes the only
host.
