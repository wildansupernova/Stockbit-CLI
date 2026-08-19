import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSymbol,
  parseDataType,
  parseReportType,
  parseStatementType,
  StockbitClient,
} from "../dist/fundamental.js";

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
  assert.throws(() => normalizeSymbol("JTPE&other=true"), /ticker symbol/i);
  assert.throws(() => parseDataType("zero"), /positive integer/i);
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
  assert.equal(result.meta.report, "income");
  assert.equal(result.meta.statement, "quarterly");
  assert.deepEqual(result.data, { data: [{ account: "Revenue" }] });
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
