# BookKaro ko GitHub Pages par deploy karna (3 steps)

## 1) GitHub par repo banao
- github.com → **New repository** → naam: `bookkaro` (ya jo chaho) → **Private/Public** dono chalega → **Create**.
- (Repo banaate waqt README/license add karne ki zaroorat nahi — sab already hai.)

## 2) Code push karo (project folder ke andar)

```bash
cd bookkaro-project-folder
git remote add origin https://github.com/<username>/bookkaro.git
git push -u origin main
```
(Pehla commit already ho chuka hai — `git log` se check kar sakte ho.)

## 3) Pages on karo
- Repo → **Settings → Pages → Source: GitHub Actions** select karo → Save.
- **Actions** tab mein "Deploy site to GitHub Pages" workflow khud chalega.
- 1-2 minute mein site live: `https://<username>.github.io/bookkaro/`

## Kya kaam karega, kya nahi?
| Cheez | GitHub Pages par |
|---|---|
| Landing page (homepage) | ✅ Poora kaam karega |
| Sample-question chips | ✅ Chat khulega, sawal auto-type |
| Chat ke asli jawab | ⚠️ Backend chahiye — Pages sirf static hai |

### Chat ko live karne ke options
1. **Local server (testing)**: `npm install && npm run build && npm start` → `http://localhost:3000` par poora app (site + chat dono) chalega.
2. **Backend host karo (chat ke asli jawab ke liye)** — repo mein Dockerfile ready hai:
   - **Render.com**: New → Web Service → repo connect → Dockerfile auto-detect → Env Variables mein `.env` ki keys daalo (NVIDIA_API_KEY, NVIDIA_API_KEY_2, NVIDIA_MODEL, RAILCORE_API_KEY, RAILKIT_API_KEY, RAILWAY_PROVIDER). NOTE: Render ab free plan par bhi card verification maangta hai.
   - **Hugging Face Spaces (card-free)**: New Space → Docker → repo ka code push karo → Space Settings → Secrets mein wahi keys daalo. App port 7860 par sunta hai (Dockerfile set karta hai).
   - Deploy hone ke baad chat page ke ⚙️ settings mein server URL daalo (ya `app/config.js` mein default set karo) — CORS enabled hai.

> ⚠️ Keys kabhi git commit nahi hui (.gitignore mein `.env` hai) — server par hi `.env` banao.
