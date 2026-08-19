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
    "STOCKBIT_BEARER_TOKEN",
    "./credentials-stockbit.json",
    "~/.config/stockbit-cli/credentials.json",
  ]);
  assert.deepEqual(
    document.formats.map(({ name }) => name),
    ["json", "raw", "csv"],
  );
  assert.equal(
    document.fundamentals.statement_types.find(({ name }) => name === "q2").value,
    6,
  );
});

test("supports focused topics and readable rendering", () => {
  assert.equal(parseHelpTopic("authentication"), "auth");
  assert.equal(parseHelpTopic("views"), "formats");
  assert.throws(() => parseHelpTopic("prices"), /unknown help topic/i);

  const document = getAgentHelp("formats");
  assert.equal(document.authentication, undefined);
  assert.equal(document.fundamentals, undefined);
  assert.equal(document.commands, undefined);
  assert.equal(document.formats.length, 3);

  const rendered = renderAgentHelp(document);
  assert.match(rendered, /Machine-readable reference: stockbit help --json/u);
  assert.match(rendered, /json \(application\/json\)/u);
  assert.match(rendered, /csv \(text\/csv\)/u);
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
