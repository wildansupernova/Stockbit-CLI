import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  getAgentHelp,
  parseHelpTopic,
  renderAgentHelp,
} from "../dist/help.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("builds a complete machine-readable agent reference", () => {
  const document = getAgentHelp();

  assert.equal(document.schema_version, "1");
  assert.equal(document.topic, "all");
  assert.ok(document.commands.some(({ command }) => command.includes("auth login")));
  assert.deepEqual(document.authentication.resolution_order, [
    "--bearer <token>",
    "--account <name> from a local or global credentials file",
    "STOCKBIT_BEARER_TOKEN",
    "a random account from ./credentials-stockbit.json",
    "a random account from ~/.config/stockbit-cli/credentials.json",
  ]);
  assert.match(document.authentication.multi_account[1], /random/iu);
  assert.ok(document.commands.some(({ command }) => command.includes("auth accounts")));
  assert.match(document.authentication.login_steps[4], /another account/iu);
  assert.deepEqual(
    document.formats.map(({ name }) => name),
    ["json", "raw", "csv"],
  );
  assert.equal(
    document.fundamentals.statement_types.find(({ name }) => name === "q2").value,
    6,
  );
  assert.equal(document.broker_summary.transaction_types.length, 2);
  assert.equal(document.broker_summary.investor_types.length, 3);
  assert.equal(document.broker_summary.market_boards.length, 4);
  assert.equal(document.prices.defaults.interval, "daily");
  assert.match(document.prices.date_semantics[1], /reverses/iu);
});

test("supports focused topics and readable rendering", () => {
  assert.equal(parseHelpTopic("authentication"), "auth");
  assert.equal(parseHelpTopic("views"), "formats");
  assert.equal(parseHelpTopic("brokers"), "broker-summary");
  assert.equal(parseHelpTopic("prices"), "price");
  assert.equal(parseHelpTopic("OHLCV"), "price");
  assert.throws(() => parseHelpTopic("dividends"), /unknown help topic/i);

  const document = getAgentHelp("formats");
  assert.equal(document.authentication, undefined);
  assert.equal(document.fundamentals, undefined);
  assert.equal(document.prices, undefined);
  assert.equal(document.commands, undefined);
  assert.equal(document.formats.length, 3);

  const rendered = renderAgentHelp(document);
  assert.match(rendered, /Machine-readable reference: stockbit help --json/u);
  assert.match(rendered, /json \(application\/json\)/u);
  assert.match(rendered, /csv \(text\/csv\)/u);
});

test("stockbit help price --json documents range translation and formats", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    "help",
    "price",
    "--json",
  ]);
  const document = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(document.topic, "price");
  assert.equal(document.prices.defaults.limit, "0 (all rows returned by Stockbit)");
  assert.match(document.prices.date_semantics[0], /oldest.*newest/iu);
  assert.match(document.prices.date_semantics[1], /translates/iu);
  assert.match(document.prices.response_notes[0], /open.*high.*low.*close/iu);
});

test("stockbit help broker-summary --json documents broker semantics", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    "help",
    "broker-summary",
    "--json",
  ]);
  const document = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(document.topic, "broker-summary");
  assert.match(document.broker_summary.transaction_types[0].semantics, /both sides/iu);
  assert.match(document.broker_summary.transaction_types[1].semantics, /difference/iu);
  assert.equal(document.broker_summary.market_boards[1].value, "MARKET_BOARD_REGULER");
});

test("stockbit help formats --json runs without authentication", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    "help",
    "formats",
    "--json",
  ]);
  const document = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(document.topic, "formats");
  assert.deepEqual(
    document.formats.map(({ name }) => name),
    ["json", "raw", "csv"],
  );
});
