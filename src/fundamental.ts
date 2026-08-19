import { CliError } from "./errors.js";
import {
  parseFinancialHtmlResponse,
  type ParsedFinancialData,
} from "./financial-parser.js";

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
  view?: FundamentalView;
}

export type FundamentalView = "json" | "raw" | "csv";

export interface FundamentalMeta {
  source: "stockbit";
  endpoint: "findata-view/company/financial";
  symbol: string;
  data_type: number;
  report_type: number;
  report: string;
  statement_type: number;
  statement: string;
  fetched_at: string;
}

interface ParsedFundamentalMeta extends FundamentalMeta {
  parser: {
    name: "stockbit-financial-html";
    version: "1";
    warnings: string[];
  };
}

interface RawFundamentalResponse {
  schema_version: "1";
  view: "raw";
  data: unknown;
  meta: FundamentalMeta;
}

interface StructuredFundamentalResponse<View extends "json" | "csv"> {
  schema_version: "1";
  view: View;
  data: ParsedFinancialData;
  meta: ParsedFundamentalMeta;
}

export type FundamentalResponse =
  | RawFundamentalResponse
  | StructuredFundamentalResponse<"json">
  | StructuredFundamentalResponse<"csv">;

export interface UserProfileResponse {
  schema_version: "1";
  data: unknown;
  meta: {
    source: "stockbit";
    endpoint: "usergraph/socialinfo/user/me";
    fetched_at: string;
  };
}

export interface RefreshedStockbitCredentials {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}

export interface StockbitClientOptions {
  token: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  onCredentialsRefreshed?: (
    credentials: RefreshedStockbitCredentials,
  ) => Promise<void> | void;
  baseUrl?: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: typeof fetch;
}

type UnknownRecord = Record<string, unknown>;

interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizedExpiration(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const expiration = new Date(value);
  return Number.isNaN(expiration.getTime()) ? undefined : expiration.toISOString();
}

function jwtExpiration(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number"
      ? new Date(decoded.exp * 1000).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseRefreshResponse(
  value: unknown,
  currentRefreshToken: string,
): RefreshedStockbitCredentials {
  if (!isRecord(value)) {
    throw new CliError(
      "INVALID_REFRESH_RESPONSE",
      "Stockbit returned an invalid token refresh response.",
      4,
    );
  }

  const data = isRecord(value.data) ? value.data : undefined;
  const nestedData = data && isRecord(data.data) ? data.data : undefined;
  const state = isRecord(value.state) ? value.state : undefined;
  const containers = [value, data, nestedData, state].filter(
    (container): container is UnknownRecord => container !== undefined,
  );

  for (const container of containers) {
    const access = isRecord(container.access) ? container.access : undefined;
    const refresh = isRecord(container.refresh) ? container.refresh : undefined;
    const accessToken = firstString(
      access?.token,
      typeof container.access === "string" ? container.access : undefined,
      container.access_token,
      container.accessToken,
      container.token,
    );
    if (!accessToken) {
      continue;
    }

    const refreshToken = firstString(
      refresh?.token,
      typeof container.refresh === "string" ? container.refresh : undefined,
      container.refresh_token,
      container.refreshToken,
      currentRefreshToken,
    );
    if (!refreshToken) {
      continue;
    }

    const accessExpiresAt =
      normalizedExpiration(
        firstString(
          access?.expired_at,
          access?.expires_at,
          access?.expiredAt,
          container.access_expired_at,
          container.accessExpiresAt,
          container.expired_at,
          container.expires_at,
        ),
      ) ?? jwtExpiration(accessToken);
    const refreshExpiresAt =
      normalizedExpiration(
        firstString(
          refresh?.expired_at,
          refresh?.expires_at,
          refresh?.expiredAt,
          container.refresh_expired_at,
          container.refreshExpiresAt,
        ),
      ) ?? jwtExpiration(refreshToken);

    return {
      accessToken,
      refreshToken,
      ...(accessExpiresAt ? { accessExpiresAt } : {}),
      ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
    };
  }

  throw new CliError(
    "INVALID_REFRESH_RESPONSE",
    "Stockbit's token refresh response did not contain an access token.",
    4,
  );
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

export function parseFundamentalView(value: string): FundamentalView {
  const normalized = normalizedOption(value);
  if (normalized === "json" || normalized === "raw" || normalized === "csv") {
    return normalized;
  }
  throw new CliError(
    "INVALID_OPTION",
    `Invalid view \`${value}\`. Expected \`json\`, \`raw\`, or \`csv\`.`,
    2,
  );
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
  private token: string;
  private refreshToken: string | undefined;
  private accessExpiresAt: number | undefined;
  private readonly onCredentialsRefreshed:
    | ((credentials: RefreshedStockbitCredentials) => Promise<void> | void)
    | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetchImplementation: typeof fetch;
  private refreshPromise: Promise<void> | undefined;

  constructor(options: StockbitClientOptions) {
    this.token = options.token;
    this.refreshToken = options.refreshToken;
    const accessExpiresAt = options.accessExpiresAt ?? jwtExpiration(options.token);
    this.accessExpiresAt = accessExpiresAt ? Date.parse(accessExpiresAt) : undefined;
    this.onCredentialsRefreshed = options.onCredentialsRefreshed;
    this.baseUrl = options.baseUrl ?? "https://exodus.stockbit.com/";
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    token: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<HttpResult> {
    const url = new URL(endpoint, this.baseUrl);
    if (query) {
      url.search = new URLSearchParams(query).toString();
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMilliseconds);

    try {
      const response = await this.fetchImplementation(url, {
        method,
        headers: {
          accept: "application/json, text/plain, */*",
          authorization: `Bearer ${token}`,
          ...(method === "POST"
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
          origin: "https://stockbit.com",
          referer: "https://stockbit.com/",
          "user-agent": "stockbit-cli/0.1.0",
        },
        signal: abortController.signal,
      });
      const body = await response.text();
      return { ok: response.ok, status: response.status, body };
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

  private async performRefresh(): Promise<void> {
    const currentRefreshToken = this.refreshToken;
    if (!currentRefreshToken) {
      throw new CliError(
        "REFRESH_TOKEN_REQUIRED",
        "No refresh token is configured. Run `stockbit auth login` again.",
        3,
      );
    }

    const response = await this.request("POST", "login/refresh", currentRefreshToken);
    if (!response.ok) {
      const detail = upstreamMessage(response.body);
      const suffix = detail ? `: ${detail}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new CliError(
          "REFRESH_FAILED",
          `Stockbit rejected the refresh token${suffix}. Run \`stockbit auth login\` again.`,
          3,
        );
      }
      throw new CliError(
        "REFRESH_FAILED",
        `Stockbit could not refresh authentication (HTTP ${response.status})${suffix}`,
        4,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new CliError(
        "INVALID_REFRESH_RESPONSE",
        "Stockbit returned a successful token refresh response that was not valid JSON.",
        4,
        { cause: error },
      );
    }

    const credentials = parseRefreshResponse(body, currentRefreshToken);
    if (this.onCredentialsRefreshed) {
      await this.onCredentialsRefreshed(credentials);
    }
    this.token = credentials.accessToken;
    this.refreshToken = credentials.refreshToken;
    this.accessExpiresAt = credentials.accessExpiresAt
      ? Date.parse(credentials.accessExpiresAt)
      : undefined;
  }

  private async refreshAuthentication(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    await this.refreshPromise;
  }

  private throwResponseError(response: HttpResult): never {
    const detail = upstreamMessage(response.body);
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

  private async getJson(
    endpoint: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    let refreshed = false;
    if (
      this.refreshToken &&
      this.accessExpiresAt !== undefined &&
      this.accessExpiresAt <= Date.now() + 30_000
    ) {
      await this.refreshAuthentication();
      refreshed = true;
    }

    let response = await this.request("GET", endpoint, this.token, query);
    if (response.status === 401 && this.refreshToken && !refreshed) {
      await this.refreshAuthentication();
      refreshed = true;
      response = await this.request("GET", endpoint, this.token, query);
    }

    if (!response.ok) {
      this.throwResponseError(response);
    }

    try {
      return JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new CliError(
        "INVALID_RESPONSE",
        "Stockbit returned a successful response that was not valid JSON.",
        4,
        { cause: error },
      );
    }
  }

  async fundamental(request: FundamentalRequest): Promise<FundamentalResponse> {
    const symbol = normalizeSymbol(request.symbol);
    const rawData = await this.getJson("findata-view/company/financial", {
      symbol,
      data_type: String(request.dataType),
      report_type: String(request.reportType),
      statement_type: String(request.statementType),
    });
    const view = request.view ?? "raw";
    const meta: FundamentalMeta = {
      source: "stockbit",
      endpoint: "findata-view/company/financial",
      symbol,
      data_type: request.dataType,
      report_type: request.reportType,
      report: REPORT_NAMES.get(request.reportType) ?? String(request.reportType),
      statement_type: request.statementType,
      statement: STATEMENT_NAMES.get(request.statementType) ?? String(request.statementType),
      fetched_at: new Date().toISOString(),
    };

    if (view === "raw") {
      return {
        schema_version: "1",
        view,
        data: rawData,
        meta,
      };
    }

    const parsed = parseFinancialHtmlResponse(rawData);

    return {
      schema_version: "1",
      view,
      data: parsed.data,
      meta: {
        ...meta,
        parser: {
          name: "stockbit-financial-html",
          version: "1",
          warnings: parsed.warnings,
        },
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
