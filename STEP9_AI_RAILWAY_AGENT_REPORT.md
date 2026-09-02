# STEP 9 — TRUE AI RAILWAY AGENT + INTELLIGENT SOURCE SELECTION

App version 0.9.0-step9 (variant 2) · **503/503 tests passing (35 files)** · build PASS · NOT DEPLOYED.

> **VARIANT-2 UPDATES (this revision):** (1) Model order per the latest Step-9 spec —
> **Nemotron (NVIDIA_MODEL) is now PRIMARY**, GPT-OSS-20B SECONDARY (verified live:
> `nvidia-gateway:nvidia/nemotron-3-nano-30b-a3b→openai/gpt-oss-20b`); both models
> share the identical ToolGate/ToolExecutor/ProviderRouter/safety pipeline. (2) The
> **"longest journey" MAX-duration bug is FIXED** — the deterministic comparison engine
> is now direction-aware (`longest/sabse zyada samay/slowest → MAX`, fastest/shortest →
> MIN) with regression tests ("Longest journey kaunsi hai?" → 14542 by 130m vs 115m,
> never the fastest train). (3) RailCore's daily quota RESET during verification —
> live end-to-end re-verified with REAL data: ASR→LDH search returned 31 REAL trains;
> real-result duration fields were null for the comparison trains, so the engine
> answered honestly ("duration provider data mein nahi mila — andaza nahi") exactly per
> the never-estimate rule. (4) Model prose is now language-gated: pure-English model
> replies are replaced by the deterministic Hinglish template (same verified facts).

**Live end-to-end smoke (real keys, real providers):** gateway active as
`nvidia-gateway:openai/gpt-oss-20b→nvidia/nemotron-3-nano-30b-a3b`; "CC kya hota hai?"
→ glossary answer; "India mein weather kaisa hai?" → NORMAL_CHAT decline; "12014 ka
fare kitna hai?" → GET_FARE (asks the missing route honestly); live status → RailCore
429 → **RailKit fallback SUCCESS** (verified in diagnostics). Gateway validity was
tightened so a model must COMMIT to a registered intent (UNKNOWN never accepted from a
remote model), and the api-level fallback NLU wiring was fixed (deterministic, not the
gateway itself) — both verified live.

## AI Gateway architecture
`ai/AIGateway.ts` — model-agnostic understand/generate wrapper:
USER → AI Gateway → **GPT-OSS-20B (PRIMARY)** → on timeout / invalid plan / malformed
output / HTTP failure → **Nemotron 3 family (SECONDARY)** → (existing deterministic NLU
as final in-house fallback). The gateway ONLY understands — it never executes tools, so
a model switch can never duplicate a railway call (verified: exactly ONE provider call
per turn across model fallback, test §20-34). AI-model fallback and railway-provider
fallback remain fully separate layers.

## Model behavior
- **GPT-OSS-20B primary**: `openai/gpt-oss-20b` on the configured NVIDIA keys
  (live-verified: valid JSON intent in ~1.4 s). Selected via `GPT_OSS_MODEL` (default
  openai/gpt-oss-20b). Key rotation (primary→backup NVIDIA key) from Step 8 still applies.
- **Nemotron secondary**: the configured `NVIDIA_MODEL` (currently
  nvidia/nemotron-3-nano-30b-a3b — Nemotron 3 family; 3.5-lightning selectable by env).
  Engaged only when the primary's plan is invalid/unusable (tests §20-31/32/32b/32c/33).

## Capability / source selection
Every query resolves to a `sourceClass` (exposed in the chat envelope):
LIVE_RAILWAY_DATA · TRAIN_SEARCH · COMPARISON · GENERAL_RAILWAY_KNOWLEDGE ·
CONTEXTUAL_FOLLOWUP · NORMAL_CHAT. Off-scope chat is politely declined with zero tool
calls. "Kal kitni trains hain?" is TRAIN_SEARCH; cancelled requires explicit cancel
words (test 30).

## ToolGate / ToolExecutor / ProviderRouter
Unchanged and still mandatory: model output passes the structured-output validator,
then the approved AI tool catalog (RAILWAY_KNOWLEDGE added; URL/method/credential/env
arguments rejected — tests §20-24/25/26/35/36/37/38), then the registry executor, then
the ProviderRouter (RailCore primary → RailKit fallback; test §20-39/40; live fallback
proven in Step 8 under real 429s).

## Comparison engine (deterministic)
`compareTrainsDeterministic` on VERIFIED search-result values only → structured
{winner, metric, verifiedValue, comparedTrains}; metrics: duration/arrival/departure;
natural-language metric detection (fastest/sabse tez/jaldi pahunchti/pehle pahunchti/
shortest). Missing timing on either train → no winner, honest clarification (test 44).

## Availability & passenger extraction
"12014 mein CC available hai?" / "…CC hai?" / "…RAC available hai?" → availability with
train+class captured and remembered (never re-asked); only missing route/date asked.
Passenger extraction: digits, Hindi number words, "hum 3 log hain", tickets, and the
reliable two-party pattern "mere liye aur meri wife ke liye" → 2 (uncertain → ask).

## Railway knowledge / web capability
`getRailwayKnowledge` (READ): approved deterministic glossary/composition FIRST
(classes, quotas, RAC/WL, tatkal, coach types, CC-vs-EC difference, speed concept);
glossary-miss general concepts may attempt allowlisted web retrieval ONLY from
indianrail.gov.in / indianrailways.gov.in / cris.org.in (redirects refused, sanitized
{source,title,url,retrievedText,timestamp}, 6 s timeout). Arbitrary domains are
rejected before any fetch (test 41); live-data queries are refused web access (test 42);
web is never used for live status/availability/fare/PNR. Live retrieval from the
allowlisted government sites: **NOT VERIFIED in-sandbox** (firewall/availability) — the
capability degrades honestly ("approved source se jawab nahi mila").

## Context / interruption-resume / multi-tool
Step 7/8 behavior preserved and re-tested: follow-up pronouns, result references
("doosri/12014/neeche wali"), mid-booking live/knowledge interruptions with full slot
preservation, deterministic "kal"=tomorrow even against a conflicting model date
(tightened literal-date guard, test 46), multi-tool within the existing 5/turn budget,
parallel independent reads.

## Secret protection
Keys remain server-side env-only (now including GPT_OSS_MODEL config); no key material
in prompts, tool schemas, context, responses, logs or the bundle (Step 8 §11 scan still
green; new tests 26/38 assert key/env arguments are rejected at the catalog).

## Booking/payment safety
Unchanged: explicit confirmation gate, deterministic mock boundary, wallet guards —
all Step 1–8 safety suites still green. AI cannot book, debit, or claim success.

## Tests / build
- 500/500 passing (35 files): +51 Step-9 tests (§20 matrix 1–48 + source-class extras);
  existing suites untouched except two additive updates (tool count 17→18 with
  getRailwayKnowledge; model-provider selection now asserts the Step-9 gateway) — no
  assertion weakened.
- `npm run build`: PASS.

## Official railway knowledge source configuration (Step 9 revision)

- **Official sources configured** (server-controlled URL map, model never picks URLs):
  Tatkal Scheme, Quota Codes, PNR/status legend, Seat Availability information and
  Reservation Rules pages — all on `www.indianrail.gov.in` (PRIMARY), discovered by
  topic from the query (`detectOfficialPage`).
- **Allowed domains**: indianrail.gov.in, indianrailways.gov.in, cris.org.in (+www).
  The web tool accepts only `query` + optional approved `domain`/allowlisted URL;
  arbitrary URLs, untrusted domains and API-key arguments are rejected pre-fetch.
- **Rule-sensitive routing**: Tatkal timings, refund/rules/luggage questions bypass
  the static glossary entirely — official retrieval first; on failure the spec's
  honest message ("Is information ko verify karne ke liye official railway source
  abhi available nahi hai."). Stable concepts (CC/RAC/WL/GN) remain deterministic.
- **Live-data separation re-verified**: availability/live-status/fare/comparison
  NEVER touch web (tests §K7-10); provenance `web`/`deterministic`/`railcore`/`railkit`.
- **LIVE VERIFICATION**: official retrieval from indianrail.gov.in SUCCEEDED from
  this environment (real page content returned in tests §K5) — so this revision is
  externally verified, not just the graceful-unavailable path (which is also tested).
- **Tests**: +15 (tests/step9/officialKnowledge.test.ts) — total **525/525 (37 files)**.
- **Build**: PASS. No deploy (per instruction).

## Failures & limitations
- Allowlisted live web retrieval: NOT VERIFIED (sandbox cannot reach the government
  sites) — honest-unavailable path verified instead.
- "Longest journey" metric: engine supports min-side metrics; longest is accepted in
  wording but currently resolves like fastest — documented, not advertised to users.
- Nemotron secondary is env-configurable; per spec wording it is the Nemotron 3 family
  model configured in NVIDIA_MODEL (3.5-lightning selectable).
