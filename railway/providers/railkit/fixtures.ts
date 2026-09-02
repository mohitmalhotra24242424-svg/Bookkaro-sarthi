/**
 * ⚠️ MOCK FIXTURES — NOT LIVE RAILWAY DATA ⚠️
 *
 * These payloads mirror the response shapes documented publicly by RailKit
 * (railkit.rajivdubey.dev/docs + published SDK typings, captured 2026-08-26).
 * They define the expected SDK result contract for offline tests. Live data
 * only ever comes from the real SDK via RAILKIT_API_KEY.
 */

export const RAILKIT_TRAIN_SEARCH_FIXTURE = {
  success: true,
  data: [
    {
      train_no: '12656',
      train_name: 'Navjeevan SF Express',
      from_station_code: 'NDLS',
      from_station_name: 'New Delhi',
      to_station_code: 'BCT',
      to_station_name: 'Mumbai Central',
      departure: '06:40',
      arrival: '22:15',
      duration: 935,
    },
    {
      train_no: '12952',
      train_name: 'Mumbai Rajdhani',
      from: 'NDLS',
      to: 'BCT',
      dep: '16:25',
      arr: '08:15',
      durationMin: 950,
    },
  ],
};

export const RAILKIT_TRAIN_INFO_FIXTURE = {
  success: true,
  data: {
    trainInfo: {
      train_no: '12656',
      train_name: 'Navjeevan SF Express',
      from_station_code: 'MAS',
      from_station_name: 'MGR Chennai Central',
      to_station_code: 'ADI',
      to_station_name: 'Ahmedabad Jn',
      start_time: '10:10',
      end_time: '17:15',
    },
    route: [
      { station_code: 'MAS', station_name: 'MGR Chennai Central', arrival: null, departure: '10:10', day: 1, distance: 0, halt: null },
      { station_code: 'BSL', station_name: 'Bhusaval Jn', arrival: '01:35', departure: '01:45', day: 2, distance: 1266, halt: 10 },
      { station_code: 'ADI', station_name: 'Ahmedabad Jn', arrival: '17:15', departure: null, day: 2, distance: 1880, halt: null },
    ],
  },
};

export const RAILKIT_LIVE_STATUS_FIXTURE = {
  success: true,
  data: {
    train_no: '12656',
    journey_date: '27-08-2026',
    delay: 18,
    statusNote: 'Train is running 18 minutes late',
    last_updated: '2026-08-27T08:41:00Z',
    currentStation: { station_code: 'BSL', station_name: 'Bhusaval Jn' },
    timeline: [
      { station_code: 'BAU', station_name: 'Burnpur', arrival: '06:12', departure: '06:14', delay: 15 },
      { station_code: 'BSL', station_name: 'Bhusaval Jn', arrival: '08:35', departure: '08:45', delay: 18 },
      { station_code: 'JL', station_name: 'Jalgaon Jn', arrival: { scheduled: '09:02', actual: '09:20' }, departure: '09:22', delay: 18 },
    ],
  },
};

export const RAILKIT_AVAILABILITY_FIXTURE = {
  success: true,
  data: {
    trainNo: '12656',
    status: 'AVAILABLE',
    availability_text: 'AVAILABLE-0032',
    available: 32,
    rac: null,
    waitlist: null,
    last_updated: '2026-08-26T10:00:00Z',
    fare: 1125,
  },
};

export const RAILKIT_AVAILABILITY_WAITLIST_FIXTURE = {
  success: true,
  data: {
    trainNo: '12656',
    availability: 'GNWL14/WL8',
    waitingListCount: 8,
    last_updated: '2026-08-26T10:00:00Z',
  },
};

export const RAILKIT_FARE_FIXTURE = {
  success: true,
  data: {
    trainNo: '12313',
    trainName: 'Sealdah Rajdhani',
    from: 'ASN',
    to: 'NDLS',
    distance: 1371,
    baseFare: 2845,
    reservation: 60,
    superfast: 75,
    catering: 245,
    gst: 141,
    dynamicFare: 507,
    totalFare: 3873,
  },
};

export const RAILKIT_PNR_FIXTURE = {
  success: true,
  data: {
    pnr: '4123456789',
    status: 'CNF',
    train: { number: '12313', name: 'Sealdah Rajdhani', class: '3A' },
    journey: {
      source: { name: 'Asansol Jn', code: 'ASN', platform: '2' },
      destination: { name: 'New Delhi', code: 'NDLS', platform: '7' },
      departure: '26/08/26 7:15 PM',
      arrival: '27/08/26 9:55 AM',
      duration: '14h 40m',
    },
    chart: { status: 'Prepared', message: 'Chart prepared' },
    passengers: [
      { name: 'PASSENGER ONE', status: 'CNF', seat: 'B2-34', berthType: 'SL', confirmationProbability: 99 },
      { name: 'PASSENGER TWO', bookingStatus: 'W/L 6,RLGN', current: { details: 'CNF B2-38' } },
    ],
    lastUpdated: '2026-08-26T12:00:00Z',
  },
};

export const RAILKIT_CANCELLED_FIXTURE = {
  success: true,
  summary: { total: 2, fullyCancelled: 1, partiallyCancelled: 1 },
  data: {
    fullyCancelledTrains: [{ trainNo: '15098', trainName: 'Amritsar Ltt Express' }],
    partiallyCancelledTrains: [
      { trainNo: '19038', trainName: 'Bandra Gorakhpur Exp', cancelledSegment: { from: { name: 'ST' }, to: { name: 'BSL' } } },
    ],
  },
};

export const RAILKIT_SUCCESS_FALSE_FIXTURE = {
  success: false,
  message: 'Upstream IRCTC source unavailable, try again later.',
};

export const RAILKIT_EMPTY_SEARCH_FIXTURE = {
  success: true,
  data: [],
};
