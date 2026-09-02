# UNIVERSAL RAILWAY QUESTION ENGINE — FOCUSED INTELLIGENCE UPGRADE

**Scope:** make BookKaro answer natural railway questions like a railway expert, *without the user knowing intent / tool / provider / station-code internals*. The AI may understand and plan, but **never** calls arbitrary APIs, constructs URLs, reads secrets/env, or invents railway facts/timings/codes/fares/availability/status.

**Constraint honoured:** this is a *focused* intelligence upgrade only. No deploy, no rebuild/redesign of UI, no model replacement, no removal of GPT-OSS-20B / Nemotron / RailCore / RailKit / ToolGate / ProviderRouter, no bypassing ToolExecutor or ProviderRouter, no exposing API keys, no arbitrary HTTP access to the AI, unchanged booking/payment safety, no weakening/deleting existing tests.

---

## 1. Architecture

```
user question
   └─ AI understand()  → STRICT structured validation (structuredOutput.ts)
        └─ Entity/safety guards (anti-hallucination, literal-slot merge, keyword-intent guard)
             └─ Question decomposition (splitCompoundRequest + multi-capability planning)
                  └─ Required verified capabilities
                       └─ ToolGate (permissions, argument validation, budget MAX 5/turn)
                            └─ ToolExecutor (server-side actor only)
                                 └─ ProviderRouter (RailCore primary → RailKit fallback)
                                 or Knowledge Tool (allowlisted official web only)
                                 or Deterministic Engine (query-intelligence.ts)
                                      └─ verified facts
                                           └─ deterministic calculation (if required)
                                                └─ AI natural Hinglish explanation (templates, factsFromTools)
                                                     └─ final answer (cards/chips/panel, sourceClass)
```

Key invariant: **the AI requests tools, but deterministic server code executes them.** `confirmBooking` is deterministic-only; wallet is read-only for the AI; secrets stay server-side; railway data flows only through `RailwayProviderRouter` → normalized `ProviderResult`s.

### What was added / where it lives

| File | Role |
|---|---|
| `ai/query-intelligence.ts` **(new)** | The deterministic "brain". Pure, zero-I/O. Day-part bucketing, comparison-metric detection, verified best-train selection, duration difference, 8-class universal classifier, Hinglish notes. **Never estimates.** |
| `ai/orchestrator.ts` | Wired the brain in at the correct points (search-answer intelligence note, `TRAIN_CALCULATION` handler, ambiguous-`best` clarification, universal comparison `source` tag, `MULTI_CAPABILITY_QUERY` + `TRAIN_CALCULATION` source classes). |
| `tests/orchestration/universalRailwayEngine.test.ts` **(new)** | The 25 required regression tests + pure-engine unit tests. |
| `tests/orchestration/harness.ts` | **Additive** `searchResults` option so tests can inject arbitrary verified lists. |

Nothing removed, nothing rebuilt.

---

## 2. Universal classifier (8 source classes)

A pure, deterministic classifier `classifyUniversalQuerySource(...)` in `query-intelligence.ts` assigns **one of 8 source classes** to every turn — independent of the AI, so provenance/budget are never a model guess. The orchestrator's public `sourceClass` field carries the same taxonomy (the two legacy value names `COMPARISON` and `CONTEXTUAL_FOLLOWUP` are kept for frontend back-compat; they are respectively the `TRAIN_COMPARISON` and `CONTEXTUAL_RAILWAY_QUERY` buckets).

| Class (spec name) | Code value | When |
|---|---|---|
| `LIVE_RAILWAY_DATA` | `LIVE_RAILWAY_DATA` | live status / availability / fare / timetable / train info / PNR / bookings / wallet / cancelled / station lookup |
| `TRAIN_SEARCH` | `TRAIN_SEARCH` | journey / search intents |
| `TRAIN_COMPARISON` | `COMPARISON` | fastest/slowest/longest/shortest/earliest/latest compare |
| `TRAIN_CALCULATION` | `TRAIN_CALCULATION` | **new** — computed duration difference between two verified trains |
| `GENERAL_RAILWAY_KNOWLEDGE` | `GENERAL_RAILWAY_KNOWLEDGE` | glossary / concept ("CC kya hota hai") |
| `CONTEXTUAL_RAILWAY_QUERY` | `CONTEXTUAL_FOLLOWUP` | "usme CC hai?", "doosri wali", "iska fare" (reuse current results) |
| `MULTI_CAPABILITY_QUERY` | `MULTI_CAPABILITY_QUERY` | **new** — more than one approved capability exercised in one turn |
| `NORMAL_CHAT` | `NORMAL_CHAT` | off-scope small talk |

Priority order in the classifier, and it is conservative (multi-capability wins; contextual follow-ups require an actual short-pronoun/ordinal turn reusing the list).

---

## 3. Question decomposition

`splitCompoundRequest` (deterministic, conservative) only splits when the message clearly contains **both** an informational railway request **and** a booking/journey request joined by a conjunction (`aur / or / and / phir / bhi / also / , / ;`), ordering informational first then journey so the pending-booking question is what the user sees last. Each segment is orchestrated independently, context threads through (nothing is lost), and the turn is labelled `MULTI_CAPABILITY_QUERY`.

Example verified by test **18**: `"Kal Amritsar se Ludhiana jaana hai aur 12014 ka live status batao"` → `getLiveStatus` + `searchTrains` both ran, no arbitrary HTTP.

*Not every query is one intent.* A single question may need several capabilities (e.g. `SEARCH_TRAINS` + `COMPARE_TRAINS` + `GET_FARE`) **within the tool budget** (`MAX_TOOLS_PER_TURN = 5`). The orchestrator's recursion over segments does not exceed budget per turn.

---

## 4. Search + intelligent filtering

Centralized in `query-intelligence.ts`:

- **Day-part buckets (single definition):** morning `05:00–11:59` → *subah*, afternoon `12:00–16:59` → *dopahar*, evening `17:00–20:59` → *shaam*, night `21:00–04:59` → *raat*.
- `filterByDayPart(results, part)` filters the **verified** list by departure time.
- A day-part clause in the same search message (`"Kal Amritsar se Ludhiana subah jaana hai"`) appends a factual note listing **only that bucket's** verified trains; an empty bucket says so honestly.
- **Earliest arrival / earliest departure / shortest / longest / fastest / latest** are handled by `detectComparisonRequest` → `pickBestByMetric` on **verified** values only, bucketed centrally (no hardcoded city/train lists).

Verified by tests **3** (morning filter), **4** (earliest arrival), **5** (earliest departure), **6** (longest journey), **16** (search-then-fastest).

---

## 5. Universal comparison engine

The universal comparison engine (`compareTrainsDeterministic`, already present, now extended) returns:

```ts
{ winner: string | null, metric: string, verifiedValue: string | null, comparedTrains: string[], source: 'deterministic' }
```

It operates purely on **verified structured data**. Critical honesty rule: if the winner's required field is missing for **any** candidate, it returns a `null` winner and the reply says **"Available provider data mein duration nahi mila, isliye main andaza laga kar fastest train nahi bataunga."** — it never estimates.

Verified by tests **7** (two-train compare), **8** (duration difference), **19** (provider-missing-duration → no winner, no estimate), and the direct shape test.

### Comparison metrics (deterministic, canonical)

| Words | Metric | Direction |
|---|---|---|
| fastest / sabse tez / jaldi pahunch / quickest / kam time | duration | min |
| shortest | duration | min |
| longest / sabse zyada samay / slowest / sabse dheere | duration | **max** |
| earliest arrival / sabse pehle pahunch / **jaldi pahunchti** | arrival | min |
| latest arrival / sabse late pahunch | arrival | max |
| earliest departure / sabse pehle nikal | departure | min |
| latest departure / sabse late nikal | departure | max |

"Longest" uses **MAX**, never the fastest (MIN) logic — a step-9 regression fix that is preserved and re-tested.

---

## 6. Contextual follow-ups

A short turn that only carries a data noun / a pronoun + noun / a bare class refinement reuses the **selected train** (or the current result list) from context — the customer never repeats the train number:

- `"usme CC available hai?"` → `getAvailability` for the selected train + CC.
- `"uska fare?"` → `getFare` for the selected train.
- `"pehli wali / doosri wali / last wali"` → resolve against the current **verified** list (never invented).
- `"doosri wali fastest se kitni slow hai?"` → deterministic **duration difference** (`TRAIN_CALCULATION`). If either train's duration is missing, it says so honestly.

Verified by tests **16**, **8/17**, **23/24** (context preserved).

---

## 7. Multi-capability planning

The AI plans only **approved** capabilities (the semantic allowlist / tool registry), and execution always goes through `ToolGate` → `ToolExecutor` → `ProviderRouter`. Nothing bypasses those layers; the tool budget is enforced. A compound question that exercises more than one capability is labelled `MULTI_CAPABILITY_QUERY`. Verified by test **18**.

---

## 8. Knowledge vs live data

The engine never conflates the two:

| Question | Path | Proof |
|---|---|---|
| `"CC kya hota hai?"` | glossary (`composeKnowledgeAnswer`) | no provider call, `GENERAL_RAILWAY_KNOWLEDGE` |
| `"12014 mein CC available hai?"` | **live** `getAvailability` | never glossary |
| `"RAC kya hota hai?"` | glossary | `Reservation Against Cancellation` |
| `"12014 mein RAC available hai?"` | **live** `getAvailability` | returns live availability |
| rule-sensitive (tatkal timings / refunds / quota) | official allowlisted web only | never static glossary |
| glossary miss | restricted `getRailwayKnowledge` (allowlisted web) | honest unavailable if no retrieval |

`RAILWAY_WEB_ALLOWLIST` still applies; `getRailwayKnowledge` refuses live-status-style queries and any non-allowlisted domain.

---

## 9. Station resolution

Unchanged from the deployed, verified design: resolution runs **automatically** (replaces the old manual "pick a station" mid-flow), exact codes/names verify via the provider lookups, multiple matches **ask** (never auto-pick), and a no-match clarifies honestly. No hardcoded city lists, no invented codes/names/candidates. The UNIVERSAL engine reuses this — it never hardcodes stations. This task did not touch those files.

---

## 10. Graceful degradation

- **AI primary → secondary → deterministic NLU.** A hang, failure, invalid JSON, or an unknown intent falls back to the deterministic NLU — never to a fabricated answer.
- **Provider fallback:** RailCore primary → RailKit fallback (only for supported capabilities); one authoritative `ProviderResult`.
- **Honest unavailable:** any tool that returns no usable data is answered with the `railwayUnavailableReply` template — AI prose is overridden (`factsFromTools`).
- **Short clarification, never guess:** an ambiguous "best" with no criteria asks for the basis; a reference with no current list asks which train; a missing date/class/route asks for it.
- **Never estimate:** missing duration / exact speed / fare / availability → explicitly "data unavailable / I don't guess".

---

## 11. Build + test results

### Build

```
> bookkaro@0.1.0 build
> tsc -p tsconfig.build.json && node scripts/copy-public.mjs
[bookkaro-build] copied app/ -> dist/public
BUILD_EXIT=0
```

`npm run build` succeeds with **zero TypeScript errors**.

### Tests

Deterministic suite (`tests/**` excluding the two live-network suites `tests/integration/**` and `tests/semantic/semanticSmoke.test.ts`):

```
Test Files  3 failed | 36 passed (39)
Tests      4 failed | 601 passed (605)
```

**`tests/orchestration/universalRailwayEngine.test.ts`: 33/33 passed** — this is the 25 required regression tests plus pure-engine unit tests.

### Pre-existing failures (NOT introduced by this task)

The 4 failing tests are all in the **frontend-static / secret-handling** bucket and are **pre-existing**, unrelated to the universal engine:

- `tests/apiServer.test.ts` → "GET / serves the landing page" — asserts the served page does not match `/https?:\/\//`; `app/index.html` line 8 embeds a favicon as a data URI containing `xmlns="http://www.w3.org/2000/svg"`, which trips the regex.
- `tests/apiServer.test.ts` → "GET /chat.html … serve the assistant page" — test expects title `BookKaro Assistant`, the page (untouched) titles `BookKro Sarthi — Chat`. A stale expectation.
- `tests/boundaries.test.ts` → "every page makes ZERO railway API calls" — same favicon `https://` data-URI.
- `tests/secretHandling.test.ts` → "no external URLs" — same favicon `https://` data-URI.

These involve `app/index.html`, `app/chat.html` and the API server — **none of which this task modified.** (They were already failing before this task; see session memory: "static/server tests fail because app/index.html favicon contains `xmlns="http://www.w3.org/2000/svg"` matching the 'no external URL' regex".)

### Not run / live-network suites (pre-existing, excluded for determinism)

- `tests/integration/**` (e.g. `nemotron.step8.test.ts`) — real NVIDIA model calls; slow, network-dependent, and flaky by nature.
- `tests/semantic/semanticSmoke.test.ts` — real `gpt-oss-20b` / `nemotron` calls; the memory notes it can return `ai_secondary` where `ai_primary` is expected (model fallback), a pre-existing condition.

---

## 12. The 25 required regression tests — coverage

| # | Requirement | Test |
|---|---|---|
| 1 | station+search+duration | `station+search returns VERIFIED duration…` |
| 2 | tomorrow | `"Kal" resolves to tomorrow…` |
| 3 | morning filter | `…subah query filters the verified list…` |
| 4 | earliest arrival | `earliest arrival → arrival-min winner…` |
| 5 | earliest departure | `earliest departure → departure-min winner` |
| 6 | longest journey | `longest journey → MAX duration winner…` |
| 7 | compare two trains | `compare two explicit trains…` |
| 8 | duration difference | `"doosri wali fastest se kitni slow hai?" → 15-minute difference` |
| 9 | best clarification | `"kaunsi best hai?" with no criteria → clarification` |
| 10 | CC knowledge | `"CC kya hota hai?" → GENERAL knowledge…` |
| 11 | 12014 CC availability | `"12014 mein CC available hai?" → LIVE availability…` |
| 12 | RAC knowledge | `"RAC kya hota hai?" → knowledge…` |
| 13 | 12014 RAC availability | `"12014 mein RAC available hai?" → LIVE availability…` |
| 14 | 12014 exact speed honest | `"12014 ki speed kitni hai?" → honest unavailable…` |
| 15 | train-speed knowledge | `"Train ki speed kya hoti hai?" → general knowledge…` |
| 16 | search-then-fastest follow-up | `search, then "kaunsi train sabse tez hai?" → winner` |
| 17 | doosri-wali-difference | `"doosri wali fastest se kitni slow hai?" → 15 min` |
| 18 | compound query | `journey + live status decomposes into multiple capabilities` |
| 19 | provider-missing-duration no-estimate | `one train lacking duration → honest, no winner` |
| 20 | unsupported-tool rejection | `AI requests unregistered tool → rejected + recorded` |
| 21 | arbitrary-URL rejection | `URL/endpoint argument rejected by validator` |
| 22 | provider-selection rejection | `AI can never select a provider / pass a secret env` |
| 23 | informational-during-booking context preserved | `live-status interrupt preserves date + passenger count` |
| 24 | general-question-during-booking preserved | `CC knowledge interrupt preserves booking context` |
| 25 | normal chat zero railway calls | `off-scope small talk → NORMAL_CHAT, zero tools/router calls` |

---

## 12b. Natural-language gaps hit in production — FIXED

A real-user session surfaced three plain questions that returned *"Main samajh nahi paaya"*. Root cause: the deterministic NLU rules didn't cover these natural phrasings. They are now fixed and verified live:

| User message (from the screenshot) | Before | After |
|---|---|---|
| `"12014 kitne bje pahunchi thi new delhi"` | `UNKNOWN` | `GET_TIMETABLE` → `"12014 NEW DELHI par 11:02 baje (scheduled) pahunchti hai."` |
| `"12014 kitne baje apni destination par pahunch thi"` | `UNKNOWN` | `GET_TIMETABLE` → destination scheduled arrival |
| `"Tum ludhiana ki kal ki morning trains btao"` | `UNKNOWN` | `BOOK_TRAIN` → station-choice for Ludhiana (LDH / LQTS / DDL), then asks origin |

**What changed** (all in `ai/providers/DeterministicNLUProvider.ts`, plus the timetable handler in `ai/orchestrator.ts`):
- New **arrival-time intent**: `kitne baje / kitne time / kab pahunch / pahunchi / pahunchti` + train number → `GET_TIMETABLE` (scheduled arrival is the verified source; never a guessed clock). Guarded so it does **not** fire on comparisons/superlatives (`secondTrainNumber` / `kaunsi / sabse / fastest …`), so the existing comparison tests still pass.
- New **`arrivalTimeReply`** in the orchestrator: highlights the referenced stop's scheduled arrival, falling back to the destination (last) stop; honest if the field is missing.
- **Journey trigger widened**: `morning/subah/dopahar/shaam/raat trains`, plus the colloquial `btao / dkhao / bata` spellings.
- **Single-station journey promotion**: a clear journey phrase with one implied station (`"ludhiana ki … trains"`) → treat as destination and ask origin (never guess the other endpoint).
- **Stopword/token hygiene**: greeting pronouns (`tum / aap / ham …`), day-parts, `btao`, `pahunch*`, `baje` added to STOPWORDS/GENERIC_WORDS so they are never mistaken for station names.

New regression tests added to `tests/orchestration/universalRailwayEngine.test.ts` (5 tests, now **38** total in that file). Full deterministic suite: **606 passed / 4 failed** (the 4 are the pre-existing favicon/URL frontend failures).

---

## 13. Failures / limitations (honest)

1. **Persistent conversation state (the biggest real blocker):** the production deploy uses an **in-memory conversation store** (`new Map` in `api/conversations.ts` — no database). On Vercel serverless the process/instance is not guaranteed to survive between requests, so **multi-turn booking continuity is not reliable live**: a follow-up like tapping a station chip (`"LDH"`) or continuing a journey can land on a fresh instance with no remembered `lastSearchResults` / `stationChoices`, producing `UNKNOWN`. All these flows pass in the in-process test harness (continuity holds there). **This is infrastructure, not an intelligence bug** — fixing it needs a persistent store (Redis / external DB / Vercel KV).
2. **Multi-turn filtering gap:** a day-part clause that arrives *before* the date is answered (e.g. "Amritsar se Ludhiana subah jaana hai" → "kal") does **not** carry a deferred day-part hint across turns — only the *fastest* hint is deferred (`pendingFastestHint`). Day-part filtering applies when the bucket word is in the **same** turn the search runs. (Documented limitation, not a correctness bug — no wrong answer is produced.)
2. **`splitCompoundRequest` is intentionally conservative:** it only splits informational+journey mixtures. Two *informational* capabilities joined by `aur` (e.g. live status + fare) do **not** auto-split into two segments; the orchestrator still handles them through the single-turn dispatch (priority-ordered intent). Multi-capability decomposition is therefore strongest for journey+info compounds.
3. **Exact train speed** is never available because the provider schema has no verified speed field — the engine answers honestly and suggests average speed (distance ÷ duration) from a timetable, never a `km/h` estimate. (Tested.)
4. **`"best"` is deliberately underspecified:** without criteria or context it asks for the basis rather than picking. This is the intended design, but it means an unqualified "best" needs one extra turn.
5. **The 4 pre-existing static/secret failures** (section 11) remain — fixing them is outside this task's scope and would touch frontend files / test expectations.
6. **Live-network suites** (integration, semanticSmoke) are not deterministic and were excluded from the counted run; they are pre-existing and not part of this focused upgrade's acceptance.

---

## 14. Safety invariants (unchanged, verified)

- `confirmBooking` remains deterministic-only and `confirmBooking`/fetch/arbitrary tools are rejected at the ToolGate boundary (tests 20–22).
- Booking requires an **explicit** confirmation from a full final review; DEMO boundary; no real ticket/PNR; no auto-debit; informational intelligence **never** triggers booking (test 8/17 asserts `selectedTrain` stays null).
- AI never gets secrets/env, never constructs URLs (structural validation rejects URLs), never picks a provider, never gets arbitrary HTTP.
- Railway facts only flow from verified provider data (or the approved knowledge tool); the engine centralizes time/duration/rank logic deterministically, so the model can never invent a winner/fact.
