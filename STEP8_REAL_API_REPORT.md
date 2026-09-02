# STEP 8 — REAL API INTEGRATION REPORT

Date: 2026-08-27 (UTC) · App version: 0.8.0-step8 · No deployment performed.

> **POST-RUN MODEL UPDATE:** after the initial 3.5-lightning verification, a raw-model
> comparison was run (user request). `nvidia/nemotron-3-nano-30b-a3b` proved far more
> consistent for NLU (9/9 valid JSON intents vs occasional invalid intents/timeouts,
> ~0.6 s raw calls) and `NVIDIA_MODEL` was switched to it. Full suite re-verified:
> 444/444, orchestration avg ~1.9 s/turn (was ~8.6 s). Two model-agnostic safety
> hardenings were added during the switch: (1) model-supplied PNR/train numbers must
> literally appear in the user message or context (anti-hallucination), and (2) a
> literal-slot merge fills slots the model dropped using deterministic extraction only.

## Configuration

| Variable | Status |
|---|---|
| NVIDIA_API_KEY | CONFIGURED (server-side `.env`, gitignored, mode 600) |
| NVIDIA_MODEL | CONFIGURED — `nvidia/nemotron-3.5-lightning-30b-a3b` |
| RAILCORE_API_KEY | CONFIGURED |
| RAILKIT_API_KEY | CONFIGURED |
| RAILWAY_PROVIDER | CONFIGURED — `railcore` (matches the fixed router policy) |

Values are never printed, logged, committed or exposed to the browser. Missing
variables would be reported as `NOT CONFIGURED` only.

## NVIDIA (Nemotron 3.5)

- Model: `nvidia/nemotron-3.5-lightning-30b-a3b` (verified present in the account model list).
- Adapter: existing `NvidiaAIProvider` (chat-completions, JSON-constrained, ToolGate/ToolExecutor unchanged).
- Nemotron 3.x is a REASONING model — thinking tokens were disabled for NLU
  (`chat_template_kwargs.thinking:false`), cutting latency from ~26.7 s to ~1–3 s per call.
- Measured in the final verification run (26 orchestrated turns):
  - successful calls: 26/26 turns answered (model handled ~85% directly; the deterministic
    assist path resolved the remaining turns — see "Orchestration" below)
  - failed calls: 0 hard failures (all degradations were graceful)
  - timeout count: 2 turns hit the 20 s AI timeout → deterministic NLU fallback answered
  - invalid JSON count: 0 (strict validator + snake_case/alias tolerance)
  - average latency: ~8.6 s per orchestrated turn (model + tools + reply)
  - P95 latency: ~30.7 s (worst turns include provider retries/fallback)

## RailCore (PRIMARY)

| Capability | Result |
|---|---|
| authentication | PASS — key valid (verified with live 200s) |
| station lookup | PASS — REAL codes returned (Amritsar/Delhi/Ludhiana/Jammu/Beas groups; no hardcoded mappings) |
| train search | PASS — REAL trains ASR→LDH (numbers/names/times/duration + provider metadata) |
| train info | PASS — 12014 real record |
| timetable | PASS — 12014 real stop list |
| live status | PASS — 12014 real running state |
| availability | PASS — capability verified with real data early in the run; later calls answered by the documented **429 RATE_LIMITED** envelope (plan daily quota exhausted by repeated verification runs) — never fabricated |
| fare | PASS — verified with a real provider quote (RailCore `source` provenance); later calls 429-classified as above |

No RailCore PNR operation exists or was invented.

## RailKit (FALLBACK / capability provider)

| Capability | Result |
|---|---|
| train search | PASS — real trains |
| train info | PASS |
| timetable | PASS |
| live status | PASS |
| availability | PASS |
| fare | PASS |
| PNR | **NOT TESTABLE** — no valid real PNR was available; none was invented (mock-only coverage offline) |
| cancelled trains | PASS — real list; no cancellation claimed without provider data |

## Provider fallback (live)

- Router policy unchanged: RailCore first; RailKit only on timeout / HTTP failure /
  success:false / unusable payload / capability gap.
- **Live proof:** with RailCore rate-limited (429), search/trains flowed through RailKit
  inside a single tool call — verified by a dedicated test against the real APIs.
- Zero-result searches never triggered fallback (regression tests intact).
- Both-fail → honest "railway data available nahi ho raha" (never fabricated).

## Orchestration (Nemotron, 22 real-model tests — all passing)

- Tool selection accuracy: 20/20 spec messages select the correct approved tool or the
  honest ask (see §7.1–§7.20 results; availability-vs-fare disambiguation hardened via
  temperature 0.0 + prompt hints).
- Argument accuracy: train numbers/dates/classes validated at the ToolGate (formats
  enforced; "12014 nahi 14542…" correctly resolves to 14542).
- Context preservation: "uska fare"/"isme availability"/"12014 wali" resolve from context;
  interrupt → "kal" resumes the booking; live-status dates never overwrite journey dates.
- Reference resolution: doosri/pehli/12014 wali resolve only against the current list;
  no list → ask (never guess).
- Hindi/Hinglish/English: all 24 example phrasings route correctly.
- Deterministic-assist guards (no fabrication — extraction only): UNKNOWN intents,
  GENERAL answers without a concept question, and data-intent choices with no
  resolvable train all defer to the deterministic extractor.

## Safety

- Booking safety: PASS — "book kar do" outside review never books; explicit
  confirmation + deterministic mock boundary unchanged; no fake PNR (`pnr: null`, MOCK- ids).
- Wallet safety: PASS — AI wallet debit/PROHIBITED tools rejected by name.
- Secret safety: PASS — §11 scan over server logs, API responses, chat replies, error
  responses, conversation context and the frontend bundle found ZERO key material.
- Hallucination safety: PASS — null delay → no guessed number; fare/availability/live
  failures answered "unavailable"; no provider names/tool names in customer replies (§19).

## Regression & build

- `npm test`: **444/444 passing (33 files)** — all Step 1–7 suites intact (no tests
  deleted; the only expectation change, `missing: ["date"]` → maps to `journeyDate`,
  reflects the Step-8 model-compat slot mapping and was updated in one Step-3 test).
- `npm run build`: PASS.
- Deployment: NOT DONE (per instruction).
