import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeSymbol,
  parseDataType,
  parseFundamentalView,
  parseRefreshResponse,
  parseReportType,
  parseStatementType,
  StockbitClient,
} from "../dist/fundamental.js";

const financialHtml = await readFile(
  new URL("./fixtures/financial-report.html", import.meta.url),
  "utf8",
);

test("parses report type names, aliases, and numbers", () => {
  assert.equal(parseReportType("income"), 1);
  assert.equal(parseReportType("balance-sheet"), 2);
  assert.equal(parseReportType("cash flow"), 3);
  assert.equal(parseReportType("2"), 2);
});

test("parses every supported statement type", () => {
  assert.equal(parseStatementType("quarterly"), 1);
  assert.equal(parseStatementType("annual"), 2);
  assert.equal(parseStatementType("TTM"), 3);
  assert.equal(parseStatementType("interim_ytd"), 4);
  assert.equal(parseStatementType("Q4"), 8);
  assert.equal(parseStatementType("QoQ Growth"), 9);
  assert.equal(parseStatementType("quarter yoy growth"), 10);
  assert.equal(parseStatementType("YTD YoY Growth"), 11);
  assert.equal(parseStatementType("Annual YoY Growth"), 12);
  assert.equal(parseStatementType("3Y CAGR"), 13);
  assert.equal(parseStatementType("13"), 13);
});

test("validates symbols and data types", () => {
  assert.equal(normalizeSymbol("jtpe"), "JTPE");
  assert.equal(parseDataType("1"), 1);
  assert.equal(parseFundamentalView("JSON"), "json");
  assert.equal(parseFundamentalView("RAW"), "raw");
  assert.equal(parseFundamentalView("csv"), "csv");
  assert.throws(() => normalizeSymbol("JTPE&other=true"), /ticker symbol/i);
  assert.throws(() => parseDataType("zero"), /positive integer/i);
  assert.throws(
    () => parseFundamentalView("parsed"),
    /expected `json`, `raw`, or `csv`/i,
  );
});

test("fundamental sends the expected request and returns an envelope", async () => {
  let capturedUrl;
  let capturedAuthorization;

  const fetchImplementation = async (url, init) => {
    capturedUrl = new URL(url);
    capturedAuthorization = new Headers(init.headers).get("authorization");
    return new Response(JSON.stringify({ data: [{ account: "Revenue" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation,
  });
  const result = await client.fundamental({
    symbol: "jtpe",
    dataType: 1,
    reportType: 1,
    statementType: 1,
  });

  assert.equal(capturedUrl.origin, "https://exodus.stockbit.com");
  assert.equal(capturedUrl.pathname, "/findata-view/company/financial");
  assert.equal(capturedUrl.searchParams.get("symbol"), "JTPE");
  assert.equal(capturedUrl.searchParams.get("data_type"), "1");
  assert.equal(capturedUrl.searchParams.get("report_type"), "1");
  assert.equal(capturedUrl.searchParams.get("statement_type"), "1");
  assert.equal(capturedAuthorization, "Bearer test-token");
  assert.equal(result.schema_version, "1");
  assert.equal(result.view, "raw");
  assert.equal(result.meta.report, "income");
  assert.equal(result.meta.statement, "quarterly");
  assert.deepEqual(result.data, { data: [{ account: "Revenue" }] });
});

test("fundamental can return normalized financial JSON", async () => {
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          message: "Successfully retrieved company financial",
          data: {
            currency: ["IDR", "USD"],
            default_currency: "IDR",
            html_report: financialHtml,
            rounding_value: [1_000_000_000, 1_000_000],
          },
        }),
        { status: 200 },
      ),
  });

  const result = await client.fundamental({
    symbol: "BBCA",
    dataType: 1,
    reportType: 1,
    statementType: 2,
    view: "json",
  });

  assert.equal(result.view, "json");
  assert.equal(result.data.tables[0].rows[0].label, "Total Revenue");
  assert.deepEqual(result.meta.parser, {
    name: "stockbit-financial-html",
    version: "1",
    warnings: [],
  });
});

test("fundamental reports authentication failures without exposing the token", async () => {
  const client = new StockbitClient({
    token: "test-secret-token",
    fetchImplementation: async () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
  });

  await assert.rejects(
    client.fundamental({
      symbol: "JTPE",
      dataType: 1,
      reportType: 1,
      statementType: 1,
    }),
    (error) => {
      assert.equal(error.code, "AUTH_FAILED");
      assert.doesNotMatch(error.message, /test-secret-token/);
      return true;
    },
  );
});

test("refreshes on 401, persists rotated credentials, and retries once", async () => {
  const requests = [];
  let persisted;
  const client = new StockbitClient({
    token: "expired-access-token",
    refreshToken: "current-refresh-token",
    onCredentialsRefreshed: (credentials) => {
      persisted = credentials;
    },
    fetchImplementation: async (url, init) => {
      const request = {
        method: init.method,
        path: new URL(url).pathname,
        authorization: new Headers(init.headers).get("authorization"),
      };
      requests.push(request);

      if (request.path === "/login/refresh") {
        return new Response(
          JSON.stringify({
            data: {
              access: {
                token: "new-access-token",
                expired_at: "2030-01-02T03:04:05Z",
              },
              refresh: {
                token: "rotated-refresh-token",
                expired_at: "2030-01-09T03:04:05Z",
              },
            },
          }),
          { status: 200 },
        );
      }
      if (request.authorization === "Bearer expired-access-token") {
        return new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ data: { username: "example-user" } }), {
        status: 200,
      });
    },
  });

  const result = await client.userProfile();

  assert.deepEqual(result.data, { data: { username: "example-user" } });
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/usergraph/socialinfo/user/me",
      authorization: "Bearer expired-access-token",
    },
    {
      method: "POST",
      path: "/login/refresh",
      authorization: "Bearer current-refresh-token",
    },
    {
      method: "GET",
      path: "/usergraph/socialinfo/user/me",
      authorization: "Bearer new-access-token",
    },
  ]);
  assert.deepEqual(persisted, {
    accessToken: "new-access-token",
    refreshToken: "rotated-refresh-token",
    accessExpiresAt: "2030-01-02T03:04:05.000Z",
    refreshExpiresAt: "2030-01-09T03:04:05.000Z",
  });
});

test("accepts common refresh response shapes and retains an unrotated refresh token", () => {
  assert.deepEqual(
    parseRefreshResponse(
      {
        data: {
          access_token: "new-access-token",
          access_expired_at: "2030-01-02T03:04:05Z",
        },
      },
      "existing-refresh-token",
    ),
    {
      accessToken: "new-access-token",
      refreshToken: "existing-refresh-token",
      accessExpiresAt: "2030-01-02T03:04:05.000Z",
    },
  );
});

test("refreshes proactively when the saved access expiration is near", async () => {
  const requests = [];
  const client = new StockbitClient({
    token: "nearly-expired-access-token",
    refreshToken: "current-refresh-token",
    accessExpiresAt: new Date(Date.now() + 5_000).toISOString(),
    fetchImplementation: async (url, init) => {
      const request = {
        method: init.method,
        path: new URL(url).pathname,
        authorization: new Headers(init.headers).get("authorization"),
      };
      requests.push(request);
      if (request.path === "/login/refresh") {
        return new Response(
          JSON.stringify({ data: { access_token: "new-access-token" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: { username: "example-user" } }), {
        status: 200,
      });
    },
  });

  await client.userProfile();

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/login/refresh",
      authorization: "Bearer current-refresh-token",
    },
    {
      method: "GET",
      path: "/usergraph/socialinfo/user/me",
      authorization: "Bearer new-access-token",
    },
  ]);
});

test("reports a rejected refresh token without exposing either credential", async () => {
  let requestCount = 0;
  const client = new StockbitClient({
    token: "secret-access-token",
    refreshToken: "secret-refresh-token",
    fetchImplementation: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    },
  });

  await assert.rejects(client.userProfile(), (error) => {
    assert.equal(error.code, "REFRESH_FAILED");
    assert.doesNotMatch(error.message, /secret-access-token|secret-refresh-token/u);
    return true;
  });
  assert.equal(requestCount, 2);
});

test("userProfile requests the authenticated user endpoint", async () => {
  let capturedUrl;
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async (url) => {
      capturedUrl = new URL(url);
      return new Response(JSON.stringify({ data: { username: "example-user" } }), {
        status: 200,
      });
    },
  });

  const result = await client.userProfile();

  assert.equal(capturedUrl.pathname, "/usergraph/socialinfo/user/me");
  assert.deepEqual(result.data, { data: { username: "example-user" } });
  assert.equal(result.meta.endpoint, "usergraph/socialinfo/user/me");
});
