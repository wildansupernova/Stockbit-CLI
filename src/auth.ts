import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ReadStream, WriteStream } from "node:tty";

import { CliError } from "./errors.js";

const TOKEN_ENVIRONMENT_VARIABLE = "STOCKBIT_BEARER_TOKEN";
const CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE = "STOCKBIT_CONFIG_DIR";
const LOCAL_CREDENTIALS_FILENAME = "credentials-stockbit.json";

interface CredentialsFile {
  schemaVersion?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
  accessExpiresAt?: unknown;
  refreshExpiresAt?: unknown;
  bearerToken?: unknown;
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
  expiresAt?: string;
  expired?: boolean;
  refreshConfigured?: boolean;
  refreshExpiresAt?: string;
  refreshExpired?: boolean;
}

export type ParsedCredentialStorage = TokenCredentials;

export interface ResolveTokenOptions {
  bearer?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
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

function parseCredentialsFile(credentials: CredentialsFile): TokenCredentials | undefined {
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

async function storedCredentialsAtPath(
  path: string,
): Promise<TokenCredentials | undefined> {
  try {
    const contents = await readFile(path, "utf8");
    const credentials = JSON.parse(contents) as CredentialsFile;
    return parseCredentialsFile(credentials);
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

export async function resolveCredentials(
  options: ResolveTokenOptions = {},
): Promise<ResolvedCredentials> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.bearer?.trim()) {
    return {
      accessToken: normalizeBearerToken(options.bearer),
      source: "command-line",
    };
  }

  const environmentToken = environment[TOKEN_ENVIRONMENT_VARIABLE]?.trim();
  if (environmentToken) {
    return {
      accessToken: normalizeBearerToken(environmentToken),
      source: "environment",
    };
  }

  const localPath = localCredentialsPath(cwd);
  const localCredentials = await storedCredentialsAtPath(localPath);
  if (localCredentials) {
    return {
      ...localCredentials,
      source: "local-credentials-file",
      credentialsPath: localPath,
    };
  }

  const globalPath = credentialsPath(environment);
  const globalCredentials = await storedCredentialsAtPath(globalPath);
  if (globalCredentials) {
    return {
      ...globalCredentials,
      source: "credentials-file",
      credentialsPath: globalPath,
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

function serializedCredentials(credentials: TokenCredentials): string {
  const normalized = normalizeTokenCredentials(credentials);
  return `${JSON.stringify({
    schemaVersion: 1,
    accessToken: normalized.accessToken,
    ...(normalized.refreshToken ? { refreshToken: normalized.refreshToken } : {}),
    ...(normalized.accessExpiresAt
      ? { accessExpiresAt: normalized.accessExpiresAt }
      : {}),
    ...(normalized.refreshExpiresAt
      ? { refreshExpiresAt: normalized.refreshExpiresAt }
      : {}),
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

async function writeCredentialsFile(
  path: string,
  credentials: TokenCredentials,
): Promise<void> {
  await assertSafeCredentialsPath(path);
  await writeFile(path, serializedCredentials(credentials), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function saveCredentials(
  credentials: TokenCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = configDirectory(environment);
  const path = credentialsPath(environment);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeCredentialsFile(path, credentials);

  return path;
}

export async function saveBearerToken(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return saveCredentials({ accessToken: value }, environment);
}

export async function saveLocalCredentials(
  credentials: TokenCredentials,
  cwd: string = process.cwd(),
): Promise<string> {
  const path = localCredentialsPath(cwd);
  await writeCredentialsFile(path, credentials);

  return path;
}

export async function saveLocalBearerToken(
  value: string,
  cwd: string = process.cwd(),
): Promise<string> {
  return saveLocalCredentials({ accessToken: value }, cwd);
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
  if (resolved.source === "credentials-file") {
    const directory = dirname(resolved.credentialsPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writeCredentialsFile(resolved.credentialsPath, credentials);
}

export async function clearStoredBearerToken(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await rm(credentialsPath(environment));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function clearLocalStoredBearerToken(
  cwd: string = process.cwd(),
): Promise<boolean> {
  try {
    await rm(localCredentialsPath(cwd));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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

export async function getTokenStatus(
  options: ResolveTokenOptions = {},
): Promise<TokenStatus> {
  try {
    const resolved = await resolveCredentials(options);
    const expiration = tokenExpiration(resolved.accessToken);
    const accessExpiresAt =
      expiration !== undefined
        ? new Date(expiration * 1000).toISOString()
        : resolved.accessExpiresAt;
    const refreshExpiration = resolved.refreshToken
      ? tokenExpiration(resolved.refreshToken)
      : undefined;
    const refreshExpiresAt =
      refreshExpiration !== undefined
        ? new Date(refreshExpiration * 1000).toISOString()
        : resolved.refreshExpiresAt;
    const status: TokenStatus = {
      configured: true,
      source: resolved.source,
      refreshConfigured: Boolean(resolved.refreshToken),
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
  const value = process.stdin.isTTY
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
