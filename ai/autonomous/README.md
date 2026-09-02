# 🤖 Autonomous AI Handover (ChatGPT-style)

This module gives BookKaro AI a **ChatGPT-like autonomous customer handling layer**.
The AI ab user intent ko khud samajhta hai, solutions khud find karta hai, aur poora
customer conversation apne aap handle karta hai.

## 🎯 Kya kya karta hai?

### 1. Universal Intent Understanding (Hindi / Hinglish / English / Devanagari)
- **35+ intent types** cover kiye gaye hain:
  - Core railway: BOOK_TRAIN, SEARCH_TRAIN, LIVE_TRAIN_STATUS, GET_AVAILABILITY, GET_FARE, GET_TRAIN_INFO, GET_TIMETABLE, LOOKUP_STATION, CHECK_PNR, VIEW_BOOKINGS, VIEW_WALLET, GET_CANCELLED_TRAINS, COMPARE_TRAINS, TRAIN_ROUTE, GET_FARE_BREAKDOWN, CHECK_REFUND, CHECK_CHART_STATUS, PLATFORM_INQUIRY, COACH_POSITION
  - Booking flow: CONFIRM_BOOKING, CANCEL_BOOKING, MODIFY_BOOKING, ADD_PASSENGER, CHANGE_CLASS, CHANGE_TRAIN, CHANGE_DATE, CHANGE_ORIGIN, CHANGE_DESTINATION, REVIEW_BOOKING
  - Meta/conversation: GREETING, FAREWELL, THANKS, PRAISE, COMPLAINT, FRUSTRATION, HELP, AFFIRMATION, NEGATION, HOLD_PAUSE, RESUME, GO_BACK, START_OVER, CORRECTION, REPEAT_REQUEST, SMALL_TALK, NORMAL_CHAT, MULTI_INTENT, GENERAL_RAILWAY_QUERY
- **Devanagari Hindi support**: "नमस्ते", "अमृतसर से लुधियाना जाना है", "पीएनआर स्टेटस" sab samajhta hai.
- **Typo/shorthand normalization**: "ludhiyana" → "ludhiana", "ldh" → "ludhiana", "pls" → "please", "avblty" → "availability", "ndls" → "new delhi" etc.
- **Multi-intent detection**: "fare aur availability dono batao" → ek hi message mein multiple tools execute karta hai (parallel mein).

### 2. Context-aware Follow-ups (Pronoun Resolution)
- "uska fare?", "wo kitni late hai?", "is train mein CC available hai?", "ye wali" — sab context se resolve ho jata hai.
- "pehli wali", "doosri wali", "aakhri/neeche wali" — list references automatically resolve.

### 3. Smart Corrections
- "nahi Amritsar nahi Jalandhar" → automatically detect kya correct karna hai (origin/destination/date/class/train/passenger count) and apply only that correction without wiping other slots.
- "kal nahi parso" → date correction
- "2 nahi 3 passengers" → count correction
- "CC nahi 3A" → class correction

### 4. Pause / Resume / Interrupt
- "rukko" / "thoda ruko" → booking pause ho jati hai, baad mein "chalo" keh ke resume kar sakte hain.
- Mid-booking informational queries (e.g. "12014 ka live status") → answer deta hai aur automatically booking flow resume karta hai ("Wapas booking par chalte hain...").
- "shuru se karo" / "start over" → naye sire se booking shuru.
- "peeche chalo" / "go back" → ek step wapas.

### 5. Emotional Intelligence (Tone & Sentiment)
- **Greetings / thanks / praise** → warm friendly replies.
- **Frustration / complaint** → patient, apologetic tone ("Maaf kijiye pareshani ke liye 🙏...").
- **Urgency** ("jaldi", "emergency", "foran", "abhi") → urgent tone prioritizes response.
- **Off-topic** (weather, cricket, movies, politics) → politely declines but keeps railway context alive.

### 6. Smart Missing-slot Detection
- Kabhi bhi poori form nahi bharta — ek time mein SIRF EK sawaal poochta hai.
- "Kaha se chalna hai?" → "Kaha jaana hai?" → "Kis date ko?" — natural order mein.
- Kabhi bhi user ko overwhelming nahi karta.

### 7. Honest & Hallucination-free (Safety Preserved)
- **AI samajhta hai, execute nahi karta** — har railway call deterministic server-side ToolRegistry + RailwayProviderRouter (RailCore primary → RailKit fallback) se hota hai.
- `confirmBooking` / wallet debit hamesha **DETERMINISTIC_ONLY** — AI kabhi bhi execute nahi kar sakta.
- Jab data available nahi hota, honest "Abhi railway data available nahi ho raha" deta hai — kabhi bhi fabricated data nahi.

## 📂 Files

```
ai/autonomous/
  AutonomousIntentEngine.ts    # Core intent/slot/entity understanding (ChatGPT-style NLU)
  AutonomousReplyGenerator.ts  # Natural Hinglish reply generation with tone + data
  AutonomousHandler.ts         # Main handover layer (orchestrates understand → tools → reply)
  index.ts                     # Public API
  README.md                    # Yeh file
```

`api/routes/chat.ts` automatically uses this layer as the default handler for `POST /api/chat` (with graceful fallback to the older orchestrator).

## 🔌 API Response Additions

Every `/api/chat` response mein naya `autonomous` field aata hai:

```json
{
  "autonomous": {
    "used": true,
    "intent": "BOOK_TRAIN",
    "confidence": 1,
    "tone": "friendly",
    "sentiment": "neutral",
    "candidates": [
      {"intent": "BOOK_TRAIN", "confidence": 1},
      {"intent": "SEARCH_TRAIN", "confidence": 0.3}
    ],
    "correctionsApplied": [],
    "resumedPausedBooking": false,
    "multiIntents": []
  }
}
```

## 🧪 Example Conversations

```
User: namaste
AI:   Namaste! 🙏 BookKaro mein aapka swagat hai. Main trains search, availability,
      fare, live status, PNR, booking — sab kuch kar sakta hoon. Batayein kya chahiye?

User: amritsar se ludhiana jana hai kal
AI:   Kaha se? — (actually fills origin=Amritsar, destination=Ludhiana, date=kal (2026-09-03)
      automatically, then executes searchTrains)

User: 12014 kitni late hai?
AI:   [Live status via provider] → follow-up: "Aur is train ke baare mein aur kya jaanna hai?"

User: uska fare bhi batao
AI:   [context picks 12014 as train] → fare breakdown

User: nahi CC nahi 3A
AI:   Theek hai, woh badal deta hoon. ✏️ [fresh 3A availability fetch]

User: bhai tumne galat bataya
AI:   Maaf kijiye pareshani ke liye 🙏. Thoda detail mein batayein kya galat hua —
      main turant solve karunga.

User: rukko
AI:   Ruko ji, hold par hoon. ⏸️ Jab taiyyar ho jao "chalo" keh dena.

User: aaj mausam kaisa hai
AI:   Main railway ka specialist hoon ji — is topic par meri training nahi hai.
      Par trains, tickets, PNR, booking, fare ya Indian Railways se related
      kuch bhi poochhiye, turant jawab dunga! 😊
```

## 🔒 Safety Invariants (Preserved)

| Rule | Status |
|------|--------|
| AI UNDERSTANDS only, NEVER executes tools directly | ✅ |
| All tool calls → validated ToolRegistry → ProviderRouter (RailCore→RailKit) | ✅ |
| confirmBooking is DETERMINISTIC_ONLY (AI requests rejected) | ✅ |
| Wallet mutations require SERVER actor + idempotency key | ✅ |
| Zero results are honest — never fallback to fabricated data | ✅ |
| Provider/Auth keys stay server-side, scrubbed from logs | ✅ |
| Conversation memory persisted via SQLite/Turso | ✅ |

## 🚀 Usage

No changes needed in client code — `POST /api/chat` automatically uses the autonomous handler. To disable (for any reason), pass `enableAutonomousHandler: false` in `ChatRouteContext`.

The autonomous engine is **zero-config**: bina kisi AI API key ke bhi deterministic rule-based understanding se chatlta hai (Hindi/Hinglish/English sab covered). Jab `AI_API_KEY` configured hoti hai (NVIDIA/Gemini/OpenAI-compatible), semantic planner bhi saath mein chalta hai for even smarter phrasing.
