import { CliError } from "./errors.js";

export const BROKER_TRANSACTION_TYPES = {
  gross: "TRANSACTION_TYPE_GROSS",
  net: "TRANSACTION_TYPE_NET",
} as const;

export const BROKER_INVESTOR_TYPES = {
  domestic: "INVESTOR_TYPE_DOMESTIC",
  all: "INVESTOR_TYPE_ALL",
  foreign: "INVESTOR_TYPE_FOREIGN",
} as const;

export const BROKER_MARKET_BOARDS = {
  all: "MARKET_BOARD_ALL",
  regular: "MARKET_BOARD_REGULER",
  cash: "MARKET_BOARD_TUNAI",
  negotiated: "MARKET_BOARD_NEGO",
} as const;

export type BrokerTransactionType =
  (typeof BROKER_TRANSACTION_TYPES)[keyof typeof BROKER_TRANSACTION_TYPES];
export type BrokerInvestorType =
  (typeof BROKER_INVESTOR_TYPES)[keyof typeof BROKER_INVESTOR_TYPES];
export type BrokerMarketBoard =
  (typeof BROKER_MARKET_BOARDS)[keyof typeof BROKER_MARKET_BOARDS];
export type BrokerSummaryView = "json" | "raw" | "csv";

export interface BrokerSummaryRequest {
  symbol: string;
  from: string;
  to: string;
  transactionType: BrokerTransactionType;
  investorType: BrokerInvestorType;
  marketBoard: BrokerMarketBoard;
  limit: number;
  view?: BrokerSummaryView;
}

export interface NormalizedBrokerEntry {
  rank: number;
  side: "buy" | "sell";
  broker_code: string | null;
  date: string | null;
  symbol: string | null;
  average_price: string | null;
  lots: string | null;
  side_volume: string | null;
  value: string | null;
  side_value: string | null;
  frequency: string | null;
  investor_origin: "domestic" | "foreign" | null;
  investor_label: string | null;
  appears_on_both_sides: boolean;
}

export interface BrokerDetectorTier {
  classification: string | null;
  amount: number | null;
  percent: number | null;
  volume: number | null;
}

export interface NormalizedBrokerSummaryData {
  message: string | null;
  symbol: string;
  from: string;
  to: string;
  transaction_type: keyof typeof BROKER_TRANSACTION_TYPES;
  investor_type: keyof typeof BROKER_INVESTOR_TYPES;
  market_board: keyof typeof BROKER_MARKET_BOARDS;
  transaction_semantics: string;
  summary: {
    buy_broker_count: number;
    sell_broker_count: number;
    overlapping_broker_count: number;
    empty: boolean;
  };
  analytics: {
    average_price: number | null;
    accumulation_distribution: string | null;
    broker_count: number | null;
    total_buyers: number | null;
    total_sellers: number | null;
    value: number | null;
    volume: number | null;
    tiers: {
      average: BrokerDetectorTier;
      average_5: BrokerDetectorTier;
      top_1: BrokerDetectorTier;
      top_3: BrokerDetectorTier;
      top_5: BrokerDetectorTier;
      top_10: BrokerDetectorTier;
    };
  };
  brokers: {
    buy: NormalizedBrokerEntry[];
    sell: NormalizedBrokerEntry[];
  };
}

export interface BrokerSummaryMeta {
  source: "stockbit";
  endpoint: "marketdetectors/:symbol";
  symbol: string;
  from: string;
  to: string;
  transaction_type: BrokerTransactionType;
  transaction: keyof typeof BROKER_TRANSACTION_TYPES;
  investor_type: BrokerInvestorType;
  investor: keyof typeof BROKER_INVESTOR_TYPES;
  market_board: BrokerMarketBoard;
  board: keyof typeof BROKER_MARKET_BOARDS;
  limit: number;
  fetched_at: string;
}

interface RawBrokerSummaryResponse {
  schema_version: "1";
  view: "raw";
  data: unknown;
  meta: BrokerSummaryMeta;
}

interface StructuredBrokerSummaryResponse<View extends "json" | "csv"> {
  schema_version: "1";
  view: View;
  data: NormalizedBrokerSummaryData;
  meta: BrokerSummaryMeta & {
    parser: {
      name: "stockbit-broker-summary";
      version: "1";
      warnings: string[];
    };
  };
}

export type BrokerSummaryResponse =
  | RawBrokerSummaryResponse
  | StructuredBrokerSummaryResponse<"json">
  | StructuredBrokerSummaryResponse<"csv">;

export interface BrokerSummaryParseResult {
  data: NormalizedBrokerSummaryData;
  warnings: string[];
}

type UnknownRecord = Record<string, unknown>;

const TRANSACTION_ALIASES: Readonly<Record<string, BrokerTransactionType>> = {
  gross: BROKER_TRANSACTION_TYPES.gross,
  "transaction-type-gross": BROKER_TRANSACTION_TYPES.gross,
  net: BROKER_TRANSACTION_TYPES.net,
  "transaction-type-net": BROKER_TRANSACTION_TYPES.net,
};

const INVESTOR_ALIASES: Readonly<Record<string, BrokerInvestorType>> = {
  domestic: BROKER_INVESTOR_TYPES.domestic,
  local: BROKER_INVESTOR_TYPES.domestic,
  "investor-type-domestic": BROKER_INVESTOR_TYPES.domestic,
  all: BROKER_INVESTOR_TYPES.all,
  "investor-type-all": BROKER_INVESTOR_TYPES.all,
  foreign: BROKER_INVESTOR_TYPES.foreign,
  asing: BROKER_INVESTOR_TYPES.foreign,
  "investor-type-foreign": BROKER_INVESTOR_TYPES.foreign,
};

const BOARD_ALIASES: Readonly<Record<string, BrokerMarketBoard>> = {
  all: BROKER_MARKET_BOARDS.all,
  "market-board-all": BROKER_MARKET_BOARDS.all,
  regular: BROKER_MARKET_BOARDS.regular,
  reguler: BROKER_MARKET_BOARDS.regular,
  "market-board-regular": BROKER_MARKET_BOARDS.regular,
  "market-board-reguler": BROKER_MARKET_BOARDS.regular,
  cash: BROKER_MARKET_BOARDS.cash,
  tunai: BROKER_MARKET_BOARDS.cash,
  "market-board-cash": BROKER_MARKET_BOARDS.cash,
  "market-board-tunai": BROKER_MARKET_BOARDS.cash,
  negotiated: BROKER_MARKET_BOARDS.negotiated,
  negotiation: BROKER_MARKET_BOARDS.negotiated,
  nego: BROKER_MARKET_BOARDS.negotiated,
  "market-board-negotiated": BROKER_MARKET_BOARDS.negotiated,
  "market-board-nego": BROKER_MARKET_BOARDS.negotiated,
};

const TRANSACTION_NAMES = new Map<
  BrokerTransactionType,
  keyof typeof BROKER_TRANSACTION_TYPES
>(Object.entries(BROKER_TRANSACTION_TYPES).map(([name, value]) => [
  value,
  name as keyof typeof BROKER_TRANSACTION_TYPES,
]));

const INVESTOR_NAMES = new Map<
  BrokerInvestorType,
  keyof typeof BROKER_INVESTOR_TYPES
>(Object.entries(BROKER_INVESTOR_TYPES).map(([name, value]) => [
  value,
  name as keyof typeof BROKER_INVESTOR_TYPES,
]));

const BOARD_NAMES = new Map<BrokerMarketBoard, keyof typeof BROKER_MARKET_BOARDS>(
  Object.entries(BROKER_MARKET_BOARDS).map(([name, value]) => [
    value,
    name as keyof typeof BROKER_MARKET_BOARDS,
  ]),
);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedOption(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

function parseAlias<Value extends string>(
  value: string,
  aliases: Readonly<Record<string, Value>>,
  optionName: string,
  expected: string,
): Value {
  const parsed = aliases[normalizedOption(value)];
  if (parsed) {
    return parsed;
  }
  throw new CliError(
    "INVALID_OPTION",
    `Invalid ${optionName} \`${value}\`. Expected ${expected}.`,
    2,
  );
}

export function parseBrokerTransactionType(value: string): BrokerTransactionType {
  return parseAlias(value, TRANSACTION_ALIASES, "transaction type", "`gross` or `net`");
}

export function parseBrokerInvestorType(value: string): BrokerInvestorType {
  return parseAlias(
    value,
    INVESTOR_ALIASES,
    "investor type",
    "`all`, `domestic`, or `foreign`",
  );
}

export function parseBrokerMarketBoard(value: string): BrokerMarketBoard {
  return parseAlias(
    value,
    BOARD_ALIASES,
    "market board",
    "`all`, `regular`, `cash`, or `negotiated`",
  );
}

export function parseBrokerLimit(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new CliError("INVALID_OPTION", "Limit must be a positive integer.", 2);
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CliError("INVALID_OPTION", "Limit must be a positive integer.", 2);
  }
  return limit;
}

export function parseBrokerDate(value: string, optionName: "from" | "to"): string {
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

export function validateBrokerDateRange(from: string, to: string): void {
  if (from > to) {
    throw new CliError(
      "INVALID_DATE_RANGE",
      "The --from date must be earlier than or equal to --to.",
      2,
    );
  }
}

export function brokerTransactionName(
  value: BrokerTransactionType,
): keyof typeof BROKER_TRANSACTION_TYPES {
  const name = TRANSACTION_NAMES.get(value);
  if (!name) {
    throw new CliError("INVALID_OPTION", `Invalid transaction type \`${value}\`.`, 2);
  }
  return name;
}

export function brokerInvestorName(
  value: BrokerInvestorType,
): keyof typeof BROKER_INVESTOR_TYPES {
  const name = INVESTOR_NAMES.get(value);
  if (!name) {
    throw new CliError("INVALID_OPTION", `Invalid investor type \`${value}\`.`, 2);
  }
  return name;
}

export function brokerBoardName(
  value: BrokerMarketBoard,
): keyof typeof BROKER_MARKET_BOARDS {
  const name = BOARD_NAMES.get(value);
  if (!name) {
    throw new CliError("INVALID_OPTION", `Invalid market board \`${value}\`.`, 2);
  }
  return name;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function decimalString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedUpstreamDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (/^\d{8}$/u.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function investorOrigin(value: string | null): "domestic" | "foreign" | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "asing" || normalized === "foreign") {
    return "foreign";
  }
  if (normalized === "lokal" || normalized === "domestic") {
    return "domestic";
  }
  return null;
}

function tier(value: unknown): BrokerDetectorTier {
  const record = isRecord(value) ? value : {};
  return {
    classification: stringValue(record.accdist),
    amount: numberValue(record.amount),
    percent: numberValue(record.percent),
    volume: numberValue(record.vol),
  };
}

function brokerCodes(rows: unknown[]): Set<string> {
  return new Set(
    rows
      .map((row) => (isRecord(row) ? stringValue(row.netbs_broker_code) : null))
      .filter((value): value is string => value !== null),
  );
}

function parseBrokerRows(
  rows: unknown[],
  side: "buy" | "sell",
  overlap: ReadonlySet<string>,
  warnings: string[],
): NormalizedBrokerEntry[] {
  const parsed: NormalizedBrokerEntry[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      warnings.push(`Skipped ${side} broker row ${index + 1} because it is not an object.`);
      return;
    }
    const brokerCode = stringValue(row.netbs_broker_code);
    const investorLabel = stringValue(row.type);
    parsed.push({
      rank: index + 1,
      side,
      broker_code: brokerCode,
      date: normalizedUpstreamDate(row.netbs_date),
      symbol: stringValue(row.netbs_stock_code),
      average_price: decimalString(
        side === "buy" ? row.netbs_buy_avg_price : row.netbs_sell_avg_price,
      ),
      lots: decimalString(side === "buy" ? row.blot : row.slot),
      side_volume: decimalString(side === "buy" ? row.blotv : row.slotv),
      value: decimalString(side === "buy" ? row.bval : row.sval),
      side_value: decimalString(side === "buy" ? row.bvalv : row.svalv),
      frequency: decimalString(row.freq),
      investor_origin: investorOrigin(investorLabel),
      investor_label: investorLabel,
      appears_on_both_sides: brokerCode !== null && overlap.has(brokerCode),
    });
  });
  return parsed;
}

export function parseBrokerSummaryResponse(
  response: unknown,
  request: BrokerSummaryRequest,
): BrokerSummaryParseResult {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new CliError(
      "BROKER_SUMMARY_INVALID",
      "The Stockbit response does not contain broker-summary data.",
      4,
    );
  }
  const providerData = response.data;
  if (!isRecord(providerData.broker_summary)) {
    throw new CliError(
      "BROKER_SUMMARY_INVALID",
      "The Stockbit response does not contain data.broker_summary.",
      4,
    );
  }
  const summary = providerData.broker_summary;
  if (!Array.isArray(summary.brokers_buy) || !Array.isArray(summary.brokers_sell)) {
    throw new CliError(
      "BROKER_SUMMARY_INVALID",
      "The Stockbit broker summary does not contain buy and sell arrays.",
      4,
    );
  }

  const warnings: string[] = [];
  const buyCodes = brokerCodes(summary.brokers_buy);
  const sellCodes = brokerCodes(summary.brokers_sell);
  const overlap = new Set([...buyCodes].filter((code) => sellCodes.has(code)));
  const transactionName = brokerTransactionName(request.transactionType);
  if (transactionName === "net" && overlap.size > 0) {
    warnings.push(
      `Net response contains ${overlap.size} broker code(s) on both buy and sell sides.`,
    );
  }

  const detector = isRecord(providerData.bandar_detector)
    ? providerData.bandar_detector
    : {};
  const from = stringValue(providerData.from) ?? request.from;
  const to = stringValue(providerData.to) ?? request.to;
  const symbol = stringValue(summary.symbol) ?? request.symbol;
  if (from !== request.from || to !== request.to) {
    warnings.push(`Stockbit returned range ${from} to ${to} for ${request.from} to ${request.to}.`);
  }
  if (symbol.toUpperCase() !== request.symbol.toUpperCase()) {
    warnings.push(`Stockbit returned symbol ${symbol} for ${request.symbol}.`);
  }

  const buy = parseBrokerRows(summary.brokers_buy, "buy", overlap, warnings);
  const sell = parseBrokerRows(summary.brokers_sell, "sell", overlap, warnings);
  return {
    data: {
      message: stringValue(response.message),
      symbol,
      from,
      to,
      transaction_type: transactionName,
      investor_type: brokerInvestorName(request.investorType),
      market_board: brokerBoardName(request.marketBoard),
      transaction_semantics:
        transactionName === "gross"
          ? "Gross buy and sell activity are ranked independently; a broker may appear on both sides."
          : "Buy and sell entries represent each broker's net difference; sell lots and values may be negative, and a broker normally appears on only one side.",
      summary: {
        buy_broker_count: buy.length,
        sell_broker_count: sell.length,
        overlapping_broker_count: overlap.size,
        empty: buy.length === 0 && sell.length === 0,
      },
      analytics: {
        average_price: numberValue(detector.average),
        accumulation_distribution: stringValue(detector.broker_accdist),
        broker_count: numberValue(detector.number_broker_buysell),
        total_buyers: numberValue(detector.total_buyer),
        total_sellers: numberValue(detector.total_seller),
        value: numberValue(detector.value),
        volume: numberValue(detector.volume),
        tiers: {
          average: tier(detector.avg),
          average_5: tier(detector.avg5),
          top_1: tier(detector.top1),
          top_3: tier(detector.top3),
          top_5: tier(detector.top5),
          top_10: tier(detector.top10),
        },
      },
      brokers: { buy, sell },
    },
    warnings,
  };
}

export const BROKER_SUMMARY_CSV_COLUMNS = [
  "schema_version",
  "source",
  "symbol",
  "from",
  "to",
  "transaction",
  "transaction_type",
  "investor",
  "investor_type",
  "board",
  "market_board",
  "limit",
  "buy_broker_count",
  "sell_broker_count",
  "overlapping_broker_count",
  "empty",
  "average_price",
  "accumulation_distribution",
  "detector_broker_count",
  "total_buyers",
  "total_sellers",
  "detector_value",
  "detector_volume",
  "side",
  "rank",
  "broker_code",
  "date",
  "average_price_broker",
  "lots",
  "side_volume",
  "value",
  "side_value",
  "frequency",
  "investor_origin",
  "investor_label",
  "appears_on_both_sides",
  "parser_warnings",
  "fetched_at",
] as const;

type BrokerCsvColumn = (typeof BROKER_SUMMARY_CSV_COLUMNS)[number];
type CsvValue = string | number | boolean | null | undefined;
type BrokerCsvRecord = Record<BrokerCsvColumn, CsvValue>;
type CsvBrokerSummaryResponse = Extract<BrokerSummaryResponse, { view: "csv" }>;

function encodeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeBrokerSummaryCsv(response: CsvBrokerSummaryResponse): string {
  const lines = [BROKER_SUMMARY_CSV_COLUMNS.join(",")];
  const shared = {
    schema_version: response.schema_version,
    source: response.meta.source,
    symbol: response.data.symbol,
    from: response.data.from,
    to: response.data.to,
    transaction: response.data.transaction_type,
    transaction_type: response.meta.transaction_type,
    investor: response.data.investor_type,
    investor_type: response.meta.investor_type,
    board: response.data.market_board,
    market_board: response.meta.market_board,
    limit: response.meta.limit,
    buy_broker_count: response.data.summary.buy_broker_count,
    sell_broker_count: response.data.summary.sell_broker_count,
    overlapping_broker_count: response.data.summary.overlapping_broker_count,
    empty: response.data.summary.empty,
    average_price: response.data.analytics.average_price,
    accumulation_distribution: response.data.analytics.accumulation_distribution,
    detector_broker_count: response.data.analytics.broker_count,
    total_buyers: response.data.analytics.total_buyers,
    total_sellers: response.data.analytics.total_sellers,
    detector_value: response.data.analytics.value,
    detector_volume: response.data.analytics.volume,
    parser_warnings: response.meta.parser.warnings.join(" | "),
    fetched_at: response.meta.fetched_at,
  };
  const brokers = [...response.data.brokers.buy, ...response.data.brokers.sell];
  const rows: Array<NormalizedBrokerEntry | undefined> =
    brokers.length > 0 ? brokers : [undefined];

  for (const broker of rows) {
    const record: BrokerCsvRecord = {
      ...shared,
      side: broker?.side,
      rank: broker?.rank,
      broker_code: broker?.broker_code,
      date: broker?.date,
      average_price_broker: broker?.average_price,
      lots: broker?.lots,
      side_volume: broker?.side_volume,
      value: broker?.value,
      side_value: broker?.side_value,
      frequency: broker?.frequency,
      investor_origin: broker?.investor_origin,
      investor_label: broker?.investor_label,
      appears_on_both_sides: broker?.appears_on_both_sides,
    };
    lines.push(
      BROKER_SUMMARY_CSV_COLUMNS.map((column) => encodeCsvCell(record[column])).join(","),
    );
  }
  return lines.join("\r\n");
}
