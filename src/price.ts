import { CliError } from "./errors.js";

export type PriceView = "json" | "raw" | "csv";

export interface PriceRequest {
  symbol: string;
  /** Oldest requested session, using normal CLI range semantics. */
  from: string;
  /** Newest requested session, using normal CLI range semantics. */
  to: string;
  /** Stockbit uses zero for an unbounded response. */
  limit: number;
  view?: PriceView;
}

export interface NormalizedPriceBar {
  date: string;
  unix_timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
}

export interface NormalizedPriceData {
  message: string | null;
  symbol: string;
  interval: "daily";
  requested_range: {
    from: string;
    to: string;
  };
  returned_range: {
    from: string | null;
    to: string | null;
  };
  count: number;
  empty: boolean;
  bars: NormalizedPriceBar[];
}

export interface PriceMeta {
  source: "stockbit";
  endpoint: "chartbit/:symbol/price/daily";
  symbol: string;
  interval: "daily";
  from: string;
  to: string;
  /** Stockbit's endpoint names the newer boundary `from`. */
  upstream_from: string;
  /** Stockbit's endpoint names the older boundary `to`. */
  upstream_to: string;
  limit: number;
  fetched_at: string;
}

interface RawPriceResponse {
  schema_version: "1";
  view: "raw";
  data: unknown;
  meta: PriceMeta;
}

interface StructuredPriceResponse<View extends "json" | "csv"> {
  schema_version: "1";
  view: View;
  data: NormalizedPriceData;
  meta: PriceMeta & {
    parser: {
      name: "stockbit-daily-price";
      version: "1";
      warnings: string[];
    };
  };
}

export type PriceResponse =
  | RawPriceResponse
  | StructuredPriceResponse<"json">
  | StructuredPriceResponse<"csv">;

export interface PriceParseResult {
  data: NormalizedPriceData;
  warnings: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function decimalString(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function unixTimestamp(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Match Stockbit's Chartbit adapter: unixdate is shifted from UTC to the Jakarta session date. */
function sessionDate(timestamp: number): string | null {
  const date = new Date((timestamp + 7 * 60 * 60) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function parsePriceDate(value: string, optionName: "from" | "to"): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new CliError(
      "INVALID_DATE",
      `The --${optionName} date must use YYYY-MM-DD.`,
      2,
    );
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new CliError("INVALID_DATE", `The --${optionName} date is not valid.`, 2);
  }
  return normalized;
}

export function validatePriceDateRange(from: string, to: string): void {
  if (from > to) {
    throw new CliError(
      "INVALID_DATE_RANGE",
      "The --from date must be earlier than or equal to --to.",
      2,
    );
  }
}

export function parsePriceLimit(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new CliError(
      "INVALID_OPTION",
      "Limit must be a non-negative integer; use 0 for all returned rows.",
      2,
    );
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new CliError(
      "INVALID_OPTION",
      "Limit must be a non-negative integer; use 0 for all returned rows.",
      2,
    );
  }
  return limit;
}

function requiredDecimal(
  row: UnknownRecord,
  field: "open" | "high" | "low" | "close",
  index: number,
): string {
  const value = decimalString(row[field]);
  if (value === null) {
    throw new CliError(
      "PRICE_INVALID",
      `Stockbit price row ${index + 1} has no valid ${field} value.`,
      4,
    );
  }
  return value;
}

export function parsePriceResponse(
  response: unknown,
  request: PriceRequest,
): PriceParseResult {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new CliError(
      "PRICE_INVALID",
      "The Stockbit response does not contain daily price data.",
      4,
    );
  }
  if (!Array.isArray(response.data.chartbit)) {
    throw new CliError(
      "PRICE_INVALID",
      "The Stockbit response does not contain data.chartbit.",
      4,
    );
  }

  const warnings: string[] = [];
  const bars = response.data.chartbit.map((value, index): NormalizedPriceBar => {
    if (!isRecord(value)) {
      throw new CliError(
        "PRICE_INVALID",
        `Stockbit price row ${index + 1} is not an object.`,
        4,
      );
    }
    const timestamp = unixTimestamp(value.unixdate);
    const date = timestamp === null ? null : sessionDate(timestamp);
    if (timestamp === null || date === null) {
      throw new CliError(
        "PRICE_INVALID",
        `Stockbit price row ${index + 1} has no valid unixdate.`,
        4,
      );
    }

    const open = requiredDecimal(value, "open", index);
    const high = requiredDecimal(value, "high", index);
    const low = requiredDecimal(value, "low", index);
    const close = requiredDecimal(value, "close", index);
    const volume = decimalString(value.volume);
    if (volume === null) {
      warnings.push(`Price row ${index + 1} (${date}) has no valid volume.`);
    }

    const numericOpen = Number(open);
    const numericHigh = Number(high);
    const numericLow = Number(low);
    const numericClose = Number(close);
    if (
      numericLow > numericHigh ||
      numericOpen < numericLow ||
      numericOpen > numericHigh ||
      numericClose < numericLow ||
      numericClose > numericHigh
    ) {
      warnings.push(`Price row ${index + 1} (${date}) has inconsistent OHLC bounds.`);
    }

    return {
      date,
      unix_timestamp: timestamp,
      open,
      high,
      low,
      close,
      volume,
    };
  });

  bars.sort((left, right) => left.unix_timestamp - right.unix_timestamp);
  const duplicateDates = bars.filter(
    (bar, index) => index > 0 && bars[index - 1]?.date === bar.date,
  );
  if (duplicateDates.length > 0) {
    warnings.push(`Stockbit returned ${duplicateDates.length} duplicate session date(s).`);
  }
  const outsideRange = bars.filter(
    (bar) => bar.date < request.from || bar.date > request.to,
  );
  if (outsideRange.length > 0) {
    warnings.push(
      `Stockbit returned ${outsideRange.length} bar(s) outside the requested range.`,
    );
  }

  return {
    data: {
      message: stringValue(response.message),
      symbol: request.symbol,
      interval: "daily",
      requested_range: {
        from: request.from,
        to: request.to,
      },
      returned_range: {
        from: bars[0]?.date ?? null,
        to: bars[bars.length - 1]?.date ?? null,
      },
      count: bars.length,
      empty: bars.length === 0,
      bars,
    },
    warnings,
  };
}

export const PRICE_CSV_COLUMNS = [
  "schema_version",
  "source",
  "symbol",
  "interval",
  "requested_from",
  "requested_to",
  "returned_from",
  "returned_to",
  "limit",
  "count",
  "empty",
  "date",
  "unix_timestamp",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "parser_warnings",
  "fetched_at",
] as const;

type PriceCsvColumn = (typeof PRICE_CSV_COLUMNS)[number];
type CsvValue = string | number | boolean | null | undefined;
type PriceCsvRecord = Record<PriceCsvColumn, CsvValue>;
type CsvPriceResponse = Extract<PriceResponse, { view: "csv" }>;

function encodeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializePriceCsv(response: CsvPriceResponse): string {
  const lines = [PRICE_CSV_COLUMNS.join(",")];
  const shared = {
    schema_version: response.schema_version,
    source: response.meta.source,
    symbol: response.data.symbol,
    interval: response.data.interval,
    requested_from: response.data.requested_range.from,
    requested_to: response.data.requested_range.to,
    returned_from: response.data.returned_range.from,
    returned_to: response.data.returned_range.to,
    limit: response.meta.limit,
    count: response.data.count,
    empty: response.data.empty,
    parser_warnings: response.meta.parser.warnings.join(" | "),
    fetched_at: response.meta.fetched_at,
  };
  const rows: Array<NormalizedPriceBar | undefined> =
    response.data.bars.length > 0 ? response.data.bars : [undefined];

  for (const bar of rows) {
    const record: PriceCsvRecord = {
      ...shared,
      date: bar?.date,
      unix_timestamp: bar?.unix_timestamp,
      open: bar?.open,
      high: bar?.high,
      low: bar?.low,
      close: bar?.close,
      volume: bar?.volume,
    };
    lines.push(PRICE_CSV_COLUMNS.map((column) => encodeCsvCell(record[column])).join(","));
  }
  return lines.join("\r\n");
}
