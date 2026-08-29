import { CliError } from "./errors.js";
import {
  BROKER_INVESTOR_TYPES,
  BROKER_MARKET_BOARDS,
  BROKER_TRANSACTION_TYPES,
} from "./broker-summary.js";
import { REPORT_TYPES, STATEMENT_TYPES } from "./fundamental.js";

export type HelpTopic =
  | "all"
  | "commands"
  | "auth"
  | "fundamental"
  | "broker-summary"
  | "price"
  | "formats";

interface HelpCommand {
  command: string;
  purpose: string;
  options?: string[];
}

interface HelpFormat {
  name: "json" | "raw" | "csv";
  media_type: string;
  purpose: string;
  shape: string;
}

export interface AgentHelpDocument {
  schema_version: "1";
  command: "stockbit";
  topic: HelpTopic;
  summary: string;
  usage: string[];
  documentation: {
    overview: string;
    topic_help: string;
    command_help: string;
  };
  commands?: HelpCommand[];
  authentication?: {
    resolution_order: string[];
    storage: Record<string, string>;
    login_steps: string[];
    multi_account: string[];
    automatic_refresh: string[];
    safety: string[];
  };
  fundamentals?: {
    syntax: string;
    defaults: Record<string, string>;
    report_types: Array<{ name: string; value: number }>;
    statement_types: Array<{ name: string; value: number }>;
    examples: string[];
  };
  broker_summary?: {
    syntax: string;
    defaults: Record<string, string>;
    transaction_types: Array<{ name: string; value: string; semantics: string }>;
    investor_types: Array<{ name: string; value: string }>;
    market_boards: Array<{ name: string; value: string }>;
    response_notes: string[];
    examples: string[];
  };
  prices?: {
    syntax: string;
    defaults: Record<string, string>;
    date_semantics: string[];
    response_notes: string[];
    examples: string[];
  };
  formats?: HelpFormat[];
  output_contract: {
    stdout: string;
    stderr: string;
    exit_codes: Record<string, string>;
  };
  agent_guidance: string[];
}

const TOPIC_ALIASES: Readonly<Record<string, HelpTopic>> = {
  all: "all",
  commands: "commands",
  command: "commands",
  auth: "auth",
  authentication: "auth",
  fundamental: "fundamental",
  fundamentals: "fundamental",
  broker: "broker-summary",
  brokers: "broker-summary",
  "broker-summary": "broker-summary",
  "broker-summaries": "broker-summary",
  price: "price",
  prices: "price",
  ohlcv: "price",
  "price-history": "price",
  format: "formats",
  formats: "formats",
  view: "formats",
  views: "formats",
};

const COMMANDS: HelpCommand[] = [
  {
    command: "stockbit auth login [--local] [--account <name>]",
    purpose: "Interactively add or update one or more accounts from credentialStorage values.",
  },
  {
    command: "stockbit auth set-token [--local] [--account <name>]",
    purpose: "Add or update a named access-only account without echoing the token.",
  },
  {
    command: "stockbit auth accounts [--json]",
    purpose: "List account names, expiration status, stores, and random-selection mode without exposing tokens.",
  },
  {
    command: "stockbit auth status [--json] [--bearer <token> | --account <name>]",
    purpose: "Select one account, validate authentication, and return its Stockbit profile.",
  },
  {
    command: "stockbit auth remove <account> [--local]",
    purpose: "Remove one named account from the global or current-directory credential file.",
  },
  {
    command: "stockbit auth clear [--local] [--account <name>]",
    purpose: "Remove one selected account, or the entire credential file when no account is selected.",
  },
  {
    command: "stockbit fundamental <symbol> [options]",
    purpose: "Fetch an income statement, balance sheet, or cash-flow report.",
    options: [
      "--report <income|balance|cashflow|1|2|3>",
      "--statement <name|1..13>",
      "--data-type <positive-integer>",
      "--view <json|raw|csv>",
      "--compact",
      "--bearer <token> (global option)",
      "--account <name> (global option; bypasses random selection)",
    ],
  },
  {
    command: "stockbit broker-summary <symbol> --from <date> [options]",
    purpose: "Fetch broker buy/sell rankings and market-detector analytics.",
    options: [
      "--from <YYYY-MM-DD> (required)",
      "--to <YYYY-MM-DD> (defaults to --from)",
      "--transaction <gross|net>",
      "--investor <all|domestic|foreign>",
      "--board <all|regular|cash|negotiated>",
      "--limit <positive-integer>",
      "--view <json|raw|csv>",
      "--compact",
      "--bearer <token> (global option)",
      "--account <name> (global option; bypasses random selection)",
    ],
  },
  {
    command: "stockbit price <symbol> --from <date> --to <date> [options]",
    purpose: "Fetch normalized or raw daily OHLCV price history.",
    options: [
      "--from <YYYY-MM-DD> (required; oldest date)",
      "--to <YYYY-MM-DD> (required; newest date)",
      "--limit <non-negative-integer> (0 requests all rows)",
      "--view <json|raw|csv>",
      "--compact",
      "--bearer <token> (global option)",
      "--account <name> (global option; bypasses random selection)",
    ],
  },
  {
    command: "stockbit help [all|commands|auth|fundamental|broker-summary|price|formats] [--json]",
    purpose: "Show this reference as readable text or structured JSON.",
  },
];

const FORMATS: HelpFormat[] = [
  {
    name: "json",
    media_type: "application/json",
    purpose: "Normalized financial, broker, or price data for agents and scripts.",
    shape: "Versioned envelope containing normalized data and request/parser metadata.",
  },
  {
    name: "raw",
    media_type: "application/json",
    purpose: "Original Stockbit response for debugging upstream changes.",
    shape: "Versioned envelope whose data contains the unchanged upstream response; fundamental data includes html_report.",
  },
  {
    name: "csv",
    media_type: "text/csv",
    purpose: "Spreadsheet export and tabular pipelines.",
    shape: "Header plus one row per account-period, broker-side record, or daily price bar, with request metadata repeated.",
  },
];

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

export function parseHelpTopic(value: string | undefined): HelpTopic {
  if (value === undefined || !value.trim()) {
    return "all";
  }
  const topic = TOPIC_ALIASES[normalizeTopic(value)];
  if (topic) {
    return topic;
  }
  throw new CliError(
    "INVALID_HELP_TOPIC",
    `Unknown help topic \`${value}\`. Expected \`all\`, \`commands\`, \`auth\`, \`fundamental\`, \`broker-summary\`, \`price\`, or \`formats\`.`,
    2,
  );
}

export function getAgentHelp(topic: HelpTopic = "all"): AgentHelpDocument {
  const document: AgentHelpDocument = {
    schema_version: "1",
    command: "stockbit",
    topic,
    summary: "Retrieve authorized Stockbit fundamentals, broker summaries, and price history without exposing credentials.",
    usage: [
      "stockbit help --json",
      "stockbit help <topic> --json",
      "stockbit <command> --help",
    ],
    documentation: {
      overview: "README.md",
      topic_help: "stockbit help <topic>",
      command_help: "stockbit <command> --help",
    },
    output_contract: {
      stdout: "Successful command data and help output.",
      stderr: "Errors formatted as CODE: message; credentials are never included.",
      exit_codes: {
        "0": "success",
        "1": "unexpected internal error",
        "2": "invalid command input",
        "3": "authentication or authorization failure",
        "4": "network, rate-limit, parsing, or upstream failure",
      },
    },
    agent_guidance: [
      "Run `stockbit auth status --json` before a protected request when authentication is uncertain.",
      "Use `stockbit auth accounts --json` to inspect account names and selection mode without exposing credentials.",
      "Prefer `--view json` for normalized data, financial reasoning, and exact metric lookup.",
      "Use `--view csv` for tabular export and `--view raw` only to inspect an unchanged upstream payload.",
      "Treat raw, IDR, and USD numeric fields as decimal strings to avoid precision loss.",
      "Match both the requested statement type and the returned period key before reporting a value.",
      "For broker summaries, distinguish gross side activity from signed net differences and check appears_on_both_sides.",
      "For prices, pass the oldest date to --from and newest date to --to; normalized bars are returned oldest-first.",
      "Treat normalized OHLCV fields as decimal strings to avoid precision loss.",
      "Never print, log, persist in source control, or return a bearer token or credentialStorage value.",
    ],
  };

  if (topic === "all" || topic === "commands") {
    document.commands = COMMANDS;
  }
  if (topic === "all" || topic === "auth") {
    document.authentication = {
      resolution_order: [
        "--bearer <token>",
        "--account <name> from a local or global credentials file",
        "STOCKBIT_BEARER_TOKEN",
        "a random account from ./credentials-stockbit.json",
        "a random account from ~/.config/stockbit-cli/credentials.json",
      ],
      storage: {
        global: "~/.config/stockbit-cli/credentials.json (directory 0700, file 0600)",
        local: "./credentials-stockbit.json (file 0600; must remain gitignored)",
      },
      login_steps: [
        "Log in to https://stockbit.com.",
        "Open Developer Tools > Application > Local Storage > https://stockbit.com.",
        "Copy credentialStorage and paste it into `stockbit auth login`.",
        "The account name defaults to the username inside the access token; pass `--account <name>` to choose it explicitly.",
        "After each interactive import, answer yes to import another account or press Enter/answer no to finish.",
        "When `--account <name>` is used with multiple imports, it names only the first account; later names come from their tokens.",
        "Non-interactive piped input remains a single import and does not prompt for another account.",
        "The CLI stores only the access and refresh tokens plus expiration metadata, not the full credentialStorage value or user profile.",
      ],
      multi_account: [
        "Each credential file can contain multiple named accounts; a login with the same name updates only that account.",
        "Each protected CLI invocation independently chooses one saved account using cryptographically secure random selection.",
        "Account selection is not persisted; legacy nextAccountIndex values are ignored and removed on the next credential write.",
        "The local credential file shadows the global file; accounts are not mixed across the two stores during random selection.",
        "Pass global `--account <name>` to select that saved account and bypass random selection.",
        "`stockbit auth status` randomly selects an account because it makes an authenticated request; `stockbit auth accounts` only inspects the pool.",
        "A failed, denied, or rate-limited request is not retried with another account.",
      ],
      automatic_refresh: [
        "Available only when auth login imported a refresh token into a local or global credentials file.",
        "Refresh before a request when the access token is expired or within 30 seconds of expiration.",
        "Refresh after the first HTTP 401 response when expiration was not known in advance.",
        "Persist access and refresh token rotation, then retry the original request once.",
        "Persist refreshed tokens only into the selected named account without changing other accounts.",
        "If Stockbit rejects the refresh token, stop and require `stockbit auth login` again.",
        "--bearer, STOCKBIT_BEARER_TOKEN, and auth set-token are access-only and do not borrow a stored refresh token.",
      ],
      safety: [
        "Prefer saved credentials or STOCKBIT_BEARER_TOKEN over --bearer because shell history may retain arguments.",
        "A refresh token is long-lived and sensitive; protect the credentials file and revoke exposed tokens immediately.",
        "Do not store credentials in temporary, shared, or version-controlled locations.",
        "Use only accounts you own or are authorized to automate; random selection must not be used to evade Stockbit limits or controls.",
      ],
    };
  }
  if (topic === "all" || topic === "fundamental") {
    document.fundamentals = {
      syntax: "stockbit fundamental <symbol> [--report <type>] [--statement <type>] [--data-type <n>] [--view <format>] [--compact]",
      defaults: {
        report: "income",
        statement: "quarterly",
        data_type: "1",
        view: "raw",
      },
      report_types: Object.entries(REPORT_TYPES).map(([name, value]) => ({
        name,
        value,
      })),
      statement_types: Object.entries(STATEMENT_TYPES).map(([name, value]) => ({
        name,
        value,
      })),
      examples: [
        "stockbit fundamental BBCA --report income --statement q2 --view json",
        "stockbit fundamental BBCA --report balance --statement annual --view csv > bbca-balance.csv",
        "stockbit fundamental JTPE --report cashflow --statement ttm --view raw --compact",
      ],
    };
  }
  if (topic === "all" || topic === "broker-summary") {
    document.broker_summary = {
      syntax: "stockbit broker-summary <symbol> --from <YYYY-MM-DD> [--to <YYYY-MM-DD>] [--transaction <gross|net>] [--investor <all|domestic|foreign>] [--board <all|regular|cash|negotiated>] [--limit <n>] [--view <json|raw|csv>] [--compact]",
      defaults: {
        to: "same as --from",
        transaction: "gross",
        investor: "all",
        board: "regular",
        limit: "25",
        view: "raw",
      },
      transaction_types: [
        {
          name: "gross",
          value: BROKER_TRANSACTION_TYPES.gross,
          semantics: "Buy and sell sides are ranked independently; the same broker may appear on both sides.",
        },
        {
          name: "net",
          value: BROKER_TRANSACTION_TYPES.net,
          semantics: "Each broker is ranked by its buy-minus-sell difference; sell lots and values may be negative.",
        },
      ],
      investor_types: Object.entries(BROKER_INVESTOR_TYPES).map(([name, value]) => ({
        name,
        value,
      })),
      market_boards: Object.entries(BROKER_MARKET_BOARDS).map(([name, value]) => ({
        name,
        value,
      })),
      response_notes: [
        "Buy and sell arrays may both be populated, only one may be populated, or both may be empty.",
        "An empty response for a valid market board is successful data, not an error.",
        "Gross brokers may overlap across sides; net brokers normally do not.",
        "Exact broker numeric fields remain decimal strings, including scientific notation and negative net sells.",
        "HTTP 429 is returned as RATE_LIMITED with exit code 4.",
      ],
      examples: [
        "stockbit broker-summary BBCA --from 2026-08-19 --transaction gross --investor all --board regular --view json",
        "stockbit broker-summary BBCA --from 2026-08-19 --transaction net --investor foreign --board all --view csv > bbca-net-foreign.csv",
        "stockbit broker-summary BBCA --from 2026-08-19 --to 2026-08-20 --board negotiated --view raw --compact",
      ],
    };
  }
  if (topic === "all" || topic === "price") {
    document.prices = {
      syntax: "stockbit price <symbol> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--limit <n>] [--view <json|raw|csv>] [--compact]",
      defaults: {
        limit: "0 (all rows returned by Stockbit)",
        view: "raw",
        interval: "daily",
      },
      date_semantics: [
        "CLI --from is the oldest requested date and --to is the newest requested date.",
        "Stockbit's private Chartbit endpoint reverses those query names; the CLI translates them automatically.",
        "Normalized json/csv bars are sorted oldest-first even though Stockbit returns newest-first.",
      ],
      response_notes: [
        "json returns normalized date, unix_timestamp, open, high, low, close, and volume fields.",
        "Normalized OHLCV values are decimal strings; unix_timestamp and count are numbers.",
        "A valid empty range returns count=0, empty=true, bars=[], and is not treated as an error.",
        "raw preserves Stockbit's data.chartbit response and its original newest-first ordering.",
        "CSV emits one row per daily bar and one metadata row for an empty response.",
      ],
      examples: [
        "stockbit price ERAA --from 2025-06-09 --to 2026-08-31 --view json",
        "stockbit price BBCA --from 2026-01-01 --to 2026-08-28 --view csv > bbca-prices.csv",
        "stockbit price ERAA --from 2026-08-01 --to 2026-08-28 --view raw --compact",
      ],
    };
  }
  if (topic === "all" || topic === "formats") {
    document.formats = FORMATS;
  }

  return document;
}

function renderList(title: string, values: string[]): string[] {
  return [title, ...values.map((value) => `  - ${value}`), ""];
}

export function renderAgentHelp(document: AgentHelpDocument): string {
  const lines = [
    "Stockbit CLI agent reference",
    document.summary,
    "",
    `Topic: ${document.topic}`,
    "Machine-readable reference: stockbit help --json",
    "Topic reference: stockbit help <topic> --json",
    "",
  ];

  if (document.commands) {
    lines.push("Commands");
    for (const command of document.commands) {
      lines.push(`  ${command.command}`, `    ${command.purpose}`);
      for (const option of command.options ?? []) {
        lines.push(`    - ${option}`);
      }
    }
    lines.push("");
  }

  if (document.authentication) {
    lines.push(
      ...renderList("Authentication precedence", document.authentication.resolution_order),
      ...renderList("Login", document.authentication.login_steps),
      ...renderList("Multiple accounts and random selection", document.authentication.multi_account),
      ...renderList("Automatic refresh", document.authentication.automatic_refresh),
      ...renderList("Credential safety", document.authentication.safety),
    );
  }

  if (document.fundamentals) {
    lines.push(
      "Fundamentals",
      `  Syntax: ${document.fundamentals.syntax}`,
      `  Defaults: ${Object.entries(document.fundamentals.defaults)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`,
      `  Reports: ${document.fundamentals.report_types
        .map(({ name, value }) => `${value}=${name}`)
        .join(", ")}`,
      `  Statements: ${document.fundamentals.statement_types
        .map(({ name, value }) => `${value}=${name}`)
        .join(", ")}`,
      ...renderList("Examples", document.fundamentals.examples),
    );
  }

  if (document.broker_summary) {
    lines.push(
      "Broker summary",
      `  Syntax: ${document.broker_summary.syntax}`,
      `  Defaults: ${Object.entries(document.broker_summary.defaults)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`,
      `  Transactions: ${document.broker_summary.transaction_types
        .map(({ name, value }) => `${name}=${value}`)
        .join(", ")}`,
      `  Investors: ${document.broker_summary.investor_types
        .map(({ name, value }) => `${name}=${value}`)
        .join(", ")}`,
      `  Boards: ${document.broker_summary.market_boards
        .map(({ name, value }) => `${name}=${value}`)
        .join(", ")}`,
      ...renderList("Response notes", document.broker_summary.response_notes),
      ...renderList("Examples", document.broker_summary.examples),
    );
  }

  if (document.prices) {
    lines.push(
      "Daily prices",
      `  Syntax: ${document.prices.syntax}`,
      `  Defaults: ${Object.entries(document.prices.defaults)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`,
      ...renderList("Date semantics", document.prices.date_semantics),
      ...renderList("Response notes", document.prices.response_notes),
      ...renderList("Examples", document.prices.examples),
    );
  }

  if (document.formats) {
    lines.push("Output formats");
    for (const format of document.formats) {
      lines.push(`  ${format.name} (${format.media_type})`, `    ${format.purpose}`, `    ${format.shape}`);
    }
    lines.push("");
  }

  lines.push(...renderList("Agent guidance", document.agent_guidance));
  return `${lines.join("\n").trimEnd()}\n`;
}
