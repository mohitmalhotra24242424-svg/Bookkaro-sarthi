/**
 * RailKit response normalization.
 *
 * Verified sources: official docs (railkit.rajivdubey.dev/docs) field examples
 * (`result.data.trainInfo.train_name`, `result.data.route`, `data.statusNote`,
 * `data.timeline`, `t.train_name`, `d.baseFare/d.gst/d.totalFare`,
 * `result.data.fullyCancelledTrains`) plus the published SDK typings
 * (`fareLookup` returns baseFare, reservation, superfast, catering, GST,
 * dynamicFare, totalFare). Where the docs do not fully specify a shape, the
 * parser accepts documented aliases and leaves unknowns as null — it never
 * invents values. Passenger NAMES are deliberately dropped (privacy: never
 * logged, never normalized onward).
 */

import type {
  Availability,
  AvailabilityStatus,
  CancelledTrain,
  Fare,
  FareBreakdown,
  LiveRunStatus,
  LiveStatus,
  PNRPassengerStatus,
  PNRStatus,
  PNRStatusLevel,
  Station,
  Timetable,
  Train,
  TrainSearchResult,
  TrainStop,
} from '../../../shared/index.js';
import {
  asArray,
  asRecord,
  asString,
  pickInteger,
  pickNumber,
  pickString,
  pickTime,
  rupeesToMinor,
  unwrapEnvelope,
} from '../parse.js';
import type { UnknownRecord } from '../parse.js';

/** {success:true, data: ...} envelopes are standard for the SDK (verified). */
export interface SdkEnvelope {
  success: boolean;
  payload: unknown;
  message: string | null;
}

export function interpretSdkResult(result: unknown): SdkEnvelope | null {
  const record = asRecord(result);
  if (!record) return null;
  if (record.success === false) {
    return { success: false, payload: null, message: pickString(record, 'message', 'error') };
  }
  return { success: true, payload: 'data' in record ? record.data : result, message: null };
}

function stationFromCode(code: string | null, name: string | null): Station {
  return { code: code ?? '', name, zone: null, state: null, latitude: null, longitude: null };
}

/** searchTrainBetweenStations: data is an ARRAY of trains with t.train_name (verified docs). */
export function normalizeRailKitTrainSearch(payload: unknown): TrainSearchResult[] | null {
  const array = asArray(unwrapEnvelope(payload));
  if (!array) return null;
  const results: TrainSearchResult[] = [];
  for (const entry of array) {
    const record = asRecord(entry);
    if (!record) continue;
    const number = pickString(record, 'train_no', 'trainNumber', 'number', 'train_number');
    if (!number) continue;
    const fromCode = pickString(record, 'from_station_code', 'from');
    const fromName = pickString(record, 'from_station_name', 'from_name');
    const toCode = pickString(record, 'to_station_code', 'to');
    const toName = pickString(record, 'to_station_name', 'to_name');
    const originCode = pickString(record, 'origin_station_code', 'source_station_code') ?? fromCode;
    const originName = pickString(record, 'origin_station_name', 'source_station_name') ?? fromName;
    const destCode = pickString(record, 'destination_station_code') ?? toCode;
    const destName = pickString(record, 'destination_station_name') ?? toName;
    const train: Train = {
      number,
      name: pickString(record, 'train_name', 'trainName', 'name'),
      originStation: stationFromCode(originCode, originName),
      destinationStation: stationFromCode(destCode, destName),
      departureTime: pickTime(record, 'departure', 'dep', 'departure_time'),
      arrivalTime: pickTime(record, 'arrival', 'arr', 'arrival_time'),
      runsOn: null,
      travelClasses: null,
      pantryCar: null,
    };
    results.push({
      train,
      fromStation: stationFromCode(fromCode, fromName),
      toStation: stationFromCode(toCode, toName),
      departureTime: train.departureTime,
      arrivalTime: train.arrivalTime,
      durationMinutes: pickNumber(record, 'duration', 'duration_minutes', 'durationMin'),
    });
  }
  return results;
}

function routeToStops(route: unknown): TrainStop[] | null {
  const array = asArray(route);
  if (!array) return null;
  const stops: TrainStop[] = [];
  for (const entry of array) {
    const record = asRecord(entry);
    if (!record) continue;
    const stationCode = pickString(record, 'station_code', 'stationCode', 'code');
    if (!stationCode) continue;
    stops.push({
      stationCode,
      stationName: pickString(record, 'station_name', 'stationName', 'name'),
      arrivalTime: pickTime(record, 'arrival', 'arrival_time', 'arr'),
      departureTime: pickTime(record, 'departure', 'departure_time', 'dep'),
      dayCount: pickInteger(record, 'day', 'day_count'),
      distanceKm: pickNumber(record, 'distance', 'distance_km'),
      haltMinutes: pickNumber(record, 'halt', 'halt_minutes'),
    });
  }
  return stops;
}

/** getTrainInfo: data.trainInfo.train_name + data.route[] (verified docs). */
export function normalizeRailKitTrainInfo(payload: unknown): Train | null {
  const data = unwrapEnvelope(payload);
  const container = asRecord(data);
  const info = container ? asRecord(container.trainInfo) ?? container : null;
  if (!info) return null;
  const number = pickString(info, 'train_no', 'trainNumber', 'train_number', 'number');
  if (!number) return null;
  return {
    number,
    name: pickString(info, 'train_name', 'trainName', 'name'),
    originStation: stationFromCode(pickString(info, 'from_station_code', 'from'), pickString(info, 'from_station_name')),
    destinationStation: stationFromCode(pickString(info, 'to_station_code', 'to'), pickString(info, 'to_station_name')),
    departureTime: pickTime(info, 'departure', 'start_time'),
    arrivalTime: pickTime(info, 'arrival', 'end_time'),
    runsOn: null,
    travelClasses: null,
    pantryCar: null,
  };
}

/** Timetable derived from the same official getTrainInfo route data (documented: "Route, stops, schedule"). */
export function normalizeRailKitTimetable(payload: unknown, trainNumber: string): Timetable | null {
  const data = unwrapEnvelope(payload);
  const container = asRecord(data);
  if (!container) return null;
  const info = asRecord(container.trainInfo) ?? container;
  const stops = routeToStops(container.route ?? container.stops);
  if (!stops) return null;
  return {
    trainNumber: pickString(info, 'train_no', 'trainNumber', 'train_number') ?? trainNumber,
    trainName: pickString(info, 'train_name', 'trainName'),
    stops,
  };
}

const LIVE_STATUS_MAP: Readonly<Record<string, LiveRunStatus>> = {
  RUNNING: 'RUNNING',
  ON_TIME: 'ON_TIME',
  DELAYED: 'DELAYED',
  ARRIVED: 'ARRIVED',
  NOT_STARTED: 'NOT_STARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  AT_STATION: 'AT_STATION',
};

/** trackTrain: data.statusNote + data.timeline[] (verified docs). */
export function normalizeRailKitLiveStatus(payload: unknown, trainNumber: string): LiveStatus | null {
  const data = unwrapEnvelope(payload);
  const record = asRecord(data);
  if (!record) return null;
  const rawStatus = asString(record.status)?.toUpperCase();
  const explicitStatus = rawStatus && LIVE_STATUS_MAP[rawStatus] ? LIVE_STATUS_MAP[rawStatus] : null;

  const delay = pickNumber(record, 'delay', 'delay_minutes', 'delayMinutes', 'delay_mins');
  let status: LiveRunStatus = explicitStatus ?? 'UNKNOWN';
  if (!explicitStatus && delay !== null) status = delay > 0 ? 'DELAYED' : 'ON_TIME';

  const current = asRecord(record.currentStation ?? record.current_station ?? record.current);
  const timelineStops = routeToStops(record.timeline);

  return {
    trainNumber: pickString(record, 'train_no', 'trainNumber', 'train_number') ?? trainNumber,
    journeyDate: pickString(record, 'journey_date', 'journeyDate', 'date'),
    status,
    delayMinutes: delay,
    nextStationCode: pickString(record, 'next_station_code', 'nextStationCode'),
    currentStation: current
      ? stationFromCode(pickString(current, 'station_code', 'stationCode', 'code'), pickString(current, 'station_name', 'stationName', 'name'))
      : null,
    lastUpdatedAt: pickString(record, 'last_updated', 'lastUpdated', 'updated_at', 'last_reported'),
    upcomingStops: timelineStops,
  };
}

const AVAILABILITY_STATUS_MAP: Readonly<Record<string, AvailabilityStatus>> = {
  AVAILABLE: 'AVAILABLE',
  CNF: 'AVAILABLE',
  CONFIRMED: 'AVAILABLE',
  RAC: 'RAC',
  WL: 'WAITLIST',
  WAITLIST: 'WAITLIST',
  REGRET: 'REGRET',
  NOT_AVAILABLE: 'UNAVAILABLE',
  NO_ROOM: 'UNAVAILABLE',
  UNKNOWN: 'UNAVAILABLE',
};

function availabilityTextStatus(text: string | null): AvailabilityStatus | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper.startsWith('AVAILABLE') || upper.startsWith('AVL') || /^AVL?\d*$/i.test(upper)) return 'AVAILABLE';
  if (upper.startsWith('RAC')) return 'RAC';
  if (upper.startsWith('GNWL') || upper.startsWith('RLWL') || upper.startsWith('PQWL') || upper.startsWith('TQWL') || upper.startsWith('WL')) {
    return 'WAITLIST';
  }
  if (upper.startsWith('REGRET') || upper.startsWith('NOT AVAILABLE') || upper === 'N/A') return 'REGRET';
  return null;
}

/** getAvailability: shape partially documented ("availability forecasts and fare breakup"). */
export function normalizeRailKitAvailability(
  payload: unknown,
  query: { trainNumber: string; journeyDate: string; travelClass: string; quota: string },
): Availability | null {
  const data = unwrapEnvelope(payload);
  const record = asRecord(data);
  if (!record) return null;
  const inner = asRecord(record.availability ?? record.status) ?? record;

  const rawStatus = pickString(inner, 'status', 'availability', 'availability_status', 'availabilityStatus');
  const text = pickString(inner, 'availability_text', 'availabilityText', 'status_text', 'text');
  const parsed =
    (rawStatus ? AVAILABILITY_STATUS_MAP[rawStatus.toUpperCase()] : null) ??
    availabilityTextStatus(rawStatus) ??
    availabilityTextStatus(text) ??
    'UNAVAILABLE';

  return {
    trainNumber: query.trainNumber,
    journeyDate: query.journeyDate,
    travelClass: query.travelClass.toUpperCase() as Availability['travelClass'],
    quota: query.quota.toUpperCase() as Availability['quota'],
    status: parsed,
    availableCount: pickNumber(inner, 'available', 'available_count', 'availableCount', 'seats'),
    racCount: pickNumber(inner, 'rac', 'rac_count', 'racCount'),
    waitlistNumber: pickNumber(inner, 'waitlist', 'wl', 'waitlist_number', 'waitingListCount'),
    asOf: pickString(record, 'last_updated', 'lastUpdated', 'as_of'),
  };
}

/** fareLookup: returns baseFare, reservation, superfast, catering, GST, dynamicFare, totalFare (verified typings). */
export function normalizeRailKitFare(
  payload: unknown,
  query: { trainNumber: string; fromStationCode: string; toStationCode: string; travelClass: string | null; quota: string; journeyDate: string },
): Fare | null {
  const data = unwrapEnvelope(payload);
  const record = asRecord(data);
  if (!record) return null;
  const totalMinor = rupeesToMinor(record.totalFare ?? record.total_fare ?? record.total);
  if (totalMinor === null) return null;

  const breakdown: FareBreakdown = {
    baseFareMinor: rupeesToMinor(record.baseFare ?? record.base_fare),
    reservationChargeMinor: rupeesToMinor(record.reservation ?? record.reservationCharge),
    superfastChargeMinor: rupeesToMinor(record.superfast ?? record.superfastCharge),
    dynamicFareMinor: rupeesToMinor(record.dynamicFare ?? record.dynamic_fare),
    cateringChargeMinor: rupeesToMinor(record.catering ?? record.cateringCharge),
    gstMinor: rupeesToMinor(record.gst ?? record.GST ?? record.gstAmount),
    totalMinor,
  };

  return {
    trainNumber: pickString(record, 'trainNo', 'train_no', 'trainNumber') ?? query.trainNumber,
    fromStationCode: query.fromStationCode.toUpperCase(),
    toStationCode: query.toStationCode.toUpperCase(),
    journeyDate: query.journeyDate,
    travelClass: (query.travelClass ?? (pickString(record, 'class', 'classCode') ?? '3A')).toUpperCase() as Fare['travelClass'],
    quota: query.quota.toUpperCase() as Fare['quota'],
    currency: 'INR',
    breakdown,
    source: 'RAILKIT',
    retrievedAt: new Date().toISOString(),
  };
}

const PNR_STATUS_MAP: Readonly<Record<string, PNRStatusLevel>> = {
  CNF: 'CONFIRMED',
  CONFIRMED: 'CONFIRMED',
  RAC: 'RAC',
  WL: 'WAITLIST',
  WAITLIST: 'WAITLIST',
  CAN: 'CANCELLED',
  CANCELLED: 'CANCELLED',
};

/** checkPNRStatus: data.{pnr, status, train, journey, chart, passengers[]} (verified docs). Passenger names dropped. */
export function normalizeRailKitPnr(payload: unknown): PNRStatus | null {
  const data = unwrapEnvelope(payload);
  const record = asRecord(data);
  if (!record) return null;

  const rawStatus = pickString(record, 'status', 'pnr_status');
  const overallStatus = (rawStatus ? PNR_STATUS_MAP[rawStatus.toUpperCase()] : undefined) ?? 'UNKNOWN';

  const chart = asRecord(record.chart);
  const chartStatusText = chart ? pickString(chart, 'status', 'message') : null;

  const passengersArray = asArray(record.passengers);
  const passengers: PNRPassengerStatus[] = [];
  if (passengersArray) {
    let index = 0;
    for (const entry of passengersArray) {
      index += 1;
      const passenger = asRecord(entry);
      if (!passenger) continue;
      const current = asRecord(passenger.current);
      const bookingStatus = pickString(passenger, 'booking_status', 'bookingStatus');
      const currentStatus =
        (current ? pickString(current, 'details', 'status') : null) ?? pickString(passenger, 'current_status', 'currentStatus', 'status');
      const seatRaw = pickString(passenger, 'seat', 'berth') ?? (current ? pickString(current, 'seat') : null);
      const seatParts = typeof seatRaw === 'string' && seatRaw.includes('-') ? seatRaw.split('-') : null;
      passengers.push({
        passengerNumber: pickInteger(passenger, 'no', 'number', 'sn') ?? index,
        bookingStatus,
        currentStatus,
        coach: seatParts ? seatParts[0] ?? null : pickString(passenger, 'coach'),
        seat: seatParts ? seatParts[1] ?? seatRaw : seatRaw,
      });
    }
  }

  const train = asRecord(record.train);
  const journey = asRecord(record.journey);
  const source = journey ? asRecord(journey.source ?? journey.from ?? journey.boarding) : null;
  const destination = journey ? asRecord(journey.destination ?? journey.to) : null;

  return {
    pnr: pickString(record, 'pnr', 'pnrNumber') ?? '',
    trainNumber: train ? pickString(train, 'number', 'train_no', 'trainNumber') : null,
    journeyDate: pickString(journey ?? record, 'journey_date', 'journeyDate', 'date'),
    fromStationCode: source ? pickString(source, 'code', 'station_code') : null,
    toStationCode: destination ? pickString(destination, 'code', 'station_code') : null,
    chartPrepared:
      chartStatusText !== null ? /prepared/i.test(chartStatusText) : typeof record.chart_prepared === 'boolean' ? record.chart_prepared : null,
    overallStatus,
    passengers: passengersArray ? passengers : null,
  };
}

/** cancelList: {summary, data:{fullyCancelledTrains[], partiallyCancelledTrains[]}} (verified docs). */
export function normalizeRailKitCancelled(payload: unknown): CancelledTrain[] | null {
  const record = asRecord(payload); // envelope carries BOTH summary and data (verified example)
  const container = record ? asRecord(record.data) ?? record : null;
  if (!container) return null;
  const fully = asArray(container.fullyCancelledTrains ?? container.fully_cancelled_trains) ?? [];
  const partial = asArray(container.partiallyCancelledTrains ?? container.partially_cancelled_trains) ?? [];

  const cancelled: CancelledTrain[] = [];
  for (const entry of fully) {
    const train = asRecord(entry);
    if (!train) continue;
    const number = pickString(train, 'trainNo', 'train_no', 'trainNumber', 'number');
    if (!number) continue;
    cancelled.push({
      trainNumber: number,
      trainName: pickString(train, 'trainName', 'train_name', 'name'),
      journeyDate: null, // RailKit cancelList() is not date-parameterized (verified) — never invent a date
      reason: 'FULLY_CANCELLED',
    });
  }
  for (const entry of partial) {
    const train = asRecord(entry);
    if (!train) continue;
    const number = pickString(train, 'trainNo', 'train_no', 'trainNumber', 'number');
    if (!number) continue;
    cancelled.push({
      trainNumber: number,
      trainName: pickString(train, 'trainName', 'train_name', 'name'),
      journeyDate: null,
      reason: 'PARTIALLY_CANCELLED',
    });
  }
  return cancelled;
}
