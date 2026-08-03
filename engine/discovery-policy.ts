export interface RecurringDiscoveryPageInput {
  readonly scanOrdinal: number;
  readonly pageCount: number;
}

export interface MeteoraDiscoveryPageUrlInput {
  readonly baseUrl: string;
  readonly page: number;
  readonly pageSize: number;
}

/** Selects the deterministic discovery page for a recurring scan ordinal. */
export function selectRecurringDiscoveryPage(input: RecurringDiscoveryPageInput): number | null {
  if (
    !Number.isSafeInteger(input.scanOrdinal) ||
    input.scanOrdinal < 0 ||
    !Number.isSafeInteger(input.pageCount) ||
    input.pageCount < 1
  ) {
    return null;
  }
  return (input.scanOrdinal % input.pageCount) + 1;
}

/** Builds and validates a recurring Meteora discovery URL for the selected page. */
export function buildMeteoraDiscoveryPageUrl(input: MeteoraDiscoveryPageUrlInput): string | null {
  if (
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1
  ) {
    return null;
  }
  try {
    const url = new URL(input.baseUrl);
    url.searchParams.set("page", String(input.page));
    url.searchParams.set("page_size", String(input.pageSize));
    return url.toString();
  } catch {
    return null;
  }
}
