with open('ai/autonomous/AutonomousHandler.ts','r',encoding='utf-8') as f:
    c = f.read()

marker = "  // 12) GENERATE natural reply."
inject = """  // 11b) Intent-aware reply when no tool results available (e.g. keyless demo).
  const intentAck: Record<string, string> = {
    LIVE_TRAIN_STATUS: 'Samajh gaya — aap live status dekhna chahte hain. Abhi demo mode mein railway data source connect nahi hai, isliye real-time status fetch nahi ho pa raha.',
    GET_FARE: 'Samajh gaya — fare dekhna chahte hain. Abhi demo mode mein real railway data available nahi hai.',
    GET_AVAILABILITY: 'Samajh gaya — availability check karni hai. Demo mode mein live provider connect nahi, isliye abhi seat status nahi bata pa raha.',
    GET_TIMETABLE: 'Samajh gaya — timetable/route dekhna chahte hain. Demo mode mein data fetch nahi ho pa raha.',
    GET_TRAIN_INFO: 'Samajh gaya — train ki info chahiye. Demo mode mein data source connect nahi hai.',
    CHECK_PNR: 'Samajh gaya — PNR status check karna hai. Demo mode mein PNR API connect nahi, real key configure karne par PNR status dikh jaayega.',
    GET_CANCELLED_TRAINS: 'Samajh gaya — cancelled trains dekhni hain. Demo mode mein provider data available nahi.',
    LOOKUP_STATION: 'Samajh gaya — station code chahiye. Demo mode mein station lookup API connect nahi.',
    VIEW_WALLET: 'Samajh gaya — wallet balance dekhna chahte hain. Demo mode mein wallet service active nahi hai.',
    VIEW_BOOKINGS: 'Samajh gaya — booking history dikhani hai. Demo mode mein user bookings store nahi ho rahi.',
    CHECK_CHART_STATUS: 'Samajh gaya — chart status dekhna chahte hain. Ye information live provider se hi milti hai — demo mode mein available nahi.',
    CHECK_REFUND: 'Samajh gaya — refund ke baare mein poochh rahe hain. Refund ke liye thoda specific poochhiye, ya main apne approved knowledge se answer deta hoon.',
    PLATFORM_INQUIRY: 'Samajh gaya — platform number jaanna chahte hain. Ye real-time data railway provider se milta hai — demo mode mein available nahi.',
    COACH_POSITION: 'Samajh gaya — coach position dekhni hai. Chart banne ke baad ye info milti hai — demo mode mein available nahi.',
    COMPARE_TRAINS: 'Samajh gaya — compare karna chahte hain. Demo mode mein train data fetch nahi ho pa raha.',
    GENERAL_RAILWAY_QUERY: 'Iske baare mein mujhe approved railway knowledge mein exact answer nahi mil raha. Thoda specific poochhiye — jaise "CC kya hota hai?", "tatkal kitne baje khulta hai?"',
    BOOK_TRAIN: 'Samajh gaya — aap ticket book karna chahte hain!',
    SEARCH_TRAIN: 'Samajh gaya — trains search karni hain.',
  };

"""
c = c.replace(marker, inject + marker)

# Now replace the reply section:
old = """  // 12) GENERATE natural reply.
  let pendingQ: string | null = null;
  if (isInfoQuery && !context.pausedBooking && context.pendingQuestion) {"""

new = """  // 12) GENERATE natural reply.
  // When no tool results came back (demo/keyless/unavailable), give an intent-aware ack
  // so the customer NEVER hears "samajh nahi paaya" — they always feel understood.
  if ((!toolResults || toolResults.length === 0) && intentAck[u.primaryIntent] && !u.clarificationQuestion) {
    let ack = intentAck[u.primaryIntent]!;
    if (u.primaryIntent === 'BOOK_TRAIN' || u.primaryIntent === 'SEARCH_TRAIN') {
      if (!context.origin?.code) ack += ' Pehle batayein kaha se chalna hai?';
      else if (!context.destination?.code) ack += ' Kaha jaana hai?';
      else if (!context.journeyDate) ack += ' Kis date ko jaana hai? (aaj / kal / parso)';
      else ack += ' Abhi demo mode mein train search API connect nahi — RAILCORE_API_KEY set karte hi live results dikh jaayenge.';
    }
    return finalize(ack, u, executedTools, null, null, context, correctionsApplied, resumedPausedBooking);
  }

  let pendingQ: string | null = null;
  // @ts-ignore pausedBooking may not be on the public type shape but is used internally
  if (isInfoQuery && !(context as any).pausedBooking && context.pendingQuestion) {"""
c = c.replace(old, new)

with open('ai/autonomous/AutonomousHandler.ts','w',encoding='utf-8') as f:
    f.write(c)
print('done')
