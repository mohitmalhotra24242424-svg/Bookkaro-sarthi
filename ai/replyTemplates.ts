/**
 * DETERMINISTIC REPLY TEMPLATES (Hinglish-first).
 *
 * These templates are the guaranteed-safe response layer: every railway fact
 * they contain is copied verbatim from normalized ToolResults — never invented.
 * They are used as the default response generator AND as the fallback when a
 * real AI provider fails, and the orchestrator OVERRIDES any AI prose with
 * them when data is unavailable (hallucination guard).
 */

import type {
  Availability,
  CancelledTrain,
  ContextSlotField,
  ConversationContext,
  Fare,
  LiveStatus,
  PNRStatus,
  Station,
  Timetable,
  ToolResult,
  Train,
  TrainSearchResult,
} from '../shared/index.js';
import { APPLICATION_SERVICE_FEE_MINOR, SERVICE_FEE_LABEL, totalPayableMinor } from '../shared/serviceFee.js';

export function rupees(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? '?' : `₹${(minor / 100).toFixed(2)}`;
}

export function stationLabel(station: Station | null): string {
  if (!station) return '?';
  return station.name ? `${station.name} (${station.code})` : station.code;
}

export function trainLabel(train: { number: string; name: string | null }): string {
  return train.name ? `${train.number} — ${train.name}` : train.number;
}

// ── questions (one missing field at a time) ─────────────────────────────────

/** Honest: this train does not halt at the asked station(s) — never “seats unavailable”. */
export function trainDoesNotServeSegmentReply(input: {
  trainNumber: string;
  trainName: string | null;
  fromCode: string;
  toCode: string;
  fromLabel: string;
  toLabel: string;
  missing: 'from' | 'to' | 'both' | 'order';
  stopCodes: readonly string[];
}): string {
  const label = input.trainName ? `${input.trainNumber} — ${input.trainName}` : input.trainNumber;
  const codes = input.stopCodes.filter(Boolean);
  const stopLine =
    codes.length === 0
      ? ''
      : codes.length <= 12
        ? ` Commercial stops: ${codes.join(', ')}.`
        : ` Commercial stops: ${codes.slice(0, 8).join(', ')} … ${codes[codes.length - 1]} (${codes.length} stops).`;
  if (input.missing === 'both') {
    return `${label} na ${input.fromLabel} (${input.fromCode}) par rukti hai, na ${input.toLabel} (${input.toCode}) par — isliye is segment ki seat/fare nahi nikal sakta (andaza nahi).${stopLine}`;
  }
  if (input.missing === 'from') {
    return `${label} ${input.fromLabel} (${input.fromCode}) par NAHI rukti — isliye ${input.fromCode}→${input.toCode} ki seat/fare nahi nikal sakta (andaza nahi).${stopLine}`;
  }
  if (input.missing === 'to') {
    return `${label} ${input.toLabel} (${input.toCode}) par NAHI rukti — isliye ${input.fromCode}→${input.toCode} ki seat/fare nahi nikal sakta (andaza nahi).${stopLine}`;
  }
  return `${label} ${input.fromCode} se ${input.toCode} is direction mein nahi chalti (schedule order alag hai) — isliye seat/fare nahi nikal sakta.${stopLine}`;
}

/** Class question lists ONLY the train's real API classes — never a generic IRCTC menu. */
export function askForClass(offered: readonly string[] | null | undefined): string {
  const classes = [...(offered ?? [])].map((code) => code.trim().toUpperCase()).filter(Boolean);
  if (classes.length > 0) return `Kaunsi class chahiye? (${classes.join(', ')}) — neeche chip tap karein, ya type karein.`;
  return 'Is train ki class list provider se nahi mili — class code type karein (andaza nahi).';
}

export function askForField(field: ContextSlotField): string {
  switch (field) {
    case 'origin':
      return 'Kahan se jaana hai? (boarding station)';
    case 'destination':
      return 'Kahan tak jaana hai? (destination station)';
    case 'journeyDate':
      return 'Kis date ko jaana hai? (aaj, kal, parso ya exact date bataiye)';
    case 'passengerCount':
      return 'Kitne passengers hain? (1 se 6)';
    case 'selectedClass':
      return askForClass(null);
    case 'selectedTrain':
      return 'Kaunsi train leni hai? (train number bataiye)';
    default:
      return passengerQuestion(field, 1, 1);
  }
}

/** IRCTC coach layout by class — only berths that exist on that class. Sitting classes have none. */
export function berthsForClass(travelClass: string | null | undefined): string[] | null {
  switch ((travelClass ?? '').toUpperCase()) {
    case 'SL':
    case '3A':
    case '3E':
      return ['lower', 'middle', 'upper', 'side lower', 'side upper'];
    case '2A':
      return ['lower', 'upper', 'side lower', 'side upper'];
    case '1A':
      return ['lower', 'upper'];
    default:
      return null; // CC / EC / 2S — chair/sitting, no berth
  }
}

/** §9/§21: one passenger question at a time, with subtle "Passenger 1 of 2" progress. */
export function passengerQuestion(field: ContextSlotField, current: number, total: number, berthOptions?: string[] | null): string {
  const progress = total > 1 ? `Passenger ${current} of ${total} — ` : `Passenger ${current} — `;
  switch (field) {
    case 'passengerName':
      return `${progress}naam kya hai? (type karein)`;
    case 'passengerAge':
      return `${progress}age kitni hai?`;
    case 'passengerGender':
      return `${progress}gender? (M / F / T — chip se tap kar sakte hain)`;
    case 'passengerBerth': {
      const opts = berthOptions && berthOptions.length > 0 ? berthOptions : null;
      if (!opts) return `${progress}berth preference? (chip se tap karein)`;
      return `${progress}berth preference? (${opts.join(' / ')} — chip se tap karein)`;
    }
    default:
      return `${progress}detail bataiye?`;
  }
}

export function waitlistConsentQuestion(availability: Availability): string {
  if (availability.status === 'RAC') {
    return `RAC hai${availability.racCount !== null ? ` (${availability.racCount} RAC)` : ''}. Kya aap phir bhi book karna chahenge? (haan / nahi)`;
  }
  return `Waitlist hai${availability.waitlistNumber !== null ? ` (WL ${availability.waitlistNumber})` : ''}. Kya aap phir bhi book karna chahenge? (haan / nahi)`;
}

export function availabilityLineReply(availability: Availability): string {
  switch (availability.status) {
    case 'AVAILABLE':
      return `Availability: ${availability.travelClass} mein seats AVAILABLE hain${availability.availableCount !== null ? ` (${availability.availableCount} seats)` : ''}.`;
    case 'RAC':
      return `Availability: RAC hai${availability.racCount !== null ? ` (${availability.racCount} RAC)` : ''}.`;
    case 'WAITLIST':
      return `Availability: WAITLIST hai${availability.waitlistNumber !== null ? ` (WL ${availability.waitlistNumber})` : ''}.`;
    case 'REGRET':
      return 'Availability: REGRET — is class mein booking band hai. Koi aur class try karein?';
    default:
      return 'Availability: abhi pata nahi chal paayi (provider ne clear status nahi diya).';
  }
}

export function passengerSummaryLine(passengers: readonly { name: string; age: number | null; gender: string | null; berthPreference: string | null }[]): string {
  return passengers
    .map((passenger, index) => {
      const parts = [passenger.name];
      if (passenger.age !== null) parts.push(`${passenger.age}y`);
      if (passenger.gender) parts.push(passenger.gender);
      if (passenger.berthPreference) parts.push(`(${passenger.berthPreference})`);
      return `${index + 1}. ${parts.join(' · ')}`;
    })
    .join('\n');
}

/** §23: reusable BookingSummary — only fields that actually exist are included. */
export interface BookingSummaryData {
  originCode: string | null;
  destinationCode: string | null;
  journeyDate: string | null;
  trainNumber: string | null;
  trainName: string | null;
  travelClass: string | null;
  passengerCount: number | null;
  passengers: string | null;
  availabilityStatus: string | null;
  railwayFareMinor: number | null;
  serviceFeeMinor: number | null;
  totalPayableMinor: number | null;
}

export function buildBookingSummary(input: {
  context: ConversationContext;
  railwayFareMinor?: number | null;
  availabilityStatus?: string | null;
}): BookingSummaryData {
  const context = input.context;
  const railwayFareMinor = input.railwayFareMinor ?? null;
  return {
    originCode: context.origin?.code ?? null,
    destinationCode: context.destination?.code ?? null,
    journeyDate: context.journeyDate,
    trainNumber: context.selectedTrain?.number ?? null,
    trainName: context.selectedTrain?.name ?? null,
    travelClass: context.selectedClass,
    passengerCount: context.passengerCount,
    passengers: context.passengers.length > 0 ? passengerSummaryLine(context.passengers) : null,
    availabilityStatus: input.availabilityStatus ?? null,
    railwayFareMinor,
    serviceFeeMinor: railwayFareMinor !== null ? APPLICATION_SERVICE_FEE_MINOR : null,
    totalPayableMinor: railwayFareMinor !== null ? totalPayableMinor(railwayFareMinor) : null,
  };
}

/** §13: final review (with passengers) before explicit confirmation. */
export function finalReviewReply(input: {
  summary: BookingSummaryData;
  draftId: string;
}): string {
  const lines: string[] = ['BOOKING REVIEW'];
  if (input.summary.trainNumber) {
    lines.push(`Train: ${input.summary.trainNumber}${input.summary.trainName ? ` — ${input.summary.trainName}` : ''}`);
  }
  if (input.summary.originCode && input.summary.destinationCode) {
    lines.push(`Journey: ${input.summary.originCode} → ${input.summary.destinationCode}`);
  }
  if (input.summary.journeyDate) lines.push(`Date: ${input.summary.journeyDate}`);
  if (input.summary.travelClass) lines.push(`Class: ${input.summary.travelClass}`);
  if (input.summary.passengerCount) lines.push(`Passengers: ${input.summary.passengerCount}`);
  if (input.summary.passengers) lines.push(input.summary.passengers);
  if (input.summary.railwayFareMinor !== null) lines.push(`Railway fare: ${rupees(input.summary.railwayFareMinor)}`);
  if (input.summary.serviceFeeMinor !== null) lines.push(`${SERVICE_FEE_LABEL}: ${rupees(input.summary.serviceFeeMinor)}`);
  if (input.summary.totalPayableMinor !== null) lines.push(`Total: ${rupees(input.summary.totalPayableMinor)}`);
  lines.push('');
  lines.push('Sab details sahi hain? Kya main booking confirm karun? (haan / nahi)');
  lines.push(`(Draft ${input.draftId})`);
  return lines.join('\n');
}

export function mockBookingSuccessReply(booking: { id: string; totalChargedMinor: number | null; isDemo?: boolean }): string {
  return [
    '🎉 DEMO booking complete!',
    `Booking ID: ${booking.id} — ye ek DEMO record hai (koi real railway ticket nahi, koi PNR issue nahi hua).`,
    booking.totalChargedMinor !== null ? `Wallet (demo ledger) se ${rupees(booking.totalChargedMinor)} kat gaye.` : '',
    'Real booking capability baad ke step mein aayegi.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function mockBookingFailureReply(reason: string): string {
  return `Booking complete nahi ho paayi. ${reason} Please try again.`;
}

// ── failure / unavailable (never filled, never approximated) ────────────────

export function railwayUnavailableReply(result: ToolResult): string {
  if (result.unavailableReason === 'NO_RESULTS') return 'Is route/date par koi train nahi mili. Koi aur date ya route try karein?';
  if (result.unavailableReason === 'NOT_FOUND') return 'Ye train/PNR nahi mila — number check karke phir try karein.';
  if (result.error?.code === 'INVALID_RAILWAY_QUERY') return `Query thodi galat lag rahi hai: ${result.error.message}`;
  if (result.error?.code === 'RAILWAY_CAPABILITY_UNSUPPORTED') return 'Ye jaankari abhi available nahi hai.';
  return 'Abhi railway data available nahi ho raha. Thodi der baad try karein — main andaza nahi lagaunga.';
}

export function cannotDoThatReply(): string {
  return 'Ye main kar nahi sakta — booking confirm ya paise se related kaam server-side safety checks ke through hi honge.';
}

export function isGreetingMessage(message: string): boolean {
  const trimmed = message.trim().toLowerCase().replace(/[!.?]+$/g, '').trim();
  return /^(hi|hii+|hello|hey+|namaste|namaskar|yo|hola|salaam|salam|good morning|good evening|good afternoon|good night)(\s+(ji|bhai|yaar))?$/.test(trimmed);
}

export function greetingReply(): string {
  return 'Namaste! 🙏 BookKaro mein aapka swagat hai. Main trains search, live status, fare, availability, PNR aur booking — sab handle karta hoon. Batayein kya chahiye?';
}

export function rephraseReply(): string {
  return 'Main aapki madad ke liye yahan hoon 🚆 — trains, tickets, live status, fare, PNR, booking. Thoda aur clearly batayein kya chahiye? Jaise: "Amritsar se Ludhiana kal", "12014 ka live status", ya "PNR check karo".';
}

// ── data replies ─────────────────────────────────────────────────────────────

export function searchResultsReply(results: readonly TrainSearchResult[], from: Station | null, to: Station | null): string {
  if (results.length === 0) return 'Is route/date par koi train nahi mili.';
  if (results.length === 1) {
    const only = results[0]!;
    return `${stationLabel(from)} se ${stationLabel(to)} ke liye sirf 1 train mili — ${trainLabel(only.train)}. Neeche card dekhiye.`;
  }
  const names = results.slice(0, 4).map((entry) => entry.train.number).join(', ');
  const more = results.length > 4 ? ` +${results.length - 4}` : '';
  return `${stationLabel(from)} se ${stationLabel(to)} ke liye ${results.length} trains mili (${names}${more}) — neeche list dekhiye. Kaunsi leni hai? Card pe tap karein, train number, ya naam (jaise "Shatabdi wali") bataiye.`;
}

export function liveStatusReply(status: LiveStatus): string {
  const train = status.trainNumber;
  const delay = status.delayMinutes;
  const delayText = delay === null || delay === undefined ? '' : delay === 0 ? ' aur time par chal rahi hai' : ` aur ${delay} minute late hai`;
  const where = status.currentStation ? ` abhi ${stationLabel(status.currentStation)} par hai` : '';
  const nextStop = status.nextStationCode ? ` Agla station ${status.nextStationCode}.` : '';
  switch (status.status) {
    case 'RUNNING':
    case 'AT_STATION':
      return `${train}${where}${delayText}.${nextStop}`;
    case 'COMPLETED':
    case 'ARRIVED':
      return `${train} apni destination pahunch chuki hai${delay ? ` ( approx ${delay} minute late)` : ''}.`;
    case 'DELAYED':
      return `${train} abhi late chal rahi hai${where}${delayText}.`;
    case 'ON_TIME':
      return `${train} time par chal rahi hai${where}.`;
    case 'NOT_STARTED':
      return `${train} abhi start nahi hui hai.`;
    case 'CANCELLED':
      return `${train} aaj cancel hai.`;
    case 'DIVERTED':
      return `${train} ka route divert ho gaya hai.`;
    default:
      return `${train} ka live status abhi pata nahi chal paaya.`;
  }
}

export function availabilityReply(availability: Availability): string {
  const base = `${availability.trainNumber} mein ${availability.travelClass} (${availability.quota}) — ${availability.journeyDate}:`;
  switch (availability.status) {
    case 'AVAILABLE':
      return `${base} seats AVAILABLE hain${availability.availableCount !== null ? ` (${availability.availableCount} seats)` : ''}.`;
    case 'RAC':
      return `${base} RAC hai${availability.racCount !== null ? ` (${availability.racCount} RAC)` : ''}.`;
    case 'WAITLIST':
      return `${base} waiting list hai${availability.waitlistNumber !== null ? ` (WL ${availability.waitlistNumber})` : ''}.`;
    case 'REGRET':
      return `${base} REGRET hai (booking band).`;
    default:
      return `${base} availability abhi available nahi hai.`;
  }
}

export function fareReply(fare: Fare): string {
  const railwayTotal = fare.breakdown.totalMinor ?? 0;
  const route = `${fare.fromStationCode} → ${fare.toStationCode}`;
  const breakdownParts: string[] = [];
  if (fare.breakdown.baseFareMinor !== null) breakdownParts.push(`base ${rupees(fare.breakdown.baseFareMinor)}`);
  if (fare.breakdown.reservationChargeMinor !== null) breakdownParts.push(`reservation ${rupees(fare.breakdown.reservationChargeMinor)}`);
  if (fare.breakdown.superfastChargeMinor !== null) breakdownParts.push(`superfast ${rupees(fare.breakdown.superfastChargeMinor)}`);
  if (fare.breakdown.cateringChargeMinor !== null) breakdownParts.push(`catering ${rupees(fare.breakdown.cateringChargeMinor)}`);
  if (fare.breakdown.gstMinor !== null) breakdownParts.push(`GST ${rupees(fare.breakdown.gstMinor)}`);
  const breakdownLine = breakdownParts.length > 0 ? ` (${breakdownParts.join(' + ')})` : '';
  // Railway fare, application service fee and total payable are ALWAYS shown separately.
  return [
    `${fare.trainNumber} ${route} ${fare.travelClass}:`,
    `• Railway fare: ${rupees(railwayTotal)}${breakdownLine}`,
    `• ${SERVICE_FEE_LABEL}: ${rupees(APPLICATION_SERVICE_FEE_MINOR)}`,
    `• Total payable: ${rupees(totalPayableMinor(railwayTotal))}`,
  ].join('\n');
}

export function fareLinesForReview(fare: Fare): string[] {
  const railwayTotal = fare.breakdown.totalMinor ?? 0;
  return [
    `• Railway fare (${fare.travelClass}): ${rupees(fare.breakdown.totalMinor)}`,
    `• ${SERVICE_FEE_LABEL}: ${rupees(APPLICATION_SERVICE_FEE_MINOR)}`,
    `• Total payable: ${rupees(totalPayableMinor(railwayTotal))}`,
  ];
}

export function multiClassFareReply(trainNumber: string, fares: readonly Fare[]): string {
  const lines = fares.map((fare) => `${fare.travelClass}: ${rupees(fare.breakdown.totalMinor)}`);
  return `${trainNumber} ${fares[0]?.fromStationCode ?? '?'} → ${fares[0]?.toStationCode ?? '?'} fares:\n${lines.join('\n')}`;
}

export function timetableReply(timetable: Timetable): string {
  const stops = timetable.stops.slice(0, 6).map((stop, index) => {
    const arrive = stop.arrivalTime ?? '—';
    const depart = stop.departureTime ?? '—';
    return `${index + 1}. ${stop.stationName ?? stop.stationCode} (a:${arrive} d:${depart})`;
  });
  const more = timetable.stops.length > 6 ? `\n…aur ${timetable.stops.length - 6} stops` : '';
  return `${trainLabel({ number: timetable.trainNumber, name: timetable.trainName })} ka timetable (${timetable.stops.length} stops):\n${stops.join('\n')}${more}`;
}

export function trainInfoReply(train: Train): string {
  const runs = train.runsOn ? `Hafte ke ${train.runsOn.length} din chalti hai.` : '';
  const classes = train.travelClasses ? ` Classes: ${train.travelClasses.join('/')}.` : '';
  return `${trainLabel(train)}.\n${train.originStation ? stationLabel(train.originStation) : '?'} se ${train.destinationStation ? stationLabel(train.destinationStation) : '?'} tak.${classes} ${runs}`.trim();
}

export function pnrReply(status: PNRStatus): string {
  const passengers = status.passengers
    ? status.passengers
        .slice(0, 3)
        .map((p) => `\n• Passenger ${p.passengerNumber}: ${p.currentStatus ?? p.bookingStatus ?? '?'}${p.coach ? ` (${p.coach}${p.seat ? `-${p.seat}` : ''})` : ''}`)
        .join('')
    : '';
  const chart = status.chartPrepared === null ? '' : status.chartPrepared ? ' Chart ban chuka hai.' : ' Chart abhi nahi bana.';
  return `PNR ${status.pnr}: ${status.overallStatus}${status.trainNumber ? ` — train ${status.trainNumber}` : ''}.${chart}${passengers}`;
}

export function cancelledReply(trains: readonly CancelledTrain[]): string {
  if (trains.length === 0) return 'Aaj koi cancelled train nahi mili.';
  const lines = trains.slice(0, 5).map((t) => `• ${t.trainNumber}${t.trainName ? ` — ${t.trainName}` : ''}${t.reason === 'PARTIALLY_CANCELLED' ? ' (partially cancelled)' : ''}`);
  return `${trains.length} cancelled trains mili:\n${lines.join('\n')}${trains.length > 5 ? `\n…aur ${trains.length - 5}` : ''}`;
}

export function bookingsReply(bookings: readonly unknown[]): string {
  if (bookings.length === 0) {
    return 'Aapki koi booked ticket nahi mili (booking system abhi live nahi hai — isliye koi ticket exist nahi karti).';
  }
  return `Aapki ${bookings.length} bookings mili.`;
}

export function walletReply(result: ToolResult): string {
  if (!result.ok) return 'Wallet abhi available nahi hai (wallet system implement nahi hua hai).';
  return 'Wallet balance abhi available nahi hai.';
}

export function stationsReply(stations: readonly Station[]): string {
  if (stations.length === 0) return 'Ye naam ka station nahi mila.';
  const lines = stations.slice(0, 4).map((station) => `• ${stationLabel(station)}${station.state ? ` — ${station.state}` : ''}`);
  return `Station mila:\n${lines.join('\n')}`;
}

export function comparisonReply(a: TrainSearchResult, b: TrainSearchResult, fareA: Fare | null = null, fareB: Fare | null = null): string {
  const fmt = (entry: TrainSearchResult, fare: Fare | null) => {
    const duration =
      entry.durationMinutes !== null ? `${Math.floor(entry.durationMinutes / 60)}h ${entry.durationMinutes % 60}m` : 'pata nahi';
    const fareText = fare?.breakdown.totalMinor != null ? `, railway fare ${rupees(fare.breakdown.totalMinor)} (${fare.travelClass})` : '';
    return `${entry.train.number}: ${entry.departureTime ?? '?'} → ${entry.arrivalTime ?? '?'}, duration ${duration}${fareText}${
      entry.train.travelClasses ? `, classes ${entry.train.travelClasses.join('/')}` : ''
    }`;
  };
  const lines: string[] = [];
  if (a.durationMinutes !== null && b.departureTime !== null && a.departureTime !== null) {
    const aParts = a.departureTime.split(':').map(Number);
    const bParts = b.departureTime.split(':').map(Number);
    const ah = aParts[0] ?? NaN;
    const am = aParts[1] ?? 0;
    const bh = bParts[0] ?? NaN;
    const bm = bParts[1] ?? 0;
    if (Number.isFinite(ah) && Number.isFinite(bh)) {
      const diff = bh * 60 + bm - (ah * 60 + am);
      if (diff > 0) lines.push(`${b.train.number} ${diff} minute later nikalti hai.`);
      else if (diff < 0) lines.push(`${a.train.number} ${-diff} minute later nikalti hai.`);
    }
  }
  if (a.durationMinutes !== null && b.durationMinutes !== null && a.durationMinutes !== b.durationMinutes) {
    const faster = a.durationMinutes < b.durationMinutes ? a : b;
    const diff = Math.abs(a.durationMinutes - b.durationMinutes);
    lines.push(diff <= 10 ? `Duration almost same hai (${diff} minute ka farak) — ${faster.train.number} thoda tez.` : `Duration ke hisaab se ${faster.train.number} ${diff} minute tez hai.`);
  } else if (a.durationMinutes !== null && b.durationMinutes !== null) {
    lines.push('Dono ka duration same hai.');
  }
  if (fareA?.breakdown.totalMinor != null && fareB?.breakdown.totalMinor != null) {
    lines.push(`Railway fare: ${a.train.number} ${rupees(fareA.breakdown.totalMinor)}, ${b.train.number} ${rupees(fareB.breakdown.totalMinor)}.`);
  }
  const fareNote = fareA || fareB ? '' : '\n(Fare abhi provider se available nahi — jab aayega tab bata dunga. Availability ke liye alag se poochhiye.)';
  return `Compare (current search results se):\n${fmt(a, fareA)}\n${fmt(b, fareB)}\n${lines.join('\n')}${fareNote}`;
}

export function draftReply(draftId: string, trainNumber: string | null, travelClass: string | null, passengers: number | null): string {
  return `Booking draft ban gaya (ID: ${draftId}) — ${trainNumber ?? '?'} ${travelClass ?? ''}, ${passengers ?? '?'} passengers ke liye.\nNote: final booking abhi implement nahi hui hai — confirm karne ka option agle step mein aayega. Koi paise nahi katenge.`;
}

export function selectionReply(entry: TrainSearchResult): string {
  const offered = entry.train.travelClasses ?? [];
  const classes = offered.length > 0 ? ` Classes: ${offered.join('/')}.` : '';
  return `Theek hai — ${trainLabel(entry.train)} select kar li.${classes} ${askForClass(offered)}`;
}

export function stationChoiceReply(field: 'origin' | 'destination', options: readonly Station[]): string {
  const list = options.map((station) => `${station.name ?? station.code} (${station.code})`).join(', ');
  const label = field === 'origin' ? 'boarding (kahan se)' : 'destination (kahan tak)';
  return `Is jagah ke multiple stations mile: ${list}. ${label} ke liye inme se EK station choose karein — chip tap karein, ya naam/code type karein.`;
}

export function cancelledSpecificReply(trainNumber: string, cancelled: readonly CancelledTrain[]): string {
  const hit = cancelled.find((entry) => entry.trainNumber === trainNumber);
  if (hit) {
    return `${trainNumber} (${hit.trainName ?? 'train'}) provider ke cancelled list mein hai — ${hit.reason === 'PARTIALLY_CANCELLED' ? 'partially cancelled' : 'fully cancelled'}.`;
  }
  return `${trainNumber} aaj ke cancelled list mein NAHI hai (provider ki list se check kiya).`;
}

export function cancelledListUnfilteredReply(count: number, sample: readonly CancelledTrain[]): string {
  const lines = sample.slice(0, 4).map((t) => `• ${t.trainNumber}${t.trainName ? ` — ${t.trainName}` : ''}`);
  return `Provider aaj ki poori cancelled list deta hai (${count} trains) — station-wise filter uska support nahi karta, isliye ye poore network ki list hai:\n${lines.join('\n')}${count > 4 ? `\n…aur ${count - 4}` : ''}\nKisi specific train ke liye poochhiye — main us number ko list mein check kar dunga.`;
}

export function bookingReviewReply(input: {
  draftId: string;
  trainNumber: string;
  trainName: string | null;
  travelClass: string;
  journeyDate: string;
  originCode: string;
  destinationCode: string;
  passengerCount: number;
  fareLines: string[];
}): string {
  return [
    'Booking review — sab confirm kar lijiye:',
    `• Train: ${input.trainNumber}${input.trainName ? ` — ${input.trainName}` : ''} (${input.travelClass})`,
    `• ${input.journeyDate} • ${input.originCode} → ${input.destinationCode} • ${input.passengerCount} passenger${input.passengerCount > 1 ? 's' : ''}`,
    ...input.fareLines,
    '',
    'Confirm karein? (haan / nahi)',
    `(Draft ${input.draftId})`,
  ].join('\n');
}

export function confirmationRecordedReply(): string {
  return 'Aapki confirmation note kar li ✅ — lekin final booking execution abhi enabled nahi hai, isliye abhi koi paise nahi katenge aur ticket issue nahi hogi. Jaise hi execution live hoga, ye draft wahi se complete hoga.';
}

export function confirmationDeclinedReply(): string {
  return 'Theek hai, booking yahin rok dete hain — kuch aur chahiye? (draft safe hai, baad mein continue kar sakte hain)';
}

export function notAwaitingConfirmationReply(): string {
  return 'Main abhi kisi booking confirmation ka wait nahi kar raha. Pehle search karke train/class choose karein — phir poori review ke baad confirmation milegi.';
}

export function stationResolveFailedReply(name: string): string {
  return `"${name}" station ki jaankari abhi railway source se nahi mil paayi (main andaza nahi lagata). Thodi der baad try karein — ya station ka poora naam bataiye (jaise "Haridwar Jn").`;
}

export function contextEchoReply(context: ConversationContext): string {
  const parts: string[] = [];
  if (context.origin) parts.push(`from: ${stationLabel(context.origin)}`);
  if (context.destination) parts.push(`to: ${stationLabel(context.destination)}`);
  if (context.journeyDate) parts.push(`date: ${context.journeyDate}`);
  if (context.passengerCount) parts.push(`passengers: ${context.passengerCount}`);
  return parts.length > 0 ? `(Ab tak: ${parts.join(', ')})` : '';
}
