import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { StockbitClient } from "../dist/fundamental.js";
import {
  PRICE_CSV_COLUMNS,
  parsePriceDate,
  parsePriceLimit,
  parsePriceResponse,
  serializePriceCsv,
  validatePriceDateRange,
} from "../dist/price.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/price.json", import.meta.url), "utf8"),
);

function request(overrides = {}) {
  return {
    symbol: "ERAA",
    from: "2026-08-27",
    to: "2026-08-28",
    limit: 0,
    view: "json",
    ...overrides,
  };
}

test("validates intuitive price ranges and allows Stockbit's zero limit", () => {
  assert.equal(parsePriceDate("2026-08-27", "from"), "2026-08-27");
  assert.equal(parsePriceDate("2028-02-29", "to"), "2028-02-29");
  assert.equal(parsePriceLimit("0"), 0);
  assert.equal(parsePriceLimit("250"), 250);
  assert.doesNotThrow(() => validatePriceDateRange("2026-08-27", "2026-08-28"));
  assert.throws(() => parsePriceDate("2026-02-29", "from"), /not valid/iu);
  assert.throws(
    () => validatePriceDateRange("2026-08-28", "2026-08-27"),
    /--from/iu,
  );
  assert.throws(() => parsePriceLimit("-1"), /non-negative/iu);
  assert.throws(() => parsePriceLimit("1.5"), /non-negative/iu);
});

test("normalizes Chartbit rows to oldest-first exact OHLCV strings", () => {
  const result = parsePriceResponse(fixture, request());

  assert.deepEqual(result.warnings, []);
  assert.equal(result.data.message, "Retrieved Chartbit Price");
  assert.equal(result.data.symbol, "ERAA");
  assert.equal(result.data.interval, "daily");
  assert.equal(result.data.count, 2);
  assert.equal(result.data.empty, false);
  assert.deepEqual(result.data.returned_range, {
    from: "2026-08-27",
    to: "2026-08-28",
  });
  assert.deepEqual(result.data.bars[0], {
    date: "2026-08-27",
    unix_timestamp: 1787763600,
    open: "520",
    high: "535",
    low: "515",
    close: "530",
    volume: "1546100",
  });
  assert.equal(result.data.bars[1].date, "2026-08-28");
  assert.equal(result.data.bars[1].close, "540");
});

test("client translates normal CLI dates to Stockbit's reversed query", async () => {
  let capturedUrl;
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async (url) => {
      capturedUrl = new URL(url);
      return new Response(JSON.stringify(fixture), { status: 200 });
    },
  });

  const result = await client.price(request());

  assert.equal(capturedUrl.pathname, "/chartbit/ERAA/price/daily");
  assert.equal(capturedUrl.searchParams.get("from"), "2026-08-28");
  assert.equal(capturedUrl.searchParams.get("to"), "2026-08-27");
  assert.equal(capturedUrl.searchParams.get("limit"), "0");
  assert.equal(result.view, "json");
  assert.equal(result.meta.from, "2026-08-27");
  assert.equal(result.meta.to, "2026-08-28");
  assert.equal(result.meta.upstream_from, "2026-08-28");
  assert.equal(result.meta.upstream_to, "2026-08-27");
  assert.equal(result.meta.parser.name, "stockbit-daily-price");
});

test("raw view preserves Stockbit's response and newest-first order", async () => {
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async () =>
      new Response(JSON.stringify(fixture), { status: 200 }),
  });
  const result = await client.price(request({ view: "raw" }));

  assert.equal(result.view, "raw");
  assert.deepEqual(result.data, fixture);
  assert.equal(result.data.data.chartbit[0].unixdate, 1787850000);
  assert.equal(result.meta.parser, undefined);
});

test("CSV emits one row per bar and a metadata row for empty data", async () => {
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async () =>
      new Response(JSON.stringify(fixture), { status: 200 }),
  });
  const result = await client.price(request({ view: "csv" }));
  const csv = serializePriceCsv(result);
  const lines = csv.split("\r\n");

  assert.equal(lines[0], PRICE_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /ERAA,daily,2026-08-27,2026-08-28/iu);
  assert.match(lines[1], /2026-08-27,1787763600,520,535,515,530,1546100/iu);

  const emptyClient = new StockbitClient({
    token: "test-token",
    fetchImplementation: async () =>
      new Response(JSON.stringify({ message: "ok", data: { chartbit: [] } }), {
        status: 200,
      }),
  });
  const empty = await emptyClient.price(request({ view: "csv" }));
  const emptyLines = serializePriceCsv(empty).split("\r\n");
  assert.equal(empty.data.empty, true);
  assert.equal(empty.data.count, 0);
  assert.deepEqual(empty.data.returned_range, { from: null, to: null });
  assert.equal(emptyLines.length, 2);
  assert.match(emptyLines[1], /,0,true,/u);
});

test("reports schema drift and non-fatal volume/OHLC warnings", () => {
  assert.throws(
    () => parsePriceResponse({ data: {} }, request()),
    /data\.chartbit/iu,
  );
  assert.throws(
    () =>
      parsePriceResponse(
        { data: { chartbit: [{ unixdate: 1787763600, open: 1 }] } },
        request(),
      ),
    /high value/iu,
  );

  const warned = parsePriceResponse(
    {
      data: {
        chartbit: [
          {
            unixdate: 1787763600,
            open: 100,
            high: 90,
            low: 80,
            close: 95
          },
        ],
      },
    },
    request(),
  );
  assert.equal(warned.data.bars[0].volume, null);
  assert.equal(warned.warnings.length, 2);
  assert.match(warned.warnings[0], /volume/iu);
  assert.match(warned.warnings[1], /OHLC/iu);
});
