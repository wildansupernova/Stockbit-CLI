import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseFinancialHtmlResponse } from "../dist/financial-parser.js";

const html = await readFile(
  new URL("./fixtures/financial-report.html", import.meta.url),
  "utf8",
);

const response = {
  message: "Successfully retrieved company financial",
  data: {
    currency: ["IDR", "USD"],
    default_currency: "IDR",
    html_report: html,
    rounding_value: [1_000_000_000, 1_000_000],
  },
};

test("parses financial and key-ratio tables into stable JSON", () => {
  const result = parseFinancialHtmlResponse(response);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.data.message, "Successfully retrieved company financial");
  assert.deepEqual(result.data.currencies, ["IDR", "USD"]);
  assert.equal(result.data.default_currency, "IDR");
  assert.equal(result.data.selected_currency, "idr");
  assert.equal(result.data.total_periods, 2);
  assert.deepEqual(result.data.rounding_values, [1_000_000_000, 1_000_000]);
  assert.equal(result.data.tables.length, 2);

  const financials = result.data.tables[0];
  assert.equal(financials.id, "data_table_1");
  assert.equal(financials.kind, "financials");
  assert.equal(financials.unit_label, "In Million");
  assert.deepEqual(financials.periods, [
    { key: "12M24", label: "12M 2024" },
    { key: "12M25", label: "12M 2025" },
  ]);

  const revenue = financials.rows[0];
  assert.equal(revenue.id, "1");
  assert.equal(revenue.kind, "heading");
  assert.equal(revenue.label, "Total Revenue");
  assert.equal(revenue.local_label, "Total Pendapatan");
  assert.deepEqual(revenue.tree, { left: 1, right: 4 });
  assert.deepEqual(revenue.values[0], {
    period: "12M24",
    display: "1.00 M",
    available: true,
    raw: "1000000.000000",
    idr: "1000000",
    usd: "64",
    percentage: "100",
  });
  assert.deepEqual(revenue.values[1], {
    period: "12M25",
    display: "-",
    available: false,
    raw: null,
    idr: null,
    usd: null,
    percentage: "0",
  });
  assert.equal(financials.rows[1].hidden, true);

  const ratios = result.data.tables[1];
  assert.equal(ratios.kind, "key-ratios");
  assert.equal(ratios.rows[0].kind, "formula");
  assert.equal(ratios.rows[0].values[0].display, "20.10%");
  assert.equal(ratios.rows[0].values[1].available, false);
  assert.equal(ratios.rows[0].values[1].raw, null);
});

test("rejects responses without an HTML report", () => {
  assert.throws(
    () => parseFinancialHtmlResponse({ data: {} }),
    (error) => {
      assert.equal(error.code, "HTML_REPORT_NOT_FOUND");
      return true;
    },
  );
});
