/**
 * RailCore response normalization — VERIFIED against the official docs
 * (railcore.tech/docs, captured 2026-08-26). RailCore snake_case field names
 * are mapped to the shared types HERE and nowhere else.
 * Missing fields become null — never invented.
 */

import type {
  Availability,
  AvailabilityStatus,
  Fare,
  FareBreakdown,
  LiveRunStatus,
  LiveStatus,
  QuotaCode,
  Station,
  Timetable,
  Train,
  TrainSearchResult,
  TrainStop,
  TravelClassCode,
  WeekdayCode,
} from '../../../shared/index.js';
import { QUOTAS, TRAVEL_CLASSES } from '../../../shared/index.js';
import {
  asRecord,
  asString,
  normalizeTravelClasses,
  normalizeWeekdays,
  pickBoolean,
  pickNumber,
  pickString,
  pickTime,
  rupeesToMinor,
  unwrapEnvelope,
} from '../parse.js';
import type { UnknownRecord } from '../parse.js';

function stationFromCode(code: string | null, name: string | null, record: UnknownRecord | null): Station {
  return {
    code: code ?? '',
    name,
    zone: null, // RailCore does not publish zones → honest null
    state: record ? pickString(record, 'state') : null,
    latitude: record ? pickNumber(record, 'latitude', 'lat') : null,
    longitude: record ? pickNumber(record, 'longitude', 'lng') : null,
  };
}

/** data.results[]: {station_code, station_name, city, state, latitude, longitude, ...} */
export function normalizeRailCoreStations(body: unknown): Station[] | null {
  const data = unwrapEnvelope(body);
  const container = asRecord(data);
  if (!container) return null;
  const results = container.results;
  if (!Array.isArray(results)) return null;
  const stations: Station[] = [];
  for (const entry of results) {
    const record = asRecord(entry);
    if (!record) continue;
    const code = pickString(record, 'station_code', 'code');
    if (!code) continue; // a station without a code cannot be used — skip honestly
    stations.push({
      code,
      name: pickString(record, 'station_name', 'display_name', 'name'),
      zone: null,
      state: pickString(record, 'state'),
      latitude: pickNumber(record, 'latitude'),
      longitude: pickNumber(record, 'longitude'),
      city: pickString(record, 'city'),
      // Verified provider signals (used for smart single-station resolution).
      confidence: pickNumber(record, 'confidence'),
      isMajor: pickBoolean(record, 'is_major'),
    });
  }
  return stations;
}

function optionalStation(code: string | null, name: string | null, record: UnknownRecord | null = null): Station | null {
  if (!code) return null;
  return stationFromCode(code, name, record);
}

function trainFromRecord(record: UnknownRecord): Train | null {
  const number = pickString(record, 'train_number', 'number');
  if (!number) return null;
  return {
    number,
    name: pickString(record, 'train_name', 'display_name', 'name'),
    originStation: optionalStation(
      pickString(record, 'source_station_code', 'origin_station_code'),
      pickString(record, 'source_station_name', 'origin_station_name'),
    ),
    destinationStation: optionalStation(
      pickString(record, 'destination_station_code', 'to_station_code'),
      pickString(record, 'destination_station_name', 'to_station_name'),
    ),
    departureTime: pickTime(record, 'departure_time', 'departure'),
    arrivalTime: pickTime(record, 'arrival_time', 'arrival'),
    runsOn: normalizeWeekdays(record.running_days ?? record.runs_on),
    travelClasses: normalizeTravelClasses(record.classes),
    pantryCar: record.has_pantry === undefined ? null : typeof record.has_pantry === 'boolean' ? record.has_pantry : null,
  };
}

/** data: {from_station_code, to_station_code, journey_date, quota, trains[]} */
export function normalizeRailCoreTrainSearch(body: unknown): TrainSearchResult[] | null {
  const data = unwrapEnvelope(body);
  const container = asRecord(data);
  if (!container) return null;
  const trains = container.trains;
  if (!Array.isArray(trains)) return null;

  const fromStation = optionalStation(pickString(container, 'from_station_code'), pickString(container, 'from_station_name'));
  const toStation = optionalStation(pickString(container, 'to_station_code'), pickString(container, 'to_station_name'));

  const results: TrainSearchResult[] = [];
  for (const entry of trains) {
    const record = asRecord(entry);
    if (!record) continue;
    const train = trainFromRecord(record);
    if (!train) continue;
    const origin = train.originStation ?? optionalStation(pickString(record, 'from_station_code'), pickString(record, 'from_station_name'));
    const dest = train.destinationStation ?? optionalStation(pickString(record, 'to_station_code'), pickString(record, 'to_station_name'));
    results.push({
      train: { ...train, originStation: origin, destinationStation: dest },
      fromStation,
      toStation,
      departureTime: pickTime(record, 'departure_time', 'departure'),
      arrivalTime: pickTime(record, 'arrival_time', 'arrival'),
      durationMinutes: pickNumber(record, 'duration_minutes', 'duration'),
    });
  }
  return results;
}

/** data: {train_number, train_name, source_station_code, destination_station_code, running_days, ...} */
export function normalizeRailCoreTrainInfo(body: unknown): Train | null {
  const data = unwrapEnvelope(body);
  const record = asRecord(data);
  if (!record) return null;
  return trainFromRecord(record);
}

/** data: {train_number, train_name, stops[]} */
export function normalizeRailCoreTimetable(body: unknown): Timetable | null {
  const data = unwrapEnvelope(body);
  const record = asRecord(data);
  if (!record) return null;
  const number = pickString(record, 'train_number');
  if (!number) return null;
  const stopsArray = record.stops;
  if (!Array.isArray(stopsArray)) return null;

  const stops: TrainStop[] = [];
  for (const entry of stopsArray) {
    const stop = asRecord(entry);
    if (!stop) continue;
    const stationCode = pickString(stop, 'station_code', 'code');
    if (!stationCode) continue;
    stops.push({
      stationCode,
      stationName: pickString(stop, 'station_name', 'name'),
      arrivalTime: pickTime(stop, 'arrival_time', 'arrival'),
      departureTime: pickTime(stop, 'departure_time', 'departure'),
      dayCount: pickNumber(stop, 'day'),
      distanceKm: pickNumber(stop, 'distance_km', 'distance'),
      haltMinutes: pickNumber(stop, 'halt_minutes', 'halt'),
    });
  }
  return { trainNumber: number, trainName: pickString(record, 'train_name'), stops };
}

const LIVE_STATUS_MAP: Readonly<Record<string, LiveRunStatus>> = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  AT_STATION: 'AT_STATION',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DIVERTED: 'DIVERTED',
  UNKNOWN: 'UNKNOWN',
};

/** data: {status, current_station_code, delay_minutes, last_reported_at, ...} */
export function normalizeRailCoreLiveStatus(body: unknown, trainNumber: string): LiveStatus | null {
  const data = unwrapEnvelope(body);
  const record = asRecord(data);
  if (!record) return null;
  const rawStatus = asString(record.status)?.toUpperCase() ?? 'UNKNOWN';
  const status = LIVE_STATUS_MAP[rawStatus] ?? 'UNKNOWN';
  const currentStationCode = pickString(record, 'current_station_code');
  return {
    trainNumber: pickString(record, 'train_number') ?? trainNumber,
    journeyDate: pickString(record, 'journey_date'),
    status,
    delayMinutes: pickNumber(record, 'delay_minutes', 'delay'),
    currentStation: currentStationCode ? stationFromCode(currentStationCode, null, null) : null,
    nextStationCode: pickString(record, 'next_station_code'),
    lastUpdatedAt: pickString(record, 'last_reported_at'),
    upcomingStops: null, // RailCore live returns next-stop context, not a stop list — stay honest.
  };
}

const AVAILABILITY_STATUS_MAP: Readonly<Record<string, AvailabilityStatus>> = {
  AVAILABLE: 'AVAILABLE',
  RAC: 'RAC',
  WAITLIST: 'WAITLIST',
  REGRET: 'REGRET',
  NOT_AVAILABLE: 'UNAVAILABLE',
  TRAIN_CANCELLED: 'UNAVAILABLE',
  TRAIN_DEPARTED: 'UNAVAILABLE',
  UNKNOWN: 'UNAVAILABLE',
};

/** data: {journey_date, quota, classes[]: {class_code, status, available_count, waitlist_count, rac_count}} */
export function normalizeRailCoreAvailability(
  body: unknown,
  query: { trainNumber: string; journeyDate: string; travelClass: TravelClassCode; quota: QuotaCode },
): Availability | null {
  const data = unwrapEnvelope(body);
  const record = asRecord(data);
  if (!record) return null;
  const classesArray = record.classes;
  if (!Array.isArray(classesArray)) return null;

  let entry: UnknownRecord | null = null;
  for (const candidate of classesArray) {
    const classRecord = asRecord(candidate);
    if (classRecord && asString(classRecord.class_code)?.toUpperCase() === query.travelClass.toUpperCase()) {
      entry = classRecord;
      break;
    }
  }

  if (!entry) {
    // Train data returned, but no entry for the requested class — honest UNAVAILABLE with no counts.
    return {
      trainNumber: query.trainNumber,
      journeyDate: query.journeyDate,
      travelClass: query.travelClass,
      quota: query.quota,
      status: 'UNAVAILABLE',
      availableCount: null,
      racCount: null,
      waitlistNumber: null,
      asOf: null,
    };
  }

  const rawStatus = asString(entry.status)?.toUpperCase() ?? 'UNKNOWN';
  return {
    trainNumber: query.trainNumber,
    journeyDate: query.journeyDate,
    travelClass: query.travelClass,
    quota: query.quota,
    status: AVAILABILITY_STATUS_MAP[rawStatus] ?? 'UNAVAILABLE',
    availableCount: pickNumber(entry, 'available_count', 'available'),
    racCount: pickNumber(entry, 'rac_count'),
    waitlistNumber: pickNumber(entry, 'waitlist_count', 'waitlist_number'),
    asOf: null, // per-class update time not documented on the class entry; freshness lives in meta
  };
}

/** data: {fares[]: {class_code, fare (INR), currency}} — fare has no date parameter (verified). */
export function normalizeRailCoreFare(
  body: unknown,
  query: { trainNumber: string; fromStationCode: string; toStationCode: string; travelClass: TravelClassCode | null; quota: QuotaCode },
): Fare | null {
  const data = unwrapEnvelope(body);
  const record = asRecord(data);
  if (!record) return null;
  const faresArray = record.fares;
  if (!Array.isArray(faresArray)) return null;

  let entry: UnknownRecord | null = null;
  for (const candidate of faresArray) {
    const fareRecord = asRecord(candidate);
    if (!fareRecord) continue;
    const classCode = asString(fareRecord.class_code)?.toUpperCase() ?? null;
    if (query.travelClass ? classCode === query.travelClass.toUpperCase() : true) {
      entry = fareRecord;
      break;
    }
  }
  if (!entry) return null;

  const classCode = (asString(entry.class_code)?.toUpperCase() ?? query.travelClass) as TravelClassCode;
  const totalMinor = rupeesToMinor(entry.fare ?? entry.total_fare);
  if (totalMinor === null) return null; // unusable fare payload

  const breakdown: FareBreakdown = {
    baseFareMinor: null, // RailCore estimate exposes class totals only — components stay honest nulls
    reservationChargeMinor: null,
    superfastChargeMinor: null,
    dynamicFareMinor: null,
    cateringChargeMinor: null,
    gstMinor: null,
    totalMinor,
  };

  return {
    trainNumber: query.trainNumber,
    fromStationCode: query.fromStationCode,
    toStationCode: query.toStationCode,
    journeyDate: null, // RailCore fare estimate is date-independent (verified docs)
    travelClass: classCode,
    quota: query.quota,
    currency: 'INR',
    breakdown,
    source: 'RAILCORE',
    retrievedAt: pickString(record, 'retrieved_at') ?? new Date().toISOString(),
  };
}

export function normalizeRailCoreQuota(value: unknown, fallback: QuotaCode = 'GN'): QuotaCode {
  const text = asString(value)?.toUpperCase();
  return text && (QUOTAS as readonly string[]).includes(text) ? (text as QuotaCode) : fallback;
}

export function normalizeRailCoreTravelClass(value: unknown): TravelClassCode | null {
  const text = asString(value)?.toUpperCase();
  return text && (TRAVEL_CLASSES as readonly string[]).includes(text) ? (text as TravelClassCode) : null;
}

export function retrievedAtFromMeta(body: unknown): string {
  const envelope = asRecord(body);
  const meta = envelope ? asRecord(envelope.meta) : null;
  const freshness = meta ? asRecord(meta.freshness) : null;
  return (freshness && pickString(freshness, 'retrieved_at')) ?? new Date().toISOString();
}

export type { WeekdayCode };
