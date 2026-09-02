/**
 * Official RailKit SDK binding (npm package `railkit`, v4.1.0).
 *
 * The SDK surface below is taken verbatim from the package's published
 * index.d.ts. Transport, base URL and anti-replay signing are handled inside
 * the SDK itself — we only inject RAILKIT_API_KEY (server-side only).
 *
 * Tests inject a fake RailKitSdkLike, so no network is ever touched in CI.
 * Dates: the SDK uses DD-MM-YYYY strings (documented).
 */

export interface RailKitSdkLike {
  checkPNRStatus(pnr: string): Promise<unknown>;
  getTrainInfo(trainNumber: string): Promise<unknown>;
  trackTrain(trainNumber: string, date?: string): Promise<unknown>;
  searchTrainBetweenStations(fromStnCode: string, toStnCode: string, date?: string): Promise<unknown>;
  getAvailability(trainNo: string, fromStnCode: string, toStnCode: string, date: string, coach: string, quota: string): Promise<unknown>;
  fareLookup(trainNo: string, fromStnCode: string, toStnCode: string, date: string, travelClass: string, quota: string): Promise<unknown>;
  cancelList(): Promise<unknown>;
}

export type RailKitSdkLoader = () => Promise<RailKitSdkLike>;

/** Loads the real SDK once, configures it with the key, and memoizes. */
export function createOfficialRailKitSdkLoader(apiKey: string): RailKitSdkLoader {
  let cached: Promise<RailKitSdkLike> | null = null;
  return () => {
    cached ??= (async () => {
      const railkit = await import('railkit');
      railkit.configure(apiKey);
      return railkit as unknown as RailKitSdkLike;
    })();
    return cached;
  };
}

/** Shared contracts use ISO dates; the RailKit SDK expects DD-MM-YYYY. */
export function isoToDdMmYyyy(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split('-');
  return `${day}-${month}-${year}`;
}
