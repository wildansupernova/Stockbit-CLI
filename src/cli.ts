#!/usr/bin/env node

import { Command } from "commander";

import {
  clearLocalStoredBearerToken,
  clearStoredBearerToken,
  credentialsPath,
  getTokenStatus,
  localCredentialsPath,
  readBearerToken,
  readCredentialStorage,
  resolveBearerToken,
  saveBearerToken,
  saveLocalBearerToken,
  parseCredentialStorage,
} from "./auth.js";
import { CliError } from "./errors.js";
import {
  parseDataType,
  parseReportType,
  parseStatementType,
  StockbitClient,
} from "./fundamental.js";

const program = new Command();

program.configureHelp({ showGlobalOptions: true });

program
  .name("stockbit")
  .description("Retrieve authorized Stockbit financial data from the command line.")
  .version("0.1.0")
  .option(
    "--bearer <token>",
    "Use a bearer token for this invocation instead of environment or saved credentials.",
  )
  .showHelpAfterError();

const auth = program.command("auth").description("Manage the Stockbit bearer token.");

async function saveToken(token: string, local: boolean | undefined): Promise<string> {
  const path = local
    ? await saveLocalBearerToken(token)
    : await saveBearerToken(token);
  if (local) {
    process.stdout.write(
      "Warning: add credentials-stockbit.json to this project's .gitignore.\n",
    );
  }
  return path;
}

auth
  .command("login")
  .description("Import the access token from Stockbit credentialStorage.")
  .option("--local", "Save credentials-stockbit.json in the current directory.")
  .action(async (options: { local?: boolean }) => {
    process.stdout.write(
      [
        "1. Log in at https://stockbit.com in your browser.",
        "2. Open Developer Tools → Application → Local Storage → https://stockbit.com.",
        "3. Copy the value for credentialStorage, then paste it below.",
        "The value is read locally, is not echoed, and the refresh token is not stored.",
        "",
      ].join("\n"),
    );
    const value = await readCredentialStorage();
    const parsed = parseCredentialStorage(value);
    const path = await saveToken(parsed.token, options.local);
    process.stdout.write(`Access token saved to ${path} with user-only permissions.\n`);
    if (parsed.expiresAt) {
      process.stdout.write(`Access token expires at: ${parsed.expiresAt}\n`);
    }
  });

auth
  .command("set-token")
  .description("Read a bearer token without echoing it and store it for later use.")
  .option("--local", "Save credentials-stockbit.json in the current directory.")
  .action(async (options: { local?: boolean }) => {
    const token = await readBearerToken();
    const path = await saveToken(token, options.local);
    process.stdout.write(`Bearer token saved to ${path} with user-only permissions.\n`);
  });

auth
  .command("status")
  .description("Validate the configured token and return the current Stockbit profile.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: { json?: boolean }, command: Command) => {
    const bearer = command.optsWithGlobals<{ bearer?: string }>().bearer;
    const status = await getTokenStatus({ bearer });
    if (options.json) {
      if (!status.configured) {
        process.stdout.write(
          `${JSON.stringify({ configured: false, authenticated: false }, null, 2)}\n`,
        );
        return;
      }
    } else if (!status.configured) {
      process.stdout.write("No bearer token is configured.\n");
      return;
    }

    const resolved = await resolveBearerToken({ bearer });
    const profile = await new StockbitClient({ token: resolved.token }).userProfile();
    const result = {
      schema_version: "1",
      configured: true,
      authenticated: true,
      source: status.source,
      ...(status.expiresAt ? { expires_at: status.expiresAt } : {}),
      ...(status.expired !== undefined ? { expired: status.expired } : {}),
      profile: profile.data,
      meta: profile.meta,
    };

    if (!options.json) {
      process.stdout.write(`Authenticated via ${status.source}.\n`);
      if (status.expiresAt) {
        process.stdout.write(
          `Token expires at: ${status.expiresAt}${status.expired ? " (expired)" : ""}\n`,
        );
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

auth
  .command("clear")
  .description("Remove a stored bearer token.")
  .option("--local", "Remove credentials-stockbit.json from the current directory.")
  .action(async (options: { local?: boolean }) => {
    const removed = options.local
      ? await clearLocalStoredBearerToken()
      : await clearStoredBearerToken();
    const path = options.local ? localCredentialsPath() : credentialsPath();
    process.stdout.write(
      removed
        ? `Removed the stored token from ${path}.\n`
        : `No stored bearer token was found at ${path}.\n`,
    );
    if (process.env.STOCKBIT_BEARER_TOKEN) {
      process.stdout.write("STOCKBIT_BEARER_TOKEN is still set in the environment.\n");
    }
  });

program
  .command("fundamental")
  .alias("fundamentals")
  .description("Fetch a company's financial statement data.")
  .argument("<symbol>", "Ticker symbol, for example JTPE")
  .option(
    "-r, --report <type>",
    "Report: income|balance|cashflow or 1|2|3",
    "income",
  )
  .option(
    "-s, --statement <type>",
    "Statement period: quarterly|annual|ttm|interim-ytd|q1|q2|q3|q4|qoq-growth|quarter-yoy-growth|ytd-yoy-growth|annual-yoy-growth|3-year-cagr, or 1..13",
    "quarterly",
  )
  .option("--data-type <number>", "Stockbit data type", "1")
  .option("--compact", "Print compact JSON instead of pretty JSON.")
  .action(
    async (
      symbol: string,
      options: {
        report: string;
        statement: string;
        dataType: string;
        compact?: boolean;
      },
    ) => {
      const bearer = program.opts<{ bearer?: string }>().bearer;
      const { token } = await resolveBearerToken({ bearer });
      const client = new StockbitClient({ token });
      const result = await client.fundamental({
        symbol,
        dataType: parseDataType(options.dataType),
        reportType: parseReportType(options.report),
        statementType: parseStatementType(options.statement),
      });

      process.stdout.write(
        `${JSON.stringify(result, null, options.compact ? undefined : 2)}\n`,
      );
    },
  );

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`UNEXPECTED_ERROR: ${message}\n`);
  process.exitCode = 1;
});
