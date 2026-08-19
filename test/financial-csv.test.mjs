import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FINANCIAL_CSV_COLUMNS,
  serializeFundamentalCsv,
} from "../dist/financial-csv.js";
import { StockbitClient } from "../dist/fundamental.js";

const financialHtml = await readFile(
  new URL("./fixtures/financial-report.html", import.meta.url),
  "utf8",
);

test("serializes normalized fundamentals as one CSV row per account-period", async () => {
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

  const response = await client.fundamental({
    symbol: "BBCA",
    dataType: 1,
    reportType: 1,
    statementType: 2,
    view: "csv",
  });
  assert.equal(response.view, "csv");

  response.data.tables[0].rows[0].label = 'Total "Revenue", net';
  const csv = serializeFundamentalCsv(response);
  const lines = csv.split("\r\n");

  assert.equal(lines[0], FINANCIAL_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 7);
  assert.match(csv, /,"Total ""Revenue"", net",/u);
  assert.match(csv, /,12M24,12M 2024,true,1\.00 M,1000000\.000000,1000000,64,100,/u);
  assert.match(csv, /,12M25,12M 2025,false,-,,,,0,/u);
});
