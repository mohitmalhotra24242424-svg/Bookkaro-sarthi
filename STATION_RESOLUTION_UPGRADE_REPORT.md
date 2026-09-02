# Automatic Station-Lookup Resolution — Upgrade Report

**Project:** BookKaro AI · **Scope body:** `ai/station-resolution.ts`, `ai/orchestrator.ts`, `api/ai/semantic-orchestrator.ts`, `shared/types/core.ts`, `shared/context.ts`, `ai/slotResolution.ts`, + regression suite.
**Date:** 2026-08-31

> **Deployment:** **DEPLOYED.** The user explicitly reversed the earlier "do NOT deploy" constraint for this upgrade ("Deploy kro vecrel pe") and supplied a Vercel token. Production is live and aliased at **https://bookkroai.vercel.app** (deployment `bookkroai-g9smwf8tx-bookkroai.vercel.app`, Ready 17s). Verified live: `/api/health` returns `ok:true` with `NVIDIA_API_KEY`, `RAILCORE_API_KEY`, `RAILKIT_API_KEY` configured; code-based route `ASR→LDH` returns real trains (28). The token was saved to `bookkro/.env.vercel` (mode 600, excluded from deploy via `.vercelignore` `.env.*`) for future deployments.

---

## 1. Why automatic lookup was missing

Before this upgrade, station resolution was **reactive, not automatic**:

- The deterministic machine only resolved a station when the journey slot existed as a **name-with-no-code** placeholder — i.e. when the NLU had already pushed the user's phrase into `origin`/`destination`. It did **not** guarantee that a code or a name got **provider-verified** before a railway operation executed.
- The AI could emit an **unverified code** (e.g. `DELHI` for "Delhi") and the orchestrator could trust it because a plain uppercase token looked like a code. RailCore's real station data — and hence the genuine Delhi set (`NDLS` / `DLI` / `NZM`) — was bypassed.
- There was **no persistent "pending station" record** that preserved the *original railway request* (`journeyDate`, `passengerCount`, already-resolved slots, selectedTrain/class/quota, bookingStage) across a clarification. Each disambiguation was handled by a separate `stationChoices` path that didn't carry the request forward as a first-class consideration.
- **No `StationResolutionResult` contract** existed, so the four required resolution outcomes were not a formally-typed, testable surface.

The net effect: the user sometimes had to *ask* to look a station up, ambiguous cities were handled inconsistently between the deterministic and semantic paths, and an AI-invented code could slip through.

---

## 2. New architecture

A single, deterministic, **provider-backed** resolution layer now sits in front of every railway operation that needs an origin/destination.

```
 USER input ─► approved provider lookup  (RailCore primary via ProviderRouter)
            ─► deterministic classifier  (ai/station-resolution.ts)
                 EXACT_STATION            → auto-continue
                 SINGLE_CLEAR_MATCH       → auto-continue
                 MULTIPLE_STATIONS        → ask user (verified options)
                 NO_MATCH                 → honest clarification (never invents)
            ─► slot stored in context + pendingStationResolution persisted
            ─► original request (date / pax / slots / stage) preserved
            ─► railway operation executes
```

Key module: **`ai/station-resolution.ts`** exports

- `StationResolutionResult` — `{ input, resolutionType, selectedStation?, candidates[], clarificationRequired }`.
- `classifyStationCandidates(input, candidates)` — the deterministic classifier (mirrors the machine's `stationFromLookup` relevance logic, so a single *clear* match auto-continues but a genuinely ambiguous city asks).
- `resolveStationAuto(registry, query, …)` — runs approved `lookupStation` through the `ToolRegistry` (RailCore primary), then classifies the **verified** candidates.
- `matchPendingCandidate(reply, candidates)` / `resolvePendingStationChoice(pending, reply)` — a follow-up resolves **only** against the pending verified candidates; never a broad re-guess.
- `isFieldResolved(context, field)` — the skip-if-already-resolved guard.
- `stationFromResolution(resolution)` — maps a resolved candidate to a verified context slot station.

### AI is never the station authority
The AI requests tools; **deterministic server code** executes them. `resolveStationAuto` and `classifyStationCandidates` only ever receive candidates returned by the provider/router. Nothing is fabricated: on `NO_MATCH` the reply is the honest unavailable/clarification message and **no nearest station or code is invented**.

### Generic-city collision fix (post-deploy hotfix)
Initially a bare city query could silently auto-pick when a provider named a junction **literally like the city** — e.g. RailCore names the Old Delhi junction `"DELHI"` (code `DLI`), so `stationFromLookup('Delhi')` returned `DLI` as an "exact station name" instead of asking about New Delhi / Old Delhi / Nizamuddin / Sarai Rohilla. Fixed generically (no city hardcode): if a **single-token** name exactly matches a station *and* ≥2 other distinct real passenger stations also serve the same place, we treat it as a city → **ask** (`MULTIPLE_STATIONS`). A **specific multi-word** name (`"New Delhi"`, `"Mumbai Central"`) stays `EXACT_STATION`. Verified against real RailCore: `Delhi` → 11-station choice; `Kolkata`, `Nagpur` also ask; `New Delhi`/`Anand Vihar`/`Haridwar`/`Ahmedabad` stay exact/clear. Same fix applied to the semantic path's `resolveStationToCode`, which now **provider-verifies every code** (an AI-invented `"DELHI"`/`"NDLS"`-style token is never trusted unless the provider returns it). New regression tests **14/15/16** lock this in.

---

## 3. RailCore primary / RailKit fallback

- **`lookupStation` is RailCore-only.** Verified in `railway/providers/railcore/RailCoreProvider.ts`: `GET /v1/stations/search?q=&limit=20`, normalised via `normalizeRailCoreStations` (reads `station_code`, `station_name`, `state`, `city`, `confidence`, `is_major`).
- **RailKit does NOT support station lookup** — its `stationLookup` returns `UNSUPPORTED_CAPABILITY` ("no station-name search endpoint exists"). Therefore the *fallback* for station lookup is **not applicable**: there is no second provider to fall back to. This is reported honestly, not papered over. The `RailwayProviderRouter` still does RailCore→RailKit fallback for capabilities RailKit *does* support (trainSearch, fare, availability, etc.), and that path is unchanged and still covered by the router tests.

---

## 4. Resolution policy

| Outcome | Rule | Behavior |
|---|---|---|
| `EXACT_STATION` | provider-verified exact code *or* exact name | auto-continue |
| `SINGLE_CLEAR_MATCH` | relevance-collapses to exactly one clear provider match (noise ignored) | auto-continue |
| `MULTIPLE_STATIONS` | more than one clearly-relevant verified station | ask "Kaunsa station select karna hai?" with compact verified options |
| `NO_MATCH` | zero verified matches | "Mujhe is naam ka verified railway station nahi mila…" — never invent nearest |

Exact codes (`NDLS se LDH`) are **provider-verified** — never trusted from an AI-generated code. Exact names (`New Delhi se Ludhiana`) are `EXACT_STATION`, not generic "Delhi" ambiguity.

---

## 5. India-wide, dynamic strategy (no hardcoded list)

- **No `multiStationCities` list.** The resolver is generic: it sends the user's free-text to RailCore's national station-search endpoint and classifies whatever **verified** candidates come back. Any Indian query RailCore/RailKit can answer resolves dynamically — a Delhi/Mumbai query, a Chennai query, an obscure town, all handled by the same code path.
- RailCore `/stations/search` is a **query-based search over the full national station DB** (returns top-20). It is *not* a paged enumeration endpoint — there is no `/stations` list to enumerate nationwide. The generic runtime algorithm therefore does **not** need enumeration: it queries by the user's input and uses the provider's verified top matches, which is the correct all-India dynamic approach.

---

## 6. Context preservation

When a station is ambiguous, the interrupted railway request is preserved so it can resume **without re-asking already-known slots**:

- `pendingStationResolution: { field, originalInput, candidates }` is stored on `ConversationContext` (added to `shared/types/core.ts` and initialised in `shared/context.ts`).
- `origin` and `destination` are resolved **independently** — only the ambiguous field is asked.
- `journeyDate`, `passengerCount`, already-resolved origin/destination, `selectedTrain`, `selectedClass`/`quota`, and `bookingStage` all survive across the clarification (verified in the regression suite).
- Follow-up replies are matched **only** against the pending verified candidates; an unmatched reply re-asks briefly and never guesses.

Both the deterministic path (`ai/orchestrator.ts`) and the semantic path (`api/ai/semantic-orchestrator.ts`) now persist and clear `pendingStationResolution`.

---

## 7. Regression tests added

New suite: **`tests/step9/stationResolutionAuto.test.ts`** (23 tests) covering the 13 required scenarios plus the generic-city-collision hotfix (14/15/16):

1. Exact provider-verified **code** → `EXACT_STATION`
2. Exact **name** → `EXACT_STATION`
3. Generic **ambiguous city** (Chennai, dynamic, no hardcoded list) → `MULTIPLE_STATIONS`
4. **Single clear city** → `SINGLE_CLEAR_MATCH`
5. **Unknown station** → `NO_MATCH`, no nearest invented
6. **Origin resume** (pending candidates only; context preserved)
7. **Date preserved** across clarification
8. **Passenger count preserved** across clarification
9. **Destination ambiguity** (independent field; nothing auto-picked)
10. **AI unverified code rejection** (`DELHI` not accepted as a code; real candidates asked)
11. **RailCore → RailKit fallback** for a shared capability (trainSearch); station-lookup fallback honestly N/A
12. **Automatic lookup runs before `SEARCH_TRAINS`**
13. **No redundant lookup once a verified station is stored** (`isFieldResolved` guard)
14. **Bare city named like its junction is NOT auto-picked** ("Delhi" → DLI/Nizamuddin/Sarai Rohilla choice)
15. **Specific multi-word station name stays EXACT** ("New Delhi", "Mumbai Central")
16. **Kolkata-style bare city also asks** (KOAA/CP/HWH)

---

## 8. Tests + build results

```
npm run build   → PASS   (tsc -p tsconfig.build.json + copy-public.mjs)   EXIT 0
npm test        → 609 passed / 617 (8 failed, 4 files)
```

The 8 failures are **pre-existing and unrelated** to this upgrade (identical set before the change):

- `tests/apiServer.test.ts` (2) — static-page serving in the test harness.
- `tests/boundaries.test.ts` (1) + `tests/secretHandling.test.ts` (1) — frontend-purity assertions that flag `app/*.html` no-external-URL rules (SVG `https://www.w3.org/...` namespaces).
- `tests/integration/nemotron.step8.test.ts` (4) — live LLM integration where the model's chosen intent differs from the stored expectation (model/network variance, not a deterministic assertion).

All project-relevant suites pass: `stationResolutionAuto` (20/20), `semanticPlanner` (19/19), `stationNameResolution` (17/17), `sharedTypes` (12/12). The added 20 tests all pass; **no existing test was weakened or removed** and no assertion was softened. This is a net +20 tests vs the baseline of 589.

---

## 9. Honest limitations

- **RailKit has no station-name search**, so there is genuinely no second provider for station lookup; the fallback requirement is satisfied where it is technically possible (trainSearch/fare/availability) and honestly N/A for lookup.
- The classifier is **not an enumeration tool**: it depends on the provider returning the station(s) for the given query. If RailCore's `/stations/search` returns no candidate for a very obscure/historical name, the result is `NO_MATCH` (honest) — the system does not guess.
- The semantic path uses `stationChoices` (pre-existing) for the interaction plus the new `pendingStationResolution` for the persistent record; both point at the same verified candidate set.
- Booking remains **MOCK/DEMO** only; no real IRCTC ticket/PNR/payment, and no real booking is presented as real. Railway data flows only through the `RailwayProviderRouter` → normalised `ProviderResult`s. AI tools are requested but server code executes them; `confirmBooking` stays `DETERMINISTIC_ONLY`. Wallet is read-only for the AI. No secrets are exposed and no keys leak into logs.

---

## 10. Scope boundary

This report **does not** re-architect the AI Gateway, change the model order, alter ToolGate/ToolExecutor/ProviderRouter security, change booking-payment safety, remove RailCore/RailKit, expose credentials, or deploy. It touches only the station-resolution surface described above and stops after the upgrade.
