#!/usr/bin/env node

import { Command } from "commander";

import {
  parseBrokerDate,
  parseBrokerInvestorType,
  parseBrokerLimit,
  parseBrokerMarketBoard,
  parseBrokerTransactionType,
  serializeBrokerSummaryCsv,
  validateBrokerDateRange,
} from "./broker-summary.js";
import {
  addCredentials,
  addLocalCredentials,
  clearLocalStoredBearerToken,
  clearStoredBearerToken,
  credentialsPath,
  getResolvedTokenStatus,
  listCredentialStores,
  localCredentialsPath,
  removeLocalStoredCredentialsAccount,
  removeStoredCredentialsAccount,
  readAddAnotherAccount,
  readBearerToken,
  readCredentialStorage,
  resolveCredentials,
  persistRefreshedCredentials,
  parseCredentialStorage,
  type ResolvedCredentials,
  type SavedCredentials,
  type TokenCredentials,
} from "./auth.js";
import { CliError } from "./errors.js";
import { serializeFundamentalCsv } from "./financial-csv.js";
import { getAgentHelp, parseHelpTopic, renderAgentHelp } from "./help.js";
import {
  parseDataType,
  parseFundamentalView,
  parseReportType,
  parseStatementType,
  StockbitClient,
} from "./fundamental.js";
import {
  parsePriceDate,
  parsePriceLimit,
  serializePriceCsv,
  validatePriceDateRange,
} from "./price.js";

const program = new Command();

program.configureHelp({ showGlobalOptions: true });
program.addHelpCommand(false);

program
  .name("stockbit")
  .description("Retrieve authorized Stockbit financial and market data from the command line.")
  .version("0.1.0")
  .option(
    "--bearer <token>",
    "Use a bearer token for this invocation instead of environment or saved credentials.",
  )
  .option(
    "--account <name>",
    "Select a saved account, or name one for auth login/set-token; otherwise selection is random.",
  )
  .showHelpAfterError();

const auth = program.command("auth").description("Manage Stockbit authentication credentials.");

async function saveToken(
  credentials: TokenCredentials,
  local: boolean | undefined,
  account: string | undefined,
  warnAboutLocalFile = true,
): Promise<SavedCredentials> {
  const saved = local
    ? await addLocalCredentials(credentials, process.cwd(), account)
    : await addCredentials(credentials, process.env, account);
  if (local && warnAboutLocalFile) {
    process.stdout.write(
      "Warning: add credentials-stockbit.json to this project's .gitignore.\n",
    );
  }
  return saved;
}

interface AuthenticationOptions {
  bearer?: string | undefined;
  account?: string | undefined;
}

interface AuthenticatedSession {
  client: StockbitClient;
  credentials: () => ResolvedCredentials;
}

function authenticationOptions(): AuthenticationOptions {
  return program.opts<{ bearer?: string; account?: string }>();
}

async function authenticatedSession(
  options: AuthenticationOptions,
): Promise<AuthenticatedSession> {
  let credentials = await resolveCredentials(options);
  const client = new StockbitClient({
    token: credentials.accessToken,
    ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
    ...(credentials.accessExpiresAt
      ? { accessExpiresAt: credentials.accessExpiresAt }
      : {}),
    ...(credentials.credentialsPath
      ? {
          onCredentialsRefreshed: async (refreshed) => {
            await persistRefreshedCredentials(credentials, refreshed);
            credentials = { ...credentials, ...refreshed };
          },
        }
      : {}),
  });
  return { client, credentials: () => credentials };
}

async function authenticatedClient(
  options: AuthenticationOptions,
): Promise<StockbitClient> {
  return (await authenticatedSession(options)).client;
}

auth
  .command("login")
  .description("Import one or more accounts from Stockbit credentialStorage.")
  .option("--local", "Save credentials-stockbit.json in the current directory.")
  .action(async (options: { local?: boolean }, command: Command) => {
    process.stdout.write(
      [
        "1. Log in at https://stockbit.com in your browser.",
        "2. Open Developer Tools → Application → Local Storage → https://stockbit.com.",
        "3. Copy the value for credentialStorage, then paste it below.",
        "The value is read locally, is not echoed, and only its access/refresh tokens are stored.",
        "",
      ].join("\n"),
    );
    const requestedAccount = command.optsWithGlobals<AuthenticationOptions>().account;
    let importedAccounts = 0;
    while (true) {
      const value = await readCredentialStorage();
      const parsed = parseCredentialStorage(value);
      const saved = await saveToken(
        parsed,
        options.local,
        importedAccounts === 0 ? requestedAccount : undefined,
        importedAccounts === 0,
      );
      importedAccounts += 1;
      process.stdout.write(
        `Credentials saved to ${saved.path} as account ${saved.account} with user-only permissions.\n`,
      );
      process.stdout.write(`Stored accounts in this file: ${saved.accountCount}.\n`);
      if (parsed.accessExpiresAt) {
        process.stdout.write(`Access token expires at: ${parsed.accessExpiresAt}\n`);
      }
      if (parsed.refreshToken) {
        process.stdout.write("Automatic access-token refresh is enabled.\n");
      } else {
        process.stdout.write(
          "No refresh token was found; run auth login again when the access token expires.\n",
        );
      }
      if (parsed.refreshExpiresAt) {
        process.stdout.write(`Refresh token expires at: ${parsed.refreshExpiresAt}\n`);
      }
      if (!(await readAddAnotherAccount())) {
        break;
      }
      process.stdout.write(
        "Log in as the next Stockbit account, then copy and paste its credentialStorage value.\n",
      );
      if (requestedAccount && importedAccounts === 1) {
        process.stdout.write(
          "The explicit --account name applied to the first import; the next name will come from its token.\n",
        );
      }
    }
    if (importedAccounts > 1) {
      process.stdout.write(`Imported ${importedAccounts} accounts.\n`);
    }
  });

auth
  .command("set-token")
  .description("Store an access token without automatic refresh.")
  .option("--local", "Save credentials-stockbit.json in the current directory.")
  .action(async (options: { local?: boolean }, command: Command) => {
    const token = await readBearerToken();
    const account = command.optsWithGlobals<AuthenticationOptions>().account;
    const saved = await saveToken(
      { accessToken: token },
      options.local,
      account,
    );
    process.stdout.write(
      `Bearer token saved to ${saved.path} as account ${saved.account} with user-only permissions.\n`,
    );
    process.stdout.write(`Stored accounts in this file: ${saved.accountCount}.\n`);
  });

auth
  .command("accounts")
  .alias("list")
  .description("List saved accounts and their selection mode without tokens.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: { json?: boolean }) => {
    const stores = await listCredentialStores();
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: "1",
            active_source: stores.find(({ active }) => active)?.source ?? null,
            stores: stores.map((store) => ({
              source: store.source,
              path: store.path,
              active: store.active,
              account_count: store.accountCount,
              selection_mode: store.selectionMode,
              // Kept for consumers of the original round-robin schema.
              next_account: store.nextAccount,
              accounts: store.accounts.map((account) => ({
                name: account.name,
                next: account.next,
                ...(account.accessExpiresAt
                  ? { access_expires_at: account.accessExpiresAt }
                  : {}),
                ...(account.accessExpired !== undefined
                  ? { access_expired: account.accessExpired }
                  : {}),
                refresh_configured: account.refreshConfigured,
                ...(account.refreshExpiresAt
                  ? { refresh_expires_at: account.refreshExpiresAt }
                  : {}),
                ...(account.refreshExpired !== undefined
                  ? { refresh_expired: account.refreshExpired }
                  : {}),
              })),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (stores.length === 0) {
      process.stdout.write("No saved Stockbit accounts were found.\n");
      return;
    }
    for (const store of stores) {
      process.stdout.write(
        `${store.active ? "Active" : "Inactive"} ${store.source} (${store.selectionMode} selection): ${store.path}\n`,
      );
      for (const account of store.accounts) {
        process.stdout.write(
          `  - ${account.name}${account.refreshConfigured ? " (refresh enabled)" : ""}\n`,
        );
      }
    }
  });

auth
  .command("status")
  .description("Validate authentication, refreshing if needed, and return the profile.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: { json?: boolean }, command: Command) => {
    const selection = command.optsWithGlobals<AuthenticationOptions>();
    let session: AuthenticatedSession;
    try {
      session = await authenticatedSession(selection);
    } catch (error) {
      if (error instanceof CliError && error.code === "AUTH_REQUIRED") {
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ configured: false, authenticated: false }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write("No bearer token is configured.\n");
        return;
      }
      throw error;
    }

    const profile = await session.client.userProfile();
    const currentStatus = getResolvedTokenStatus(session.credentials());
    const result = {
      schema_version: "1",
      configured: true,
      authenticated: true,
      source: currentStatus.source,
      ...(currentStatus.account ? { account: currentStatus.account } : {}),
      ...(currentStatus.accountCount !== undefined
        ? { account_count: currentStatus.accountCount }
        : {}),
      ...(currentStatus.selectionMode
        ? {
            selection_mode: currentStatus.selectionMode,
            random_selection: currentStatus.selectionMode === "random",
          }
        : {}),
      // Kept for consumers of the original round-robin status schema.
      ...(currentStatus.roundRobin !== undefined
        ? { round_robin: currentStatus.roundRobin }
        : {}),
      ...(currentStatus.expiresAt ? { expires_at: currentStatus.expiresAt } : {}),
      ...(currentStatus.expired !== undefined ? { expired: currentStatus.expired } : {}),
      refresh_configured: currentStatus.refreshConfigured ?? false,
      ...(currentStatus.refreshExpiresAt
        ? { refresh_expires_at: currentStatus.refreshExpiresAt }
        : {}),
      ...(currentStatus.refreshExpired !== undefined
        ? { refresh_expired: currentStatus.refreshExpired }
        : {}),
      profile: profile.data,
      meta: profile.meta,
    };

    if (!options.json) {
      process.stdout.write(
        `Authenticated via ${currentStatus.source}${currentStatus.account ? ` (account ${currentStatus.account})` : ""}.\n`,
      );
      if (currentStatus.selectionMode) {
        process.stdout.write(`Account selection: ${currentStatus.selectionMode}.\n`);
      }
      if (currentStatus.expiresAt) {
        process.stdout.write(
          `Access token expires at: ${currentStatus.expiresAt}${currentStatus.expired ? " (expired)" : ""}\n`,
        );
      }
      process.stdout.write(
        `Automatic refresh: ${currentStatus.refreshConfigured ? "configured" : "not configured"}.\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

auth
  .command("remove")
  .description("Remove one named account from a saved credential file.")
  .argument("<account>", "Saved account name.")
  .option("--local", "Remove it from credentials-stockbit.json in this directory.")
  .action(async (account: string, options: { local?: boolean }) => {
    const result = options.local
      ? await removeLocalStoredCredentialsAccount(account)
      : await removeStoredCredentialsAccount(account);
    process.stdout.write(
      result.removed
        ? `Removed account ${result.account} from ${result.path}. ${result.accountCount} account(s) remain.\n`
        : `No account named ${result.account} was found at ${result.path}.\n`,
    );
  });

auth
  .command("clear")
  .description("Remove stored access and refresh credentials.")
  .option("--local", "Remove credentials-stockbit.json from the current directory.")
  .action(async (options: { local?: boolean }, command: Command) => {
    const account = command.optsWithGlobals<AuthenticationOptions>().account;
    if (account) {
      const result = options.local
        ? await removeLocalStoredCredentialsAccount(account)
        : await removeStoredCredentialsAccount(account);
      process.stdout.write(
        result.removed
          ? `Removed account ${result.account} from ${result.path}. ${result.accountCount} account(s) remain.\n`
          : `No account named ${result.account} was found at ${result.path}.\n`,
      );
      return;
    }
    const removed = options.local
      ? await clearLocalStoredBearerToken()
      : await clearStoredBearerToken();
    const path = options.local ? localCredentialsPath() : credentialsPath();
    process.stdout.write(
      removed
        ? `Removed the stored credentials from ${path}.\n`
        : `No stored credentials were found at ${path}.\n`,
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
  .option("--view <format>", "Response format: json|raw|csv", "raw")
  .option("--compact", "Print compact JSON for json/raw views.")
  .action(
    async (
      symbol: string,
      options: {
        report: string;
        statement: string;
        dataType: string;
        view: string;
        compact?: boolean;
      },
    ) => {
      const client = await authenticatedClient(authenticationOptions());
      const view = parseFundamentalView(options.view);
      const result = await client.fundamental({
        symbol,
        dataType: parseDataType(options.dataType),
        reportType: parseReportType(options.report),
        statementType: parseStatementType(options.statement),
        view,
      });

      if (result.view === "csv") {
        process.stdout.write(`${serializeFundamentalCsv(result)}\n`);
        return;
      }

      process.stdout.write(
        `${JSON.stringify(result, null, options.compact ? undefined : 2)}\n`,
      );
    },
  );

program
  .command("broker-summary")
  .alias("brokers")
  .description("Fetch broker buy/sell rankings and market-detector analytics.")
  .argument("<symbol>", "Ticker symbol, for example BBCA")
  .requiredOption("--from <date>", "Start date in YYYY-MM-DD format.")
  .option("--to <date>", "End date in YYYY-MM-DD format; defaults to --from.")
  .option("-t, --transaction <type>", "Transaction: gross|net", "gross")
  .option("-i, --investor <type>", "Investor: all|domestic|foreign", "all")
  .option("-b, --board <type>", "Market board: all|regular|cash|negotiated", "regular")
  .option("-l, --limit <number>", "Maximum brokers returned per side.", "25")
  .option("--view <format>", "Response format: json|raw|csv", "raw")
  .option("--compact", "Print compact JSON for json/raw views.")
  .action(
    async (
      symbol: string,
      options: {
        from: string;
        to?: string;
        transaction: string;
        investor: string;
        board: string;
        limit: string;
        view: string;
        compact?: boolean;
      },
    ) => {
      const from = parseBrokerDate(options.from, "from");
      const to = parseBrokerDate(options.to ?? options.from, "to");
      validateBrokerDateRange(from, to);
      const client = await authenticatedClient(authenticationOptions());
      const result = await client.brokerSummary({
        symbol,
        from,
        to,
        transactionType: parseBrokerTransactionType(options.transaction),
        investorType: parseBrokerInvestorType(options.investor),
        marketBoard: parseBrokerMarketBoard(options.board),
        limit: parseBrokerLimit(options.limit),
        view: parseFundamentalView(options.view),
      });

      if (result.view === "csv") {
        process.stdout.write(`${serializeBrokerSummaryCsv(result)}\n`);
        return;
      }
      process.stdout.write(
        `${JSON.stringify(result, null, options.compact ? undefined : 2)}\n`,
      );
    },
  );

program
  .command("price")
  .alias("prices")
  .description("Fetch daily OHLCV price history.")
  .argument("<symbol>", "Ticker symbol, for example ERAA")
  .requiredOption("--from <date>", "Oldest date in YYYY-MM-DD format.")
  .requiredOption("--to <date>", "Newest date in YYYY-MM-DD format.")
  .option("-l, --limit <number>", "Maximum rows; 0 requests all rows.", "0")
  .option("--view <format>", "Response format: json|raw|csv", "raw")
  .option("--compact", "Print compact JSON for json/raw views.")
  .action(
    async (
      symbol: string,
      options: {
        from: string;
        to: string;
        limit: string;
        view: string;
        compact?: boolean;
      },
    ) => {
      const from = parsePriceDate(options.from, "from");
      const to = parsePriceDate(options.to, "to");
      validatePriceDateRange(from, to);
      const client = await authenticatedClient(authenticationOptions());
      const result = await client.price({
        symbol,
        from,
        to,
        limit: parsePriceLimit(options.limit),
        view: parseFundamentalView(options.view),
      });

      if (result.view === "csv") {
        process.stdout.write(`${serializePriceCsv(result)}\n`);
        return;
      }
      process.stdout.write(
        `${JSON.stringify(result, null, options.compact ? undefined : 2)}\n`,
      );
    },
  );

program
  .command("help")
  .description("Show the command reference for humans or AI agents.")
  .argument(
    "[topic]",
    "Topic: all|commands|auth|fundamental|broker-summary|price|formats",
    "all",
  )
  .option("--json", "Print a structured, machine-readable help document.")
  .action((topic: string, options: { json?: boolean }) => {
    const document = getAgentHelp(parseHelpTopic(topic));
    process.stdout.write(
      options.json
        ? `${JSON.stringify(document, null, 2)}\n`
        : renderAgentHelp(document),
    );
  });

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
