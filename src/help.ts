import { CliError } from "./errors.js";
import { REPORT_TYPES, STATEMENT_TYPES } from "./fundamental.js";

export type HelpTopic = "all" | "commands" | "auth" | "fundamental" | "formats";

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
  format: "formats",
  formats: "formats",
  view: "formats",
  views: "formats",
};

const COMMANDS: HelpCommand[] = [
  {
    command: "stockbit auth login [--local]",
    purpose: "Import access and refresh tokens from an interactively pasted credentialStorage value.",
  },
  {
    command: "stockbit auth set-token [--local]",
    purpose: "Interactively store an access token without echoing it; automatic refresh is unavailable.",
  },
  {
    command: "stockbit auth status [--json] [--bearer <token>]",
    purpose: "Validate authentication and return the current Stockbit profile.",
  },
  {
    command: "stockbit auth clear [--local]",
    purpose: "Remove the global or current-directory credential file.",
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
    ],
  },
  {
    command: "stockbit help [all|commands|auth|fundamental|formats] [--json]",
    purpose: "Show this reference as readable text or structured JSON.",
  },
];

const FORMATS: HelpFormat[] = [
  {
    name: "json",
    media_type: "application/json",
    purpose: "Normalized financial tables for agents, scripts, and metric lookup.",
    shape: "Versioned envelope containing parsed tables, periods, rows, exact values, and metadata.",
  },
  {
    name: "raw",
    media_type: "application/json",
    purpose: "Original Stockbit response for debugging upstream changes.",
    shape: "Versioned envelope whose data contains the upstream response and html_report.",
  },
  {
    name: "csv",
    media_type: "text/csv",
    purpose: "Spreadsheet export and tabular pipelines.",
    shape: "Header plus one row per account-period value, with metadata repeated on each row.",
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
    `Unknown help topic \`${value}\`. Expected \`all\`, \`commands\`, \`auth\`, \`fundamental\`, or \`formats\`.`,
    2,
  );
}

export function getAgentHelp(topic: HelpTopic = "all"): AgentHelpDocument {
  const document: AgentHelpDocument = {
    schema_version: "1",
    command: "stockbit",
    topic,
    summary: "Retrieve authorized Stockbit fundamentals without exposing credentials.",
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
      "Prefer `--view json` for financial reasoning and exact metric lookup.",
      "Use `--view csv` for tabular export and `--view raw` only to inspect upstream HTML.",
      "Treat raw, IDR, and USD numeric fields as decimal strings to avoid precision loss.",
      "Match both the requested statement type and the returned period key before reporting a value.",
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
        "STOCKBIT_BEARER_TOKEN",
        "./credentials-stockbit.json",
        "~/.config/stockbit-cli/credentials.json",
      ],
      storage: {
        global: "~/.config/stockbit-cli/credentials.json (directory 0700, file 0600)",
        local: "./credentials-stockbit.json (file 0600; must remain gitignored)",
      },
      login_steps: [
        "Log in to https://stockbit.com.",
        "Open Developer Tools > Application > Local Storage > https://stockbit.com.",
        "Copy credentialStorage and paste it into `stockbit auth login`.",
        "The CLI stores only the access and refresh tokens plus expiration metadata, not the full credentialStorage value or user profile.",
      ],
      automatic_refresh: [
        "Available only when auth login imported a refresh token into a local or global credentials file.",
        "Refresh before a request when the access token is expired or within 30 seconds of expiration.",
        "Refresh after the first HTTP 401 response when expiration was not known in advance.",
        "Persist access and refresh token rotation, then retry the original request once.",
        "If Stockbit rejects the refresh token, stop and require `stockbit auth login` again.",
        "--bearer, STOCKBIT_BEARER_TOKEN, and auth set-token are access-only and do not borrow a stored refresh token.",
      ],
      safety: [
        "Prefer saved credentials or STOCKBIT_BEARER_TOKEN over --bearer because shell history may retain arguments.",
        "A refresh token is long-lived and sensitive; protect the credentials file and revoke exposed tokens immediately.",
        "Do not store credentials in temporary, shared, or version-controlled locations.",
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
