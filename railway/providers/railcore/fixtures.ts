/**
 * ⚠️ MOCK FIXTURES — NOT LIVE RAILWAY DATA ⚠️
 *
 * These payloads mirror the EXAMPLE RESPONSES published in the official
 * RailCore docs (railcore.tech/docs, captured 2026-08-26). They define the
 * expected response contract for offline tests. Never present these as live
 * data; live data only ever comes from the real provider via RAILCORE_API_KEY.
 */

export const RAILCORE_STATION_SEARCH_FIXTURE = {
  success: true,
  data: {
    query: 'bhusaval',
    limit: 5,
    results: [
      {
        station_code: 'BSL',
        station_name: 'Bhusaval Jn',
        display_name: 'Bhusaval Jn',
        city: 'Bhusawal',
        state: 'Maharashtra',
        country: 'IN',
        latitude: 21.048194,
        longitude: 75.784169,
        aliases: ['Bhusawal'],
        is_major: true,
        confidence: 1.0,
      },
      {
        station_code: 'LDH',
        station_name: 'Ludhiana Jn',
        display_name: 'Ludhiana Jn',
        city: 'Ludhiana',
        state: 'Punjab',
        country: 'IN',
        latitude: null,
        longitude: null,
        aliases: [],
        is_major: true,
        confidence: 0.62,
      },
    ],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0001',
    trace_id: 'trc_fixture_0001',
    timestamp: '2026-08-26T10:00:00.000Z',
    freshness: { mode: 'live', retrieved_at: '2026-08-26T10:00:00.000Z', sources: [{ confidence: 'high' }] },
  },
};

export const RAILCORE_TRAIN_SEARCH_FIXTURE = {
  success: true,
  data: {
    from_station_code: 'BSL',
    to_station_code: 'ADI',
    journey_date: '2026-08-27',
    quota: 'GN',
    trains: [
      {
        train_number: '12656',
        train_name: 'Navjeevan SF Express',
        departure_time: '10:25',
        arrival_time: '18:00',
        duration_minutes: 455,
        distance_km: 614,
        train_type: 'SUPERFAST',
        classes: ['SL', '3A', '2A', '1A'],
        running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
        has_pantry: true,
        on_time_rating: 3.4,
      },
      {
        train_number: '12834',
        train_name: 'Howrah Ahmedabad Express',
        departure_time: '23:55',
        arrival_time: '09:40',
        duration_minutes: 585,
        distance_km: null,
        train_type: 'MAIL',
        classes: ['SL', '3A', '2A'],
        running_days: null,
        has_pantry: null,
        on_time_rating: null,
      },
    ],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0002',
    trace_id: 'trc_fixture_0002',
    timestamp: '2026-08-26T10:00:01.000Z',
    freshness: { mode: 'live', retrieved_at: '2026-08-26T10:00:01.000Z', sources: [{ confidence: 'high' }] },
  },
};

export const RAILCORE_TRAIN_INFO_FIXTURE = {
  success: true,
  data: {
    train_number: '12656',
    train_name: 'Navjeevan SF Express',
    display_name: '12656 - Navjeevan SF Express',
    source_station_code: 'MAS',
    destination_station_code: 'ADI',
    train_type: 'SUPERFAST',
    running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0003',
    trace_id: 'trc_fixture_0003',
    timestamp: '2026-08-26T10:00:02.000Z',
    freshness: { mode: 'static', retrieved_at: '2026-08-26T10:00:02.000Z', sources: [{ confidence: 'high' }] },
  },
};

export const RAILCORE_TIMETABLE_FIXTURE = {
  success: true,
  data: {
    train_number: '12656',
    train_name: 'Navjeevan SF Express',
    source_station_code: 'MAS',
    destination_station_code: 'ADI',
    running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    classes: ['SL', '3A', '2A', '1A'],
    total_duration_minutes: 1865,
    distance_km: 1880,
    stops: [
      {
        sequence: 1,
        station_code: 'MAS',
        station_name: 'MGR Chennai Central',
        arrival_time: null,
        departure_time: '10:10',
        halt_minutes: null,
        day: 1,
        distance_km: 0,
        platform_number: null,
        is_stop: true,
      },
      {
        sequence: 2,
        station_code: 'BSL',
        station_name: 'Bhusaval Jn',
        arrival_time: '01:35',
        departure_time: '01:45',
        halt_minutes: 10,
        day: 2,
        distance_km: 1266,
        platform_number: '4',
        is_stop: true,
      },
    ],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0004',
    trace_id: 'trc_fixture_0004',
    timestamp: '2026-08-26T10:00:03.000Z',
    freshness: { mode: 'static', retrieved_at: '2026-08-26T10:00:03.000Z', sources: [{ confidence: 'high' }] },
  },
};

export const RAILCORE_LIVE_STATUS_FIXTURE = {
  success: true,
  data: {
    train_number: '12656',
    journey_date: '2026-08-27',
    status: 'RUNNING',
    current_station_code: 'BSL',
    next_station_code: 'JL',
    previous_station_code: 'BAU',
    delay_minutes: 12,
    status_text: 'Running 12 minutes late',
    progress_percent: 67.3,
    last_reported_at: '2026-08-27T08:41:00.000Z',
    confidence: 'high',
    eta_destination_at: '18:12',
    next_stop: { station_code: 'JL', station_name: 'Jalgaon Jn', eta: '09:02', etd: '09:04', delay_minutes: 12 },
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0005',
    trace_id: 'trc_fixture_0005',
    timestamp: '2026-08-27T08:45:00.000Z',
    freshness: { mode: 'live', retrieved_at: '2026-08-27T08:45:00.000Z', sources: [{ confidence: 'high' }] },
  },
};

export const RAILCORE_AVAILABILITY_FIXTURE = {
  success: true,
  data: {
    train_number: '12656',
    from_station_code: 'BSL',
    to_station_code: 'ADI',
    journey_date: '2026-08-27',
    quota: 'GN',
    classes: [
      {
        class_code: '3A',
        status: 'AVAILABLE',
        availability_text: 'AVAILABLE-0032',
        available_count: 32,
        waitlist_count: null,
        rac_count: null,
        wl_pool: 'GNWL',
        fare: 1125,
        total_fare: 1125,
      },
      {
        class_code: 'SL',
        status: 'WAITLIST',
        availability_text: 'GNWL 14/WL 8',
        available_count: null,
        waitlist_count: 8,
        rac_count: null,
        wl_pool: 'GNWL',
        fare: null,
        total_fare: null,
      },
    ],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0006',
    trace_id: 'trc_fixture_0006',
    timestamp: '2026-08-26T10:00:05.000Z',
    freshness: { mode: 'live', retrieved_at: '2026-08-26T10:00:05.000Z', sources: [{ confidence: 'medium' }] },
  },
};

export const RAILCORE_FARE_FIXTURE = {
  success: true,
  data: {
    train_number: '12656',
    from_station_code: 'BSL',
    to_station_code: 'ADI',
    quota: 'GN',
    fares: [
      { class_code: '3A', fare: 1125, currency: 'INR' },
      { class_code: '2A', fare: 1615, currency: 'INR' },
    ],
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0007',
    trace_id: 'trc_fixture_0007',
    timestamp: '2026-08-26T10:00:06.000Z',
    freshness: { mode: 'live', retrieved_at: '2026-08-26T10:00:06.000Z', sources: [{ confidence: 'high' }] },
  },
};

/** Documented legitimate zero-result answer: 404 NO_TRAINS_FOUND. */
export const RAILCORE_NO_TRAINS_FIXTURE = {
  success: false,
  error: {
    code: 'NO_TRAINS_FOUND',
    message: 'No train matches the route and date.',
    category: 'NOT_FOUND',
    retryable: false,
  },
  meta: {
    api_version: 'v1',
    request_id: 'req_fixture_0008',
    trace_id: 'trc_fixture_0008',
    timestamp: '2026-08-26T10:00:07.000Z',
  },
};

/** Documented validation rejection (400 VALIDATION_ERROR). */
export const RAILCORE_VALIDATION_FIXTURE = {
  success: false,
  error: {
    code: 'VALIDATION_ERROR',
    message: 'A required field is missing or invalid.',
    category: 'INVALID_INPUT',
    retryable: false,
  },
  meta: { api_version: 'v1', request_id: 'req_fixture_0009', trace_id: 'trc_fixture_0009', timestamp: '2026-08-26T10:00:08.000Z' },
};

/** Unusable payload case: 200 with success:false (fallback-eligible). */
export const RAILCORE_SUCCESS_FALSE_FIXTURE = {
  success: false,
  error: {
    code: 'UPSTREAM_UNAVAILABLE',
    message: 'Upstream provider did not respond in time.',
    category: 'PROVIDER',
    retryable: true,
  },
  meta: { api_version: 'v1', request_id: 'req_fixture_0010', trace_id: 'trc_fixture_0010', timestamp: '2026-08-26T10:00:09.000Z' },
};

/** Unusable payload case: non-JSON body. */
export const RAILCORE_HTML_GARBAGE_FIXTURE = '<html><body>502 Bad Gateway</body></html>';
