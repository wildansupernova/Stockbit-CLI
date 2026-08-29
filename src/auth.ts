import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { randomInt, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

import { CliError } from "./errors.js";

const TOKEN_ENVIRONMENT_VARIABLE = "STOCKBIT_BEARER_TOKEN";
const CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE = "STOCKBIT_CONFIG_DIR";
const LOCAL_CREDENTIALS_FILENAME = "credentials-stockbit.json";

interface CredentialsFile {
  schemaVersion?: unknown;
  accounts?: unknown;
  nextAccountIndex?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  accessExpiresAt?: unknown;
  refreshExpiresAt?: unknown;
  bearerToken?: unknown;
}

interface StoredCredentialsAccountFile extends CredentialsFile {
  name?: unknown;
}

interface StoredCredentialsAccount extends TokenCredentials {
  name: string;
}

interface CredentialsStore {
  accounts: StoredCredentialsAccount[];
}

interface CredentialStorageValue {
  state?: {
    access?: {
      token?: unknown;
      expired_at?: unknown;
    };
    refresh?: {
      token?: unknown;
      expired_at?: unknown;
    };
  };
}

export interface TokenCredentials {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}

type StoredTokenSource = "local-credentials-file" | "credentials-file";

export interface ResolvedCredentials extends TokenCredentials {
  source:
    | "command-line"
    | "environment"
    | StoredTokenSource;
  credentialsPath?: string;
  account?: string;
  accountCount?: number;
  selectionMode?: "explicit" | "random" | "single";
  /** @deprecated Random selection replaced round robin. */
  roundRobin?: boolean;
}

export interface ResolvedToken {
  token: string;
  source:
    | "command-line"
    | "environment"
    | "local-credentials-file"
    | "credentials-file";
}

export interface TokenStatus {
  configured: boolean;
  source?: ResolvedToken["source"];
  account?: string;
  accountCount?: number;
  selectionMode?: "explicit" | "random" | "single";
  /** @deprecated Random selection replaced round robin. */
  roundRobin?: boolean;
  expiresAt?: string;
  expired?: boolean;
  refreshConfigured?: boolean;
  refreshExpiresAt?: string;
  refreshExpired?: boolean;
}

export type ParsedCredentialStorage = TokenCredentials;

export interface ResolveTokenOptions {
  bearer?: string | undefined;
  account?: string | undefined;
  /** @deprecated Selection no longer mutates a persisted cursor. */
  rotate?: boolean | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
}

export interface SavedCredentials {
  path: string;
  account: string;
  accountCount: number;
}

export interface CredentialAccountStatus {
  name: string;
  accessExpiresAt?: string;
  accessExpired?: boolean;
  refreshConfigured: boolean;
  refreshExpiresAt?: string;
  refreshExpired?: boolean;
  next: boolean;
}

export interface CredentialStoreStatus {
  source: StoredTokenSource;
  path: string;
  active: boolean;
  accountCount: number;
  selectionMode: "random" | "single";
  /** @deprecated Random selection has no predictable next account. */
  nextAccount: string | null;
  accounts: CredentialAccountStatus[];
}

export interface RemovedCredentialsAccount {
  path: string;
  account: string;
  removed: boolean;
  accountCount: number;
}

function configDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE]?.trim();
  if (override) {
    return override;
  }

  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return join(xdgConfigHome, "stockbit-cli");
  }

  return join(homedir(), ".config", "stockbit-cli");
}

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(environment), "credentials.json");
}

export function localCredentialsPath(cwd: string = process.cwd()): string {
  return resolve(cwd, LOCAL_CREDENTIALS_FILENAME);
}

export function normalizeBearerToken(value: string): string {
  const token = value.trim().replace(/^Bearer\s+/i, "");

  if (!token) {
    throw new CliError("TOKEN_EMPTY", "The bearer token cannot be empty.", 2);
  }

  if (/[\r\n]/u.test(token)) {
    throw new CliError("TOKEN_INVALID", "The bearer token must be a single line.", 2);
  }

  return token;
}

function decodeCredentialStorageValue(value: string): string {
  let decoded = value.trim();

  if (!decoded) {
    throw new CliError(
      "CREDENTIAL_STORAGE_EMPTY",
      "The credentialStorage value cannot be empty.",
      2,
    );
  }

  for (let attempt = 0; attempt < 2 && decoded.includes("%"); attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      throw new CliError(
        "CREDENTIAL_STORAGE_INVALID",
        "The credentialStorage value contains invalid URL encoding.",
        2,
      );
    }
  }

  return decoded;
}

function normalizedExpiration(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const expiration = new Date(value);
  return Number.isNaN(expiration.getTime()) ? undefined : expiration.toISOString();
}

export function parseCredentialStorage(value: string): ParsedCredentialStorage {
  let decoded = decodeCredentialStorageValue(value);

  try {
    const possibleString = JSON.parse(decoded) as unknown;
    if (typeof possibleString === "string") {
      decoded = decodeCredentialStorageValue(possibleString);
    }
  } catch {
    // The normal credentialStorage representation is an object, not a JSON string.
  }

  let parsed: CredentialStorageValue;
  try {
    parsed = JSON.parse(decoded) as CredentialStorageValue;
  } catch (error) {
    throw new CliError(
      "CREDENTIAL_STORAGE_INVALID",
      "The credentialStorage value is not valid encoded JSON.",
      2,
      { cause: error },
    );
  }

  const access = parsed.state?.access;
  if (!access || typeof access.token !== "string") {
    throw new CliError(
      "CREDENTIAL_STORAGE_INVALID",
      "The credentialStorage value does not contain state.access.token.",
      2,
    );
  }

  const result: ParsedCredentialStorage = {
    accessToken: normalizeBearerToken(access.token),
  };
  const accessExpiresAt = normalizedExpiration(access.expired_at);
  if (accessExpiresAt) {
    result.accessExpiresAt = accessExpiresAt;
  }

  const refresh = parsed.state?.refresh;
  if (refresh && typeof refresh.token === "string" && refresh.token.trim()) {
    result.refreshToken = normalizeBearerToken(refresh.token);
    const refreshExpiresAt = normalizedExpiration(refresh.expired_at);
    if (refreshExpiresAt) {
      result.refreshExpiresAt = refreshExpiresAt;
    }
  }

  return result;
}

function normalizeTokenCredentials(credentials: TokenCredentials): TokenCredentials {
  const normalized: TokenCredentials = {
    accessToken: normalizeBearerToken(credentials.accessToken),
  };
  if (credentials.refreshToken?.trim()) {
    normalized.refreshToken = normalizeBearerToken(credentials.refreshToken);
  }
  const accessExpiresAt = normalizedExpiration(credentials.accessExpiresAt);
  if (accessExpiresAt) {
    normalized.accessExpiresAt = accessExpiresAt;
  }
  const refreshExpiresAt = normalizedExpiration(credentials.refreshExpiresAt);
  if (refreshExpiresAt) {
    normalized.refreshExpiresAt = refreshExpiresAt;
  }
  return normalized;
}

function parseTokenCredentialsFile(
  credentials: CredentialsFile,
): TokenCredentials | undefined {
  const accessToken =
    typeof credentials.accessToken === "string"
      ? credentials.accessToken
      : typeof credentials.bearerToken === "string"
        ? credentials.bearerToken
        : undefined;
  if (!accessToken) {
    return undefined;
  }

  return normalizeTokenCredentials({
    accessToken,
    ...(typeof credentials.refreshToken === "string"
      ? { refreshToken: credentials.refreshToken }
      : {}),
    ...(typeof credentials.accessExpiresAt === "string"
      ? { accessExpiresAt: credentials.accessExpiresAt }
      : {}),
    ...(typeof credentials.refreshExpiresAt === "string"
      ? { refreshExpiresAt: credentials.refreshExpiresAt }
      : {}),
  });
}

export function normalizeAccountName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(name)) {
    throw new CliError(
      "INVALID_ACCOUNT",
      "Account names must be 1-64 characters using letters, numbers, periods, underscores, @, or hyphens.",
      2,
    );
  }
  return name;
}

function jwtAccountName(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      data?: { use?: unknown; uid?: unknown };
    };
    const candidates = [
      typeof decoded.data?.use === "string" ? decoded.data.use : undefined,
      typeof decoded.sub === "string" ? decoded.sub : undefined,
      typeof decoded.data?.uid === "number" ? `uid-${decoded.data.uid}` : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate?.trim()) {
        continue;
      }
      try {
        return normalizeAccountName(candidate);
      } catch {
        // Try the next stable identifier from the token.
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function suggestedAccountName(credentials: TokenCredentials): string {
  const tokenName = jwtAccountName(credentials.accessToken);
  if (tokenName) {
    return tokenName;
  }
  return "default";
}

function parseCredentialsStore(credentials: CredentialsFile): CredentialsStore {
  if (Array.isArray(credentials.accounts)) {
    const accounts = credentials.accounts.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new CliError(
          "CREDENTIALS_INVALID",
          `Stored account ${index + 1} is not an object.`,
          2,
        );
      }
      const account = value as StoredCredentialsAccountFile;
      if (typeof account.name !== "string") {
        throw new CliError(
          "CREDENTIALS_INVALID",
          `Stored account ${index + 1} has no valid name.`,
          2,
        );
      }
      const parsed = parseTokenCredentialsFile(account);
      if (!parsed) {
        throw new CliError(
          "CREDENTIALS_INVALID",
          `Stored account ${account.name} has no access token.`,
          2,
        );
      }
      return {
        name: normalizeAccountName(account.name),
        ...parsed,
      };
    });
    const names = new Set<string>();
    for (const account of accounts) {
      const key = account.name.toLowerCase();
      if (names.has(key)) {
        throw new CliError(
          "CREDENTIALS_INVALID",
          `The credentials file contains duplicate account name ${account.name}.`,
          2,
        );
      }
      names.add(key);
    }
    return { accounts };
  }

  const legacy = parseTokenCredentialsFile(credentials);
  if (!legacy) {
    return { accounts: [] };
  }
  return {
    accounts: [
      {
        name: suggestedAccountName(legacy),
        ...legacy,
      },
    ],
  };
}

async function readCredentialsStoreAtPath(
  path: string,
): Promise<CredentialsStore | undefined> {
  try {
    const contents = await readFile(path, "utf8");
    const credentials = JSON.parse(contents) as CredentialsFile;
    return parseCredentialsStore(credentials);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(
        "CREDENTIALS_INVALID",
        `The credentials file at ${path} is not valid JSON.`,
        2,
        { cause: error },
      );
    }
    throw error;
  }
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function withCredentialsLock<Value>(
  path: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const lockPath = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const lock = await lstat(lockPath);
        if (Date.now() - lock.mtimeMs > 30_000) {
          await rmdir(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lockError;
        }
      }
      await pause(20);
    }
  }
  if (!acquired) {
    throw new CliError(
      "CREDENTIALS_BUSY",
      `The credentials file at ${path} is busy; retry the command.`,
      4,
    );
  }
  try {
    return await operation();
  } finally {
    try {
      await rmdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

interface SelectedStoredCredentials {
  credentials: TokenCredentials;
  account: string;
  accountCount: number;
  selectionMode: "explicit" | "random" | "single";
}

function selectFromStore(
  store: CredentialsStore,
  accountName?: string,
): StoredCredentialsAccount | undefined {
  if (store.accounts.length === 0) {
    return undefined;
  }
  const index = accountName
    ? store.accounts.findIndex(
        ({ name }) => name.toLowerCase() === accountName.toLowerCase(),
      )
    : randomInt(store.accounts.length);
  if (index < 0) {
    return undefined;
  }
  return store.accounts[index];
}

async function selectedStoredCredentialsAtPath(
  path: string,
  accountName: string | undefined,
): Promise<SelectedStoredCredentials | undefined> {
  const store = await readCredentialsStoreAtPath(path);
  if (!store) {
    return undefined;
  }
  const selected = selectFromStore(store, accountName);
  if (!selected) {
    return undefined;
  }
  const { name, ...credentials } = selected;
  return {
    credentials,
    account: name,
    accountCount: store.accounts.length,
    selectionMode: accountName
      ? "explicit"
      : store.accounts.length > 1
        ? "random"
        : "single",
  };
}

export async function resolveCredentials(
  options: ResolveTokenOptions = {},
): Promise<ResolvedCredentials> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.bearer?.trim() && options.account?.trim()) {
    throw new CliError(
      "INVALID_OPTION",
      "Use either --bearer or --account, not both.",
      2,
    );
  }
  if (options.bearer?.trim()) {
    return {
      accessToken: normalizeBearerToken(options.bearer),
      source: "command-line",
    };
  }

  const requestedAccount = options.account?.trim()
    ? normalizeAccountName(options.account)
    : undefined;
  const localPath = localCredentialsPath(cwd);
  const globalPath = credentialsPath(environment);
  if (requestedAccount) {
    const local = await selectedStoredCredentialsAtPath(
      localPath,
      requestedAccount,
    );
    if (local) {
      return {
        ...local.credentials,
        source: "local-credentials-file",
        credentialsPath: localPath,
        account: local.account,
        accountCount: local.accountCount,
        selectionMode: local.selectionMode,
        roundRobin: false,
      };
    }
    const global = await selectedStoredCredentialsAtPath(
      globalPath,
      requestedAccount,
    );
    if (global) {
      return {
        ...global.credentials,
        source: "credentials-file",
        credentialsPath: globalPath,
        account: global.account,
        accountCount: global.accountCount,
        selectionMode: global.selectionMode,
        roundRobin: false,
      };
    }
    throw new CliError(
      "ACCOUNT_NOT_FOUND",
      `No stored Stockbit account named ${requestedAccount} was found. Run \`stockbit auth accounts\` to list accounts.`,
      2,
    );
  }

  const environmentToken = environment[TOKEN_ENVIRONMENT_VARIABLE]?.trim();
  if (environmentToken) {
    return {
      accessToken: normalizeBearerToken(environmentToken),
      source: "environment",
    };
  }

  const localCredentials = await selectedStoredCredentialsAtPath(
    localPath,
    undefined,
  );
  if (localCredentials) {
    return {
      ...localCredentials.credentials,
      source: "local-credentials-file",
      credentialsPath: localPath,
      account: localCredentials.account,
      accountCount: localCredentials.accountCount,
      selectionMode: localCredentials.selectionMode,
      roundRobin: false,
    };
  }

  const globalCredentials = await selectedStoredCredentialsAtPath(
    globalPath,
    undefined,
  );
  if (globalCredentials) {
    return {
      ...globalCredentials.credentials,
      source: "credentials-file",
      credentialsPath: globalPath,
      account: globalCredentials.account,
      accountCount: globalCredentials.accountCount,
      selectionMode: globalCredentials.selectionMode,
      roundRobin: false,
    };
  }

  throw new CliError(
    "AUTH_REQUIRED",
    `No bearer token is configured. Set ${TOKEN_ENVIRONMENT_VARIABLE}, pass --bearer, or run \`stockbit auth login\`.`,
    2,
  );
}

export async function resolveBearerToken(
  options: ResolveTokenOptions = {},
): Promise<ResolvedToken> {
  const credentials = await resolveCredentials(options);
  return {
    token: credentials.accessToken,
    source: credentials.source,
  };
}

function serializedCredentialsStore(store: CredentialsStore): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    accounts: store.accounts.map(({ name, ...credentials }) => {
      const normalized = normalizeTokenCredentials(credentials);
      return {
        name,
        accessToken: normalized.accessToken,
        ...(normalized.refreshToken
          ? { refreshToken: normalized.refreshToken }
          : {}),
        ...(normalized.accessExpiresAt
          ? { accessExpiresAt: normalized.accessExpiresAt }
          : {}),
        ...(normalized.refreshExpiresAt
          ? { refreshExpiresAt: normalized.refreshExpiresAt }
          : {}),
      };
    }),
  })}\n`;
}

async function assertSafeCredentialsPath(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) {
      throw new CliError(
        "UNSAFE_CREDENTIALS_PATH",
        `Refusing to write credentials through the symbolic link at ${path}.`,
        2,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeCredentialsStoreFile(
  path: string,
  store: CredentialsStore,
): Promise<void> {
  await assertSafeCredentialsPath(path);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializedCredentialsStore(store), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function upsertCredentialsAtPath(
  path: string,
  credentials: TokenCredentials,
  accountName?: string,
): Promise<SavedCredentials> {
  const normalized = normalizeTokenCredentials(credentials);
  return withCredentialsLock(path, async () => {
    const store = (await readCredentialsStoreAtPath(path)) ?? {
      accounts: [],
    };
    const name = accountName?.trim()
      ? normalizeAccountName(accountName)
      : suggestedAccountName(normalized);
    const existingIndex = store.accounts.findIndex(
      (account) => account.name.toLowerCase() === name.toLowerCase(),
    );
    const stored: StoredCredentialsAccount = { name, ...normalized };
    if (existingIndex >= 0) {
      store.accounts[existingIndex] = stored;
    } else {
      store.accounts.push(stored);
    }
    await writeCredentialsStoreFile(path, store);
    return { path, account: name, accountCount: store.accounts.length };
  });
}

export async function addCredentials(
  credentials: TokenCredentials,
  environment: NodeJS.ProcessEnv = process.env,
  accountName?: string,
): Promise<SavedCredentials> {
  const directory = configDirectory(environment);
  const path = credentialsPath(environment);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return upsertCredentialsAtPath(path, credentials, accountName);
}

export async function saveCredentials(
  credentials: TokenCredentials,
  environment: NodeJS.ProcessEnv = process.env,
  accountName?: string,
): Promise<string> {
  return (await addCredentials(credentials, environment, accountName)).path;
}

export async function saveBearerToken(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
  accountName?: string,
): Promise<string> {
  return saveCredentials({ accessToken: value }, environment, accountName);
}

export async function addLocalCredentials(
  credentials: TokenCredentials,
  cwd: string = process.cwd(),
  accountName?: string,
): Promise<SavedCredentials> {
  const path = localCredentialsPath(cwd);
  return upsertCredentialsAtPath(path, credentials, accountName);
}

export async function saveLocalCredentials(
  credentials: TokenCredentials,
  cwd: string = process.cwd(),
  accountName?: string,
): Promise<string> {
  return (await addLocalCredentials(credentials, cwd, accountName)).path;
}

export async function saveLocalBearerToken(
  value: string,
  cwd: string = process.cwd(),
  accountName?: string,
): Promise<string> {
  return saveLocalCredentials({ accessToken: value }, cwd, accountName);
}

export async function persistRefreshedCredentials(
  resolved: ResolvedCredentials,
  credentials: TokenCredentials,
): Promise<void> {
  if (!resolved.credentialsPath) {
    throw new CliError(
      "REFRESH_NOT_PERSISTABLE",
      "Refreshed credentials cannot be persisted for command-line or environment authentication.",
      3,
    );
  }
  if (!resolved.account) {
    throw new CliError(
      "REFRESH_NOT_PERSISTABLE",
      "The selected stored account could not be identified for refresh persistence.",
      3,
    );
  }
  if (resolved.source === "credentials-file") {
    const directory = dirname(resolved.credentialsPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const path = resolved.credentialsPath;
  const accountName = resolved.account;
  const normalized = normalizeTokenCredentials(credentials);
  await withCredentialsLock(path, async () => {
    const store = await readCredentialsStoreAtPath(path);
    if (!store) {
      throw new CliError(
        "REFRESH_NOT_PERSISTABLE",
        "The credentials file disappeared before refreshed credentials could be saved.",
        3,
      );
    }
    const index = store.accounts.findIndex(
      ({ name }) => name.toLowerCase() === accountName.toLowerCase(),
    );
    if (index < 0) {
      throw new CliError(
        "REFRESH_NOT_PERSISTABLE",
        `Stored account ${accountName} disappeared before refreshed credentials could be saved.`,
        3,
      );
    }
    store.accounts[index] = { name: accountName, ...normalized };
    await writeCredentialsStoreFile(path, store);
  });
}

async function removeCredentialsAccountAtPath(
  path: string,
  accountName: string,
): Promise<RemovedCredentialsAccount> {
  const normalizedName = normalizeAccountName(accountName);
  const initial = await readCredentialsStoreAtPath(path);
  if (!initial) {
    return {
      path,
      account: normalizedName,
      removed: false,
      accountCount: 0,
    };
  }
  return withCredentialsLock(path, async () => {
    const store = await readCredentialsStoreAtPath(path);
    if (!store) {
      return {
        path,
        account: normalizedName,
        removed: false,
        accountCount: 0,
      };
    }
    const removedIndex = store.accounts.findIndex(
      ({ name }) => name.toLowerCase() === normalizedName.toLowerCase(),
    );
    if (removedIndex < 0) {
      return {
        path,
        account: normalizedName,
        removed: false,
        accountCount: store.accounts.length,
      };
    }

    const removedName = store.accounts[removedIndex]?.name ?? normalizedName;
    store.accounts.splice(removedIndex, 1);
    if (store.accounts.length === 0) {
      await rm(path, { force: true });
    } else {
      await writeCredentialsStoreFile(path, store);
    }
    return {
      path,
      account: removedName,
      removed: true,
      accountCount: store.accounts.length,
    };
  });
}

export async function removeStoredCredentialsAccount(
  accountName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RemovedCredentialsAccount> {
  return removeCredentialsAccountAtPath(credentialsPath(environment), accountName);
}

export async function removeLocalStoredCredentialsAccount(
  accountName: string,
  cwd: string = process.cwd(),
): Promise<RemovedCredentialsAccount> {
  return removeCredentialsAccountAtPath(localCredentialsPath(cwd), accountName);
}

export async function clearStoredBearerToken(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return clearCredentialsAtPath(credentialsPath(environment));
}

async function clearCredentialsAtPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return withCredentialsLock(path, async () => {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
}

export async function clearLocalStoredBearerToken(
  cwd: string = process.cwd(),
): Promise<boolean> {
  return clearCredentialsAtPath(localCredentialsPath(cwd));
}

function tokenExpiration(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" ? decoded.exp : undefined;
  } catch {
    return undefined;
  }
}

function credentialExpiration(
  token: string,
  storedExpiration: string | undefined,
): string | undefined {
  const expiration = tokenExpiration(token);
  return expiration !== undefined
    ? new Date(expiration * 1000).toISOString()
    : storedExpiration;
}

export function getResolvedTokenStatus(
  resolved: ResolvedCredentials,
): TokenStatus {
  const accessExpiresAt = credentialExpiration(
    resolved.accessToken,
    resolved.accessExpiresAt,
  );
  const refreshExpiresAt = resolved.refreshToken
    ? credentialExpiration(resolved.refreshToken, resolved.refreshExpiresAt)
    : undefined;
  const status: TokenStatus = {
    configured: true,
    source: resolved.source,
    refreshConfigured: Boolean(resolved.refreshToken),
    ...(resolved.account ? { account: resolved.account } : {}),
    ...(resolved.accountCount !== undefined
      ? { accountCount: resolved.accountCount }
      : {}),
    ...(resolved.selectionMode
      ? { selectionMode: resolved.selectionMode }
      : {}),
    ...(resolved.roundRobin !== undefined
      ? { roundRobin: resolved.roundRobin }
      : {}),
  };

  if (accessExpiresAt) {
    status.expiresAt = accessExpiresAt;
    status.expired = Date.parse(accessExpiresAt) <= Date.now();
  }
  if (refreshExpiresAt) {
    status.refreshExpiresAt = refreshExpiresAt;
    status.refreshExpired = Date.parse(refreshExpiresAt) <= Date.now();
  }
  return status;
}

function accountStatus(
  account: StoredCredentialsAccount,
): CredentialAccountStatus {
  const accessExpiresAt = credentialExpiration(
    account.accessToken,
    account.accessExpiresAt,
  );
  const refreshExpiresAt = account.refreshToken
    ? credentialExpiration(account.refreshToken, account.refreshExpiresAt)
    : undefined;
  return {
    name: account.name,
    refreshConfigured: Boolean(account.refreshToken),
    next: false,
    ...(accessExpiresAt
      ? {
          accessExpiresAt,
          accessExpired: Date.parse(accessExpiresAt) <= Date.now(),
        }
      : {}),
    ...(refreshExpiresAt
      ? {
          refreshExpiresAt,
          refreshExpired: Date.parse(refreshExpiresAt) <= Date.now(),
        }
      : {}),
  };
}

export async function listCredentialStores(
  options: Pick<ResolveTokenOptions, "environment" | "cwd"> = {},
): Promise<CredentialStoreStatus[]> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const candidates: Array<{ source: StoredTokenSource; path: string }> = [
    { source: "local-credentials-file", path: localCredentialsPath(cwd) },
    { source: "credentials-file", path: credentialsPath(environment) },
  ];
  const stores: CredentialStoreStatus[] = [];
  for (const candidate of candidates) {
    const store = await readCredentialsStoreAtPath(candidate.path);
    if (!store || store.accounts.length === 0) {
      continue;
    }
    stores.push({
      source: candidate.source,
      path: candidate.path,
      active: false,
      accountCount: store.accounts.length,
      selectionMode: store.accounts.length > 1 ? "random" : "single",
      nextAccount: null,
      accounts: store.accounts.map((account) => accountStatus(account)),
    });
  }
  const activeStore = environment[TOKEN_ENVIRONMENT_VARIABLE]?.trim()
    ? undefined
    : stores[0];
  if (activeStore) {
    activeStore.active = true;
  }
  return stores;
}

export async function getTokenStatus(
  options: ResolveTokenOptions = {},
): Promise<TokenStatus> {
  try {
    const resolved = await resolveCredentials(options);
    return getResolvedTokenStatus(resolved);
  } catch (error) {
    if (error instanceof CliError && error.code === "AUTH_REQUIRED") {
      return { configured: false };
    }
    throw error;
  }
}

async function readPipedValue(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function readHiddenValue(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let token = "";
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\n");
    };

    const finish = (): void => {
      cleanup();
      resolve(token.trim());
    };

    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new CliError("CANCELLED", "Token input was cancelled.", 130));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          token = token.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          token += character;
        }
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function readSecretValue(
  prompt: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const value = (input as ReadStream).isTTY
    ? await readHiddenValue(prompt, input as ReadStream, output as WriteStream)
    : await readPipedValue(input);

  if (!value) {
    throw new CliError("SECRET_EMPTY", "The provided value cannot be empty.", 2);
  }
  return value;
}

export async function readBearerToken(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  return normalizeBearerToken(await readSecretValue("Bearer token: ", input, output));
}

export async function readCredentialStorage(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  return readSecretValue("credentialStorage value: ", input, output);
}

function readVisibleLine(
  prompt: string,
  input: ReadStream,
  output: WriteStream,
): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const readline = createInterface({ input, output, terminal: true });
    let settled = false;
    const finish = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      readline.close();
      resolveLine(value.trim());
    };
    readline.once("SIGINT", () => {
      if (settled) {
        return;
      }
      settled = true;
      readline.close();
      reject(new CliError("CANCELLED", "Credential import was cancelled.", 130));
    });
    readline.question(prompt, finish);
  });
}

export async function readAddAnotherAccount(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (!(input as ReadStream).isTTY) {
    return false;
  }
  while (true) {
    const answer = (
      await readVisibleLine(
        "Add another Stockbit account? [y/N]: ",
        input as ReadStream,
        output as WriteStream,
      )
    ).toLowerCase();
    if (!answer || answer === "n" || answer === "no") {
      return false;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    output.write("Please answer yes or no.\n");
  }
}
