import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ReadStream, WriteStream } from "node:tty";

import { CliError } from "./errors.js";

const TOKEN_ENVIRONMENT_VARIABLE = "STOCKBIT_BEARER_TOKEN";
const CONFIG_DIRECTORY_ENVIRONMENT_VARIABLE = "STOCKBIT_CONFIG_DIR";
const LOCAL_CREDENTIALS_FILENAME = "credentials-stockbit.json";

interface CredentialsFile {
  bearerToken: string;
}

interface CredentialStorageValue {
  state?: {
    access?: {
      token?: unknown;
      expired_at?: unknown;
    };
  };
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
}

export interface ParsedCredentialStorage {
  token: string;
  expiresAt?: string;
}

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
    token: normalizeBearerToken(access.token),
  };
  if (typeof access.expired_at === "string") {
    const expiration = new Date(access.expired_at);
    if (!Number.isNaN(expiration.getTime())) {
      result.expiresAt = expiration.toISOString();
    }
  }

  return result;
}

async function storedTokenAtPath(path: string): Promise<string | undefined> {
  try {
    const contents = await readFile(path, "utf8");
    const credentials = JSON.parse(contents) as Partial<CredentialsFile>;
    return typeof credentials.bearerToken === "string"
      ? normalizeBearerToken(credentials.bearerToken)
      : undefined;
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

export async function resolveBearerToken(
  options: ResolveTokenOptions = {},
): Promise<ResolvedToken> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.bearer?.trim()) {
    return {
      token: normalizeBearerToken(options.bearer),
      source: "command-line",
    };
  }

  const environmentToken = environment[TOKEN_ENVIRONMENT_VARIABLE]?.trim();
  if (environmentToken) {
    return {
      token: normalizeBearerToken(environmentToken),
      source: "environment",
    };
  }

  const localToken = await storedTokenAtPath(localCredentialsPath(cwd));
  if (localToken) {
    return { token: localToken, source: "local-credentials-file" };
  }

  const globalToken = await storedTokenAtPath(credentialsPath(environment));
  if (globalToken) {
    return { token: globalToken, source: "credentials-file" };
  }

  throw new CliError(
    "AUTH_REQUIRED",
    `No bearer token is configured. Set ${TOKEN_ENVIRONMENT_VARIABLE}, pass --bearer, or run \`stockbit auth login\`.`,
    2,
  );
}

export async function saveBearerToken(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const token = normalizeBearerToken(value);
  const directory = configDirectory(environment);
  const path = credentialsPath(environment);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${JSON.stringify({ bearerToken: token })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);

  return path;
}

export async function saveLocalBearerToken(
  value: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const token = normalizeBearerToken(value);
  const path = localCredentialsPath(cwd);

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

  await writeFile(path, `${JSON.stringify({ bearerToken: token })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);

  return path;
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
    const resolved = await resolveBearerToken(options);
    const expiration = tokenExpiration(resolved.token);
    const status: TokenStatus = {
      configured: true,
      source: resolved.source,
    };

    if (expiration !== undefined) {
      status.expiresAt = new Date(expiration * 1000).toISOString();
      status.expired = expiration * 1000 <= Date.now();
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
