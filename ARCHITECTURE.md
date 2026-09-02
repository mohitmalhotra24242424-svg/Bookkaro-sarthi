# BookKaro (RAILBOOK) — Architecture

**Step 1: Fresh technical foundation.** This document describes what EXISTS and
works today, and clearly marks everything that is **NOT IMPLEMENTED**.

BookKaro is an **AI-first railway assistant**. The primary experience is a
conversation ("Mujhe Amritsar se Ludhiana jaana hai"), not a form. The AI
understands the request, keeps multi-turn context, chooses the right railway
tool — and all facts and all money stay under deterministic server-side code.

---

## 1. Directory map

```
/app        Minimal UI shell (static HTML, self-contained). NEVER calls railway APIs.
/api        Server entrypoint (node:http). Health + honest NOT_IMPLEMENTED chat stub.
/ai         AIProvider interface + deterministic mock + NVIDIA/Gemini placeholders.
/tools      Tool registry: definitions, input-schema validation, execution boundary.
/railway    RailwayProvider interface, RailCore/RailKit stubs, provider router.
/booking    Booking state machine + execution guards + draft factory.
/wallet     Wallet service interface + authorization guards (implementation inert).
/shared     Types/contracts, conversation context engine, intent registry, validators.
/tests      129 tests across 12 suites — run without any API keys.
```

Hard boundaries (enforced by tests in `tests/boundaries.test.ts`):

- `/app` contains **zero** railway API calls and **zero** secrets — it may only
  call this app's own `/api/*` routes.
- `/ai` never imports wallet or booking execution code, never debits money,
  never executes bookings, never reads `process.env`.
- Only `/api` touches the environment (`api/config.ts`).

## 2. AI-first flow (target architecture)

```
User
 → AI Orchestrator                    (Step 2 — NOT IMPLEMENTED)
 → Intent + slot extraction           (registry ready, engine NOT IMPLEMENTED)
 → Tool REQUEST                       (AI can only REQUEST)
 → Server-side Tool Validation        (tools/registry.ts + tools/schema.ts — IMPLEMENTED)
 → Deterministic Tool Executor        (boundary IMPLEMENTED, executors NOT IMPLEMENTED)
 → RailwayProviderRouter              (IMPLEMENTED, providers are stubs)
 → Normalized Railway Data            (ProviderResult envelopes — IMPLEMENTED)
 → AI Response                        (AIProvider.generateResponse — interface IMPLEMENTED)
 → User
```

The AI layer can *ask*; only the server *does*. There is no code path where AI
output directly reaches a provider, the wallet, or a booking execution.

## 3. Conversation context (IMPLEMENTED)

`shared/context.ts` + `shared/types/core.ts`. One `ConversationContext` holds
all required fields:

`origin, destination, journeyDate, passengerCount, selectedTrain,
selectedClass, lastSearchResults, lastAskedField, bookingStage, lastIntent,
lastTool, pendingQuestion, userCorrections, pausedBooking, messages`.

- **Multi-turn memory** — `setContextSlots(ctx, slots, 'FILL_MISSING')` fills
  only empty slots, so:

  | Turn | User says | Result |
  |---|---|---|
  | 1 | "Mujhe Amritsar se Ludhiana jaana hai" | origin=ASR, destination=LDH |
  | 2 | "Kal" (AI asked "Kab jaana hai?") | date filled, ASR/LDH preserved |

- **Corrections** — `mode: 'CORRECT'` overwrites a filled slot and appends an
  audit entry to `userCorrections`.
- **Interrupt/resume foundation** (see §10).

## 4. Intent registry (vocabulary IMPLEMENTED, engine NOT IMPLEMENTED)

`shared/intents.ts` — 16 intents: BOOK_TRAIN, SEARCH_TRAIN, LIVE_TRAIN_STATUS,
GET_AVAILABILITY, GET_FARE, GET_TRAIN_INFO, GET_TIMETABLE, LOOKUP_STATION,
CHECK_PNR, VIEW_BOOKINGS, VIEW_WALLET, GET_CANCELLED_TRAINS, COMPARE_TRAINS,
GENERAL_RAILWAY_QUERY, HELP, UNKNOWN. Each has a description, Hinglish example
phrases, suggested tools and a confirmation flag. Tests cross-check that every
suggested tool really exists in the tool registry. **The NLU engine that maps
user language → intent is NOT IMPLEMENTED.**

## 5. Tool registry & validation boundary (IMPLEMENTED; executors NOT IMPLEMENTED)

15 tools defined (`tools/definitions.ts`): searchTrains, lookupStation,
getTrainInfo, getTimetable, getLiveStatus, getAvailability, getFare,
getCancelledTrains, checkPNR, getBookings, getWallet, compareTrains,
createBookingDraft, reviewFare, confirmBooking.

Every tool declares: name, category, typed input schema, output description,
`aiRequestable`, `executionPolicy`, `sideEffects`, `status`, safety notes.

The boundary (`tools/registry.ts` + `tools/schema.ts`):

1. Tool name must be in the whitelist.
2. AI may only request `aiRequestable` tools — **`confirmBooking` is
   DETERMINISTIC_ONLY and rejects AI requests by construction**.
3. Input is schema-validated: unknown fields rejected, strict formats (train
   number 4–6 digits, 10-digit PNR, ISO dates, station codes), numeric ranges,
   and **no string may contain a URL** — the AI can never pick an endpoint.
4. Only then does deterministic server code execute — and in Step 1 every
   executor is absent, so `execute()` honestly returns `NOT_IMPLEMENTED`
   with `data: null`. Zero fabrication by construction.

## 6. AI provider abstraction (IMPLEMENTED; real providers NOT IMPLEMENTED)

`ai/AIProvider.ts` — `understand()` (intent, slots, missing fields, optional
tool REQUEST) and `generateResponse()` (natural reply from tool results).
Orchestration depends only on this interface, so NVIDIA, Gemini or any future
provider slots in without rewriting orchestration. Step 1 ships a deterministic
`MockAIProvider` (zero network, never fabricates) and placeholder
`NvidiaAIProvider` / `GeminiAIProvider` that reject with NOT_IMPLEMENTED.
**No AI credentials exist anywhere.**

## 7. Railway providers: RailCore PRIMARY, RailKit FALLBACK (REAL — Step 2)

`railway/RailwayProvider.ts` — one interface, nine capabilities. Step 2 ships
real adapters with **verified** endpoint contracts:

| | RailCore (primary) | RailKit (fallback) |
|---|---|---|
| Transport | own REST client (`railway/providers/railcore/client.ts`) | official `railkit` npm SDK v4.1.0 |
| Base | `https://ir.railcore.tech/v1` (product spec + docs) | `https://railkit-api.rajivdubey.dev/api` (SDK-owned) |
| Auth | `X-RailCore-Key: $RAILCORE_API_KEY` | `x-api-key` via SDK `configure($RAILKIT_API_KEY)` |
| Verified against | railcore.tech/docs (captured 2026-08-26) | SDK typings + railkit.rajivdubey.dev/docs |
| Capabilities | stationLookup, trainSearch, trainInfo, timetable, liveStatus, availability, fare | trainSearch, trainInfo, timetable (from getTrainInfo route), liveStatus, availability, fare, pnr, cancelledTrains |
| Deliberately absent | pnr, cancelledTrains (RailKit's) | stationLookup (no station-name search endpoint exists — not invented) |

Verified RailCore endpoints: `/stations/search?q=`, `/routes/trains?from=&to=&date=`,
`/trains/{n}`, `/trains/{n}/schedule`, `/trains/{n}/live?date=`,
`/availability/seats?...`, `/fares/estimate?...` — with the documented
`{success, data, meta}` / `{success:false, error{code,message,category,retryable}}`
envelopes. Documented `404 NO_TRAINS_FOUND` / `TRAIN_NOT_FOUND` are treated as
LEGITIMATE empty answers, never fallback triggers. Without a key, every
operation returns a clean `MISSING_CREDENTIALS` error and performs ZERO
network calls.

## 8. Provider router (IMPLEMENTED; exercised with real adapters + mock transports)

Routing results carry provider metadata (`source`, `viaFallback`, `latencyMs`)
which the API layer surfaces as `provider: "railcore"` / `"railkit_fallback"`.
When both providers fail, the HTTP layer normalizes to
`{ success: false, error: "RAILWAY_DATA_UNAVAILABLE" }` (503) with a safe
category — no internal details, no fabricated fallback data.

`railway/router.ts` — every railway query passes through
`RailwayProviderRouter`:

1. **Deterministic query validation first** (invalid input = real answer).
2. **Capability-aware candidate list** (primary → fallback order).
3. **Fallback only for** HTTP error, timeout, rate limit, network error,
   `success:false`/malformed/unusable (incl. thrown) responses.
4. **No fallback for**: invalid queries, legitimate **zero results**
   (NO_RESULTS / NOT_FOUND — real answers), or no provider supporting the
   capability (UNSUPPORTED_CAPABILITY).

## 9. Fact safety (IMPLEMENTED)

`shared/factSafety.ts` — `RailwayFact<T>` is an honest tri-state:
`VERIFIED` (with provider source + retrieval time) / `UNAVAILABLE` / `UNKNOWN`.
Rules: never invent train numbers, station codes, times, fares, availability,
live location, delay, PNR, cancellations; unavailable data is reported
honestly; a VERIFIED fact with no data fails loudly as a fabrication bug.
All money is integer paise (`*Minor` fields). Nullable fields everywhere a
provider may not know a value.

## 10. Booking safety & interrupt/resume (state machine IMPLEMENTED; booking execution NOT IMPLEMENTED)

`booking/states.ts` — stages: IDLE (default, no booking) then the specified
flow: COLLECT_JOURNEY → SEARCH_RESULTS → TRAIN_SELECTED → CLASS_SELECTED →
AVAILABILITY_CHECKED → FARE_REVIEW → WAITING_CONFIRMATION → BOOKING_EXECUTION
→ BOOKING_RESULT, with allowed back/cancel transitions.

`booking/guards.ts` — `evaluateBookingExecution()` is the one gate into
BOOKING_EXECUTION and requires ALL of:

- actor = SERVER (AI → `AI_CANNOT_EXECUTE_BOOKING`, USER → confirms but never
  executes),
- draft at WAITING_CONFIRMATION / AWAITING_CONFIRMATION,
- explicit user confirmation owned by the draft owner,
- a **verified provider fare quote** (source + positive total),
- a non-expired draft.

**Interrupt/resume:** `savePausedBooking()` snapshots the in-flight booking
(stage + slots + results + pending question) when the user interrupts
("12014 ka live status batao"); `restorePausedBooking()` brings it back so
"Kal jaana hai" resumes the original flow. Field foundation + pure functions
are implemented; the orchestrator that decides when to pause/resume is NOT
IMPLEMENTED. **No booking executor exists and no booking can be executed.**

## 11. Wallet safety (interfaces IMPLEMENTED; ledger NOT IMPLEMENTED)

`wallet/` — `WalletService` interface (getWallet, listTransactions, credit,
debit). Step 1's `NotImplementedWalletService` rejects every call, so **no
money can move in this codebase**. `authorizeWalletOperation()`: AI may only
READ; users never mutate the ledger directly; SERVER mutations must pass
deterministic validation (positive integer paise, idempotency key required,
no overdraw).

## 12. Security (IMPLEMENTED)

- `.env.example` contains placeholder names only — `RAILCORE_API_KEY=`,
  `RAILKIT_API_KEY=`, `AI_API_KEY=` — all empty; tests assert it.
- Credentials are server-side only; `api/config.ts` refuses to run in a
  browser-like runtime; only `/api` may touch `process.env`.
- `redactSecrets()` scrubs `KEY=value` and `Authorization` headers from logs;
  startup logs print only whether secrets are configured (booleans).
- `.gitignore` excludes `.env*` (keeps `.env.example`).
- API responses: JSON only, `no-store`, `nosniff`, 32KB body limit,
  path-traversal-safe static serving.

## 13. Minimal UI shell (IMPLEMENTED as a shell)

`app/index.html` — self-contained, mobile-first dark shell showing the planned
conversational experience and an honest STEP 1 notice. The input posts to this
app's own `/api/chat`, which answers 501 NOT_IMPLEMENTED. **The premium
conversational UI is NOT IMPLEMENTED.**

---

## Step 7 additions — full conversational experience

- **Conversation state (§1)**: `ConversationContext` now also carries
  `selectedQuota`, `lastToolResult` (compact `{success, tool, provider, error,
  timestamp}` envelope — no payloads, no secrets), `lastReferencedTrain` (the
  most recently DISCUSSED train) and `pendingFastestHint`. No API keys are ever
  stored in state.
- **Natural follow-ups (§2/§11)**: "uska fare?", "isme availability", "aur
  availability?", "CC mein?" (class refinement right after a fare/availability
  answer) and "ye train kitni late hai?" all resolve from the selected train /
  last-referenced train / selected class — the customer never repeats context.
  A bare class while the assistant is ASKING for a class is the answer, not a
  refinement.
- **Result-detail questions (§2/§10)**: "doosri wali kitni fast hai?" is
  answered factually from the CURRENT result list (no provider call); the
  discussed train becomes `lastReferencedTrain` so the next "uska fare?" binds
  to it.
- **Interrupts (§4-§8)**: glossary questions during a booking now pause +
  answer + resume ("Wapas aapki booking par…"); availability interrupts reset
  nothing; fare interrupts ask for the class only when missing.
- **Dates (§12)**: weekday support — "next Monday", "this weekend" (→ next
  Saturday), Hindi weekday names — resolved deterministically, never silently
  today. Live-status dates never touch the booking date. Date validation clock
  is injectable via the router (tests use a fixed date).
- **Multiple questions (§17)**: "live status + fare + timetable + availability"
  combos select multiple tools and run in parallel; "trains batao aur fastest
  kaunsi hai?" searches first (asks the missing date), then appends a factual
  fastest note from the fresh results (hint survives the date question).
- **Corrections (§15)**: "nahi doosri wali" (selection), "nahi kal nahi parso"
  (date), "nahi Ludhiana se" (origin), passenger corrections, "2 nahi 3
  passengers" (count only) — single-field updates, nothing else wiped. "rukko"
  holds the flow without state changes.
- **Confirmation (§14)**: while a full review is pending, "haan book karo" /
  "book kar do" / "confirm" are accepted YES; anywhere else they never book.
- **§19**: customer replies never name providers/tools — failures say
  "Abhi railway data available nahi ho raha."

## Step 6 additions — AI tool orchestration layer (api/ai/)

- **`api/ai/tool-catalog.ts`** — the approved tool catalog (spec UPPER_SNAKE ids →
  registry tools) with per-tool argument specs. CONFIRM_BOOKING / PAYMENT /
  WALLET_DEBIT are listed as PROHIBITED and rejected BY NAME. Argument
  validation enforces train-number/PNR/date/class/quota/station/passenger
  formats and rejects URL/method/credential keys outright.
- **`api/ai/tool-executor.ts`** — catalog-validated execution with
  **parallel independent calls** (§11) and **MAX_TOOL_CALLS_PER_TURN = 5** (§22).
  Execution goes through the ToolRegistry → ProviderRouter (RailCore primary,
  RailKit fallback — the AI never chooses a provider, never supplies a URL,
  method or key). A conversational-orchestrator budget guard backs this up.
- **`api/ai/model-provider.ts`** — interchangeable model backends from
  AI_PROVIDER / AI_MODEL / AI_API_KEY / AI_BASE_URL: deterministic (offline),
  nvidia, gemini, and any OpenAI-compatible endpoint (RapidAPI-hosted etc.).
  Keys stay server-side; business logic depends only on the AIProvider
  interface.
- **`api/ai/orchestrator.ts`** — the Step-6 API envelope
  `{intent, entities, requiredTools, toolArguments, response, missingSlots,
  interrupt, resumeContext, safety}` over the Steps 3–5 conversational core,
  PLUS dynamic multi-tool selection: "12014 ka fare aur CC availability dono
  batao" selects GET_FARE + GET_AVAILABILITY and executes them in parallel,
  answering from the returned data only. Exposed via `POST /api/chat` as the
  `orchestration` field (UI-compatible reply/cards/panel unchanged).
- NLU: "trains batao/dikhao" journey phrasing, "neeche wali" (last), fastest/
  jaldi-pahunchti comparison from current results, "2 nahi 3 passengers"
  count-only correction (passenger details invalidated, train preserved).

## Step 5 additions — conversational booking journey

**Flow (fully conversational, no form):** journey slots → search (train cards)
→ train selection (number / pehli wali / Shatabdi wali — current list only)
→ class (provider-returned classes only) → FRESH availability (router, one
normalized result) → FRESH fare (railway fare + ₹20 service fee + total, always
separate) → passenger details one field at a time ("Passenger 1 of 2 — naam?")
→ name → age → gender → berth per passenger → FINAL REVIEW (BookingSummary:
only fields that exist) → explicit confirmation → deterministic MOCK booking.

- **State machine** (`shared/bookingFlow.ts`, single source of truth): adds
  PASSENGER_DETAILS_REQUIRED and CONFIRMED / FAILED / CANCELLED. Every
  orchestrator transition is guarded by `canTransitionTo` — the AI cannot jump
  states (illegal transitions are deterministically refused).
- **Mid-flow changes (§12/§22)**: "12014 nahi 14542", "CC nahi SL", "date
  change karni hai", "Ludhiana ki jagah Beas", "passenger change" — only the
  affected field changes and everything downstream is invalidated (class,
  availability, fare, passengers, results) and re-checked fresh. Stale
  fare/availability/results are never reused.
- **Confirmation safety (§14)**: a bare "haan" books ONLY when the immediately
  preceding state is WAITING_CONFIRMATION with a presented full review.
  Otherwise it is politely refused. "book kar do" before review never books.
- **Mock boundary (§16-§18)**: recorded confirmation → verified fare →
  server-side DEMO-wallet balance check → idempotent demo debit → MOCK booking
  (id `MOCK-…`, `pnr: null` ALWAYS, `isDemo: true`). No real ticket, no real
  payment, no PNR — real-looking or otherwise. Insufficient balance → FAILED
  with "Booking complete nahi ho paayi" (failures never reported as success).
- **Demo wallet** (`wallet/MockWalletService.ts`): deterministic in-memory
  ledger with the Step-1 guards (SERVER actor only, idempotency keys, positive
  paise, no overdraft). The AI never queries, decides or debits — only the
  deterministic executor does.
- **Interrupts during passenger details**: live-status/fare questions pause the
  booking snapshot, answer from the provider, and return to the exact pending
  passenger field ("Ab booking continue karte hain…").
- **UI panels (§20/§21/§23)**: train cards + fare summary panel + booking
  review panel + passenger-progress dots; reusable `buildBookingSummary`
  renders only fields that actually exist. No JSON, tool names or logs in chat.

## Step 4 additions — customer-facing assistant polish

- **Multi-intent messages**: "live status batao aur booking continue karte hain" is split
  conservatively (informational first, booking last) with context threading — the booking
  is never lost and the reply ends with the pending booking question.
- **Station ambiguity (§6)**: "Delhi" matching several stations (NDLS/DLI/NZM) produces a
  CHOICE question, never a silent first-pick; the user answers naturally ("New Delhi",
  "doosra", "NZM").
- **Date understanding (§5)**: aaj/kal/parso, ISO dates, dd-mm, and unambiguous
  "27 August" forms; past month-dates are treated as ambiguous (the assistant asks,
  never assumes a year).
- **Route/date corrections invalidate stale results (§24)**: changed origin/destination/
  journeyDate clears old search results and re-searches; only the corrected field changes.
- **References (§9)**: pehli/doosri/teesri/last/upar wali, train numbers AND names
  ("Shatabdi wali") — resolved only against the CURRENT list; no list → the assistant asks.
- **Comparison (§10)**: departure/arrival/duration from stored results PLUS provider
  fares for both trains; factual wording only ("15 minute later nikalti hai"), no
  universal claims.
- **Fare transparency (§13)**: railway fare, BookKaro service fee and total payable are
  always shown separately; UNKNOWN totals are reported unavailable (never approximated).
- **Cancelled trains (§17)**: "12014 cancel hai?" is answered only from the provider's
  cancelled list; station-filtered requests honestly state the provider limitation.
- **Confirmation safety (§20)**: booking flow now reaches a FULL review (train/date/route/
  passengers/class/railway fare/service fee/total) and enters WAITING_CONFIRMATION.
  A bare "haan" is a confirmation ONLY in that state (recorded deterministically via the
  internal acknowledgeBookingConfirmation tool — which executes nothing); elsewhere it is
  politely refused. Booking execution remains unimplemented — no money can move.
- **Train cards (§8)**: search results are returned as structured cards and rendered as
  cards in the chat; the text reply is a short intro.
- **Timetable vs live vs info (§14)**: "kaha kaha rukti hai" → timetable; "next station"
  and "kitni late hai" → live status; "daily chalti hai" → train info.
- **Interrupt/resume (§23)**: after an interruption answer the assistant explicitly
  re-offers the pending booking ("Wapas aapki booking par aa jaate hain — …").

## Step 3 additions — AI-first orchestration

**Flow:** user message → AI `understand()` → STRICT validated structured JSON
(`ai/structuredOutput.ts`: whitelisted intents/tools, formats enforced, URLs
stripped, protected tools rejected+recorded) → deterministic slot resolution
(`ai/slotResolution.ts`: aaj/kal/parso, station names → codes ONLY via the
lookupStation tool, result references, one-slot corrections) → ToolRegistry
(server-side execution) → normalized ToolResults → safe reply templates
(`ai/replyTemplates.ts`) with optional AI phrasing when data exists.

- **AI providers** (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` env, server-side
  only): real NVIDIA + Gemini REST adapters (JSON-constrained prompts) and the
  **DeterministicNLUProvider** — default without a key AND the mandatory
  fallback on AI timeout/failure/invalid JSON. Orchestration never hard-codes
  a model.
- **Tool permissions** (`tools/permissions.ts`): READ / DRAFT /
  SENSITIVE_ACTION tiers. `confirmBooking` is SENSITIVE_ACTION: the AI can
  never request or execute it (fail-closed even on registry misconfig).
- **Real tool executors** (`tools/executors/`): railway tools wired to the
  Step-2 RailwayProviderRouter (the AI never picks providers), plus honest
  user-data tools and DRAFT-only booking tools. No executor exists for
  confirmBooking.
- **Conversation UX**: one missing field asked at a time; explicit
  aaj/kal/parso only (never silent defaults); corrections merge ONE slot
  (audited via userCorrections); interruptions pause the booking snapshot and
  "kal jaana hai" resumes it (never misread as a live-status date); result
  references ("pehli wali", "12014 wali") resolve only within current results;
  comparison uses only stored search results with factual fields.
- **Hallucination guard**: when tools return no data, the honest unavailable
  template ALWAYS wins over AI prose; URLs are stripped from every reply.
- **API**: `POST /api/chat` is live (conversation store, conversationId
  echo-back). Health reports `aiProvider` + fallback.

## Step 2 additions

- **Railway API routes** (`api/routes/railway.ts`): `/api/railway/stations`,
  `trains`, `train-info`, `timetable`, `live-status`, `availability`, `fare`,
  `pnr`, `cancelled` + `provider-config` (safe diagnostics: capability map,
  credential booleans, endpoint verification status — never key values).
- **Safe diagnostics** (`railway/diagnostics.ts`): logs ONLY operation,
  provider, outcome, latency and one of seven categories (AUTH_ERROR, TIMEOUT,
  RATE_LIMIT, HTTP_ERROR, INVALID_RESPONSE, UNSUPPORTED, UNKNOWN_ERROR). Never
  keys, auth headers, request bodies, payloads, PNRs, passenger data or wallet
  data — enforced by the event type having no fields for them, and by tests.
- **Developer diagnostics UI** (app shell, collapsed `<details>`): runs each
  operation read-only and shows PASS/FAIL, provider used, latency and a
  whitelisted normalized summary. Works keyless (honest
  RAILWAY_DATA_UNAVAILABLE) and never displays keys or raw payloads.
- **Privacy**: PNR normalization drops passenger names entirely.

## NOT IMPLEMENTED (Step boundaries)

| Area | Status |
|---|---|
| Live railway data | IMPLEMENTED adapters — needs `RAILCORE_API_KEY` / `RAILKIT_API_KEY` in the server env (none configured; MOCK tests only) |
| AI orchestrator (turn loop: understand → tool → reply) | **NOT IMPLEMENTED** |
| Real AI provider in use | **NONE CONFIGURED** — deterministic NLU active (set AI_PROVIDER/AI_MODEL/AI_API_KEY for NVIDIA/Gemini) |
| Tool executors | IMPLEMENTED (railway + user-data + DRAFT tools); `compareTrains` handled conversationally from stored results |
| Tool executors (all 15 tools) | **NOT IMPLEMENTED** (validation boundary + honest refusal implemented) |
| Booking execution / confirmation capture | **NOT IMPLEMENTED** (guards + state machine implemented) |
| Wallet ledger (credit/debit/refund, persistence) | **NOT IMPLEMENTED** (interface + inert service) |
| Database, persistence of any kind | **NOT IMPLEMENTED** |
| Real AI provider adapters (NVIDIA/Gemini) | **NOT IMPLEMENTED** (placeholders) |
| Premium mobile-first conversational UI | **NOT IMPLEMENTED** (minimal shell only) |
| Real AI provider in use | **NONE CONFIGURED** — deterministic NLU active (set AI_PROVIDER/AI_MODEL/AI_API_KEY for NVIDIA/Gemini) |
| Deployment (Vercel or otherwise) | **NOT PERFORMED** |

## Step 2 preview (not started)

Wire the orchestrator loop to the existing contracts: AI understanding →
context slot filling → tool request → registry validation → router/provider →
fact-safe reply; then booking conversation flow up to (but not past) explicit
confirmation.
