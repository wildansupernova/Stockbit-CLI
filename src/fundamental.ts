import { CliError } from "./errors.js";

export const REPORT_TYPES = {
  income: 1,
  balance: 2,
  cashflow: 3,
} as const;

export const STATEMENT_TYPES = {
  quarterly: 1,
  annual: 2,
  ttm: 3,
  "interim-ytd": 4,
  q1: 5,
  q2: 6,
  q3: 7,
  q4: 8,
  "qoq-growth": 9,
  "quarter-yoy-growth": 10,
  "ytd-yoy-growth": 11,
  "annual-yoy-growth": 12,
  "3-year-cagr": 13,
} as const;

const REPORT_ALIASES: Readonly<Record<string, number>> = {
  ...REPORT_TYPES,
  "income-statement": 1,
  "balance-sheet": 2,
  "cash-flow": 3,
};

const STATEMENT_ALIASES: Readonly<Record<string, number>> = {
  ...STATEMENT_TYPES,
  quarter: 1,
  yearly: 2,
  ytd: 4,
  "q-yoy-growth": 10,
  "3y-cagr": 13,
  cagr3: 13,
};

const REPORT_NAMES = new Map<number, keyof typeof REPORT_TYPES>([
  [1, "income"],
  [2, "balance"],
  [3, "cashflow"],
]);

const STATEMENT_NAMES = new Map<number, keyof typeof STATEMENT_TYPES>(
  Object.entries(STATEMENT_TYPES).map(([name, value]) => [
    value,
    name as keyof typeof STATEMENT_TYPES,
  ]),
);

export interface FundamentalRequest {
  symbol: string;
  dataType: number;
  reportType: number;
  statementType: number;
}

export interface FundamentalResponse {
  schema_version: "1";
  data: unknown;
  meta: {
    source: "stockbit";
    endpoint: "findata-view/company/financial";
    symbol: string;
    data_type: number;
    report_type: number;
    report: string;
    statement_type: number;
    statement: string;
    fetched_at: string;
  };
}

export interface UserProfileResponse {
  schema_version: "1";
  data: unknown;
  meta: {
    source: "stockbit";
    endpoint: "usergraph/socialinfo/user/me";
    fetched_at: string;
  };
}

export interface StockbitClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: typeof fetch;
}

function normalizedOption(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

function parseMappedOption(
  value: string,
  aliases: Readonly<Record<string, number>>,
  minimum: number,
  maximum: number,
  optionName: string,
): number {
  const normalized = normalizedOption(value);
  if (/^\d+$/u.test(normalized)) {
    const numeric = Number.parseInt(normalized, 10);
    if (numeric >= minimum && numeric <= maximum) {
      return numeric;
    }
  }

  const mapped = aliases[normalized];
  if (mapped !== undefined) {
    return mapped;
  }

  throw new CliError(
    "INVALID_OPTION",
    `Invalid ${optionName} \`${value}\`. Run \`stockbit fundamental --help\` for supported values.`,
    2,
  );
}

export function parseReportType(value: string): number {
  return parseMappedOption(value, REPORT_ALIASES, 1, 3, "report type");
}

export function parseStatementType(value: string): number {
  return parseMappedOption(value, STATEMENT_ALIASES, 1, 13, "statement type");
}

export function parseDataType(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new CliError("INVALID_OPTION", "Data type must be a positive integer.", 2);
  }

  const dataType = Number.parseInt(value, 10);
  if (dataType < 1) {
    throw new CliError("INVALID_OPTION", "Data type must be a positive integer.", 2);
  }
  return dataType;
}

export function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,20}$/u.test(symbol)) {
    throw new CliError(
      "INVALID_SYMBOL",
      "The ticker symbol may contain only letters, numbers, periods, and hyphens.",
      2,
    );
  }
  return symbol;
}

function upstreamMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") {
      return parsed.message.slice(0, 300);
    }
    if (typeof parsed.error === "string") {
      return parsed.error.slice(0, 300);
    }
  } catch {
    // The provider may return HTML or plain text. Do not include it in errors.
  }
  return undefined;
}

export class StockbitClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: StockbitClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://exodus.stockbit.com/";
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  private async getJson(
    endpoint: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const url = new URL(endpoint, this.baseUrl);
    if (query) {
      url.search = new URLSearchParams(query).toString();
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMilliseconds);

    try {
      const response = await this.fetchImplementation(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          origin: "https://stockbit.com",
          referer: "https://stockbit.com/",
          "user-agent": "stockbit-cli/0.1.0",
        },
        signal: abortController.signal,
      });
      const body = await response.text();

      if (!response.ok) {
        const detail = upstreamMessage(body);
        const suffix = detail ? `: ${detail}` : "";
        if (response.status === 401) {
          throw new CliError(
            "AUTH_FAILED",
            `Stockbit rejected the bearer token${suffix}`,
            3,
          );
        }
        if (response.status === 403) {
          throw new CliError("ACCESS_DENIED", `Stockbit denied access${suffix}`, 3);
        }
        if (response.status === 429) {
          throw new CliError("RATE_LIMITED", `Stockbit rate-limited the request${suffix}`, 4);
        }
        throw new CliError(
          "UPSTREAM_ERROR",
          `Stockbit returned HTTP ${response.status}${suffix}`,
          4,
        );
      }

      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new CliError(
          "INVALID_RESPONSE",
          "Stockbit returned a successful response that was not valid JSON.",
          4,
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new CliError(
          "REQUEST_TIMEOUT",
          `The Stockbit request timed out after ${this.timeoutMilliseconds} ms.`,
          4,
          { cause: error },
        );
      }
      throw new CliError("NETWORK_ERROR", "The Stockbit request failed.", 4, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async fundamental(request: FundamentalRequest): Promise<FundamentalResponse> {
    const symbol = normalizeSymbol(request.symbol);
    const data = await this.getJson("findata-view/company/financial", {
      symbol,
      data_type: String(request.dataType),
      report_type: String(request.reportType),
      statement_type: String(request.statementType),
    });

    return {
      schema_version: "1",
      data,
      meta: {
        source: "stockbit",
        endpoint: "findata-view/company/financial",
        symbol,
        data_type: request.dataType,
        report_type: request.reportType,
        report: REPORT_NAMES.get(request.reportType) ?? String(request.reportType),
        statement_type: request.statementType,
        statement: STATEMENT_NAMES.get(request.statementType) ?? String(request.statementType),
        fetched_at: new Date().toISOString(),
      },
    };
  }

  async userProfile(): Promise<UserProfileResponse> {
    const data = await this.getJson("usergraph/socialinfo/user/me");
    return {
      schema_version: "1",
      data,
      meta: {
        source: "stockbit",
        endpoint: "usergraph/socialinfo/user/me",
        fetched_at: new Date().toISOString(),
      },
    };
  }
}
