import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROKER_INVESTOR_TYPES,
  BROKER_MARKET_BOARDS,
  BROKER_SUMMARY_CSV_COLUMNS,
  BROKER_TRANSACTION_TYPES,
  parseBrokerDate,
  parseBrokerInvestorType,
  parseBrokerLimit,
  parseBrokerMarketBoard,
  parseBrokerSummaryResponse,
  parseBrokerTransactionType,
  serializeBrokerSummaryCsv,
  validateBrokerDateRange,
} from "../dist/broker-summary.js";
import { StockbitClient } from "../dist/fundamental.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/broker-summary.json", import.meta.url), "utf8"),
);

function request(overrides = {}) {
  return {
    symbol: "BBCA",
    from: "2026-08-19",
    to: "2026-08-19",
    transactionType: BROKER_TRANSACTION_TYPES.gross,
    investorType: BROKER_INVESTOR_TYPES.all,
    marketBoard: BROKER_MARKET_BOARDS.regular,
    limit: 25,
    view: "json",
    ...overrides,
  };
}

test("accepts aliases for all 24 transaction, investor, and board combinations", () => {
  assert.equal(parseBrokerTransactionType("GROSS"), "TRANSACTION_TYPE_GROSS");
  assert.equal(parseBrokerTransactionType("TRANSACTION_TYPE_NET"), "TRANSACTION_TYPE_NET");
  assert.equal(parseBrokerInvestorType("local"), "INVESTOR_TYPE_DOMESTIC");
  assert.equal(parseBrokerInvestorType("asing"), "INVESTOR_TYPE_FOREIGN");
  assert.equal(parseBrokerInvestorType("all"), "INVESTOR_TYPE_ALL");
  assert.equal(parseBrokerMarketBoard("regular"), "MARKET_BOARD_REGULER");
  assert.equal(parseBrokerMarketBoard("reguler"), "MARKET_BOARD_REGULER");
  assert.equal(parseBrokerMarketBoard("cash"), "MARKET_BOARD_TUNAI");
  assert.equal(parseBrokerMarketBoard("nego"), "MARKET_BOARD_NEGO");

  const combinations = new Set();
  for (const transaction of Object.values(BROKER_TRANSACTION_TYPES)) {
    for (const investor of Object.values(BROKER_INVESTOR_TYPES)) {
      for (const board of Object.values(BROKER_MARKET_BOARDS)) {
        combinations.add(`${transaction}:${investor}:${board}`);
      }
    }
  }
  assert.equal(combinations.size, 24);
  assert.throws(() => parseBrokerTransactionType("mixed"), /gross.*net/iu);
  assert.throws(() => parseBrokerInvestorType("retail"), /domestic.*foreign/iu);
  assert.throws(() => parseBrokerMarketBoard("primary"), /market board/iu);
});

test("validates date ranges and limits", () => {
  assert.equal(parseBrokerDate("2026-08-19", "from"), "2026-08-19");
  assert.equal(parseBrokerDate("2028-02-29", "to"), "2028-02-29");
  assert.equal(parseBrokerLimit("25"), 25);
  assert.doesNotThrow(() => validateBrokerDateRange("2026-08-19", "2026-08-20"));
  assert.throws(() => parseBrokerDate("2026-02-29", "from"), /not valid/iu);
  assert.throws(() => validateBrokerDateRange("2026-08-20", "2026-08-19"), /--from/iu);
  assert.throws(() => parseBrokerLimit("0"), /positive integer/iu);
});

test("normalizes populated gross responses and marks brokers on both sides", () => {
  const result = parseBrokerSummaryResponse(fixture, request());

  assert.deepEqual(result.warnings, []);
  assert.equal(result.data.transaction_type, "gross");
  assert.equal(result.data.summary.buy_broker_count, 2);
  assert.equal(result.data.summary.sell_broker_count, 2);
  assert.equal(result.data.summary.overlapping_broker_count, 1);
  assert.equal(result.data.summary.empty, false);
  assert.equal(result.data.analytics.average_price, 6344.1304);
  assert.equal(result.data.analytics.tiers.top_1.classification, "Big Acc");

  assert.deepEqual(result.data.brokers.buy[0], {
    rank: 1,
    side: "buy",
    broker_code: "AA",
    date: "2026-08-19",
    symbol: "BBCA",
    average_price: "6345.108239331216",
    lots: "246537",
    side_volume: "2.46537e+07",
    value: "1.56430395e+11",
    side_value: "1.56430395e+11",
    frequency: "2451",
    investor_origin: "foreign",
    investor_label: "Asing",
    appears_on_both_sides: true,
  });
  assert.equal(result.data.brokers.buy[1].investor_origin, "domestic");
  assert.equal(result.data.brokers.sell[0].appears_on_both_sides, true);
});

test("preserves signed net values and accepts an empty side", () => {
  const netFixture = structuredClone(fixture);
  netFixture.data.broker_summary.brokers_buy = [
    netFixture.data.broker_summary.brokers_buy[0],
  ];
  netFixture.data.broker_summary.brokers_sell = [
    {
      ...netFixture.data.broker_summary.brokers_sell[1],
      slot: "-84903",
      sval: "-5.365799e+10",
    },
  ];
  const result = parseBrokerSummaryResponse(
    netFixture,
    request({ transactionType: BROKER_TRANSACTION_TYPES.net }),
  );

  assert.deepEqual(result.warnings, []);
  assert.equal(result.data.transaction_type, "net");
  assert.equal(result.data.summary.overlapping_broker_count, 0);
  assert.equal(result.data.brokers.sell[0].lots, "-84903");
  assert.equal(result.data.brokers.sell[0].value, "-5.365799e+10");
  assert.match(result.data.transaction_semantics, /net difference/iu);

  netFixture.data.broker_summary.brokers_sell = [];
  const oneSided = parseBrokerSummaryResponse(
    netFixture,
    request({ transactionType: BROKER_TRANSACTION_TYPES.net }),
  );
  assert.equal(oneSided.data.summary.buy_broker_count, 1);
  assert.equal(oneSided.data.summary.sell_broker_count, 0);
});

test("accepts valid empty responses and emits a metadata CSV row", async () => {
  const emptyFixture = structuredClone(fixture);
  emptyFixture.data.broker_summary.brokers_buy = [];
  emptyFixture.data.broker_summary.brokers_sell = [];
  emptyFixture.data.bandar_detector.average = 0;
  emptyFixture.data.bandar_detector.total_buyer = 0;
  emptyFixture.data.bandar_detector.total_seller = 0;
  emptyFixture.data.bandar_detector.value = 0;
  emptyFixture.data.bandar_detector.volume = 0;

  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async () =>
      new Response(JSON.stringify(emptyFixture), { status: 200 }),
  });
  const response = await client.brokerSummary(
    request({ marketBoard: BROKER_MARKET_BOARDS.cash, view: "csv" }),
  );
  assert.equal(response.view, "csv");
  assert.equal(response.data.summary.empty, true);

  const csv = serializeBrokerSummaryCsv(response);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], BROKER_SUMMARY_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,cash,MARKET_BOARD_TUNAI,25,0,0,0,true,0,/u);
});

test("client sends exact broker-summary query enums and returns normalized JSON", async () => {
  let capturedUrl;
  const client = new StockbitClient({
    token: "test-token",
    fetchImplementation: async (url) => {
      capturedUrl = new URL(url);
      return new Response(JSON.stringify(fixture), { status: 200 });
    },
  });
  const result = await client.brokerSummary(request());

  assert.equal(capturedUrl.pathname, "/marketdetectors/BBCA");
  assert.equal(capturedUrl.searchParams.get("from"), "2026-08-19");
  assert.equal(capturedUrl.searchParams.get("to"), "2026-08-19");
  assert.equal(capturedUrl.searchParams.get("transaction_type"), "TRANSACTION_TYPE_GROSS");
  assert.equal(capturedUrl.searchParams.get("investor_type"), "INVESTOR_TYPE_ALL");
  assert.equal(capturedUrl.searchParams.get("market_board"), "MARKET_BOARD_REGULER");
  assert.equal(capturedUrl.searchParams.get("limit"), "25");
  assert.equal(result.view, "json");
  assert.equal(result.data.brokers.buy[0].broker_code, "AA");
  assert.deepEqual(result.meta.parser.warnings, []);
});
