import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearLocalStoredBearerToken,
  credentialsPath,
  localCredentialsPath,
  parseCredentialStorage,
  persistRefreshedCredentials,
  resolveBearerToken,
  resolveCredentials,
  saveBearerToken,
  saveCredentials,
  saveLocalBearerToken,
} from "../dist/auth.js";

test("parses access and refresh credentials without retaining user data", () => {
  const storage = {
    state: {
      access: {
        token: "synthetic-access-token",
        expired_at: "2030-01-02T03:04:05Z",
      },
      refresh: {
        token: "synthetic-refresh-token",
        expired_at: "2030-01-09T03:04:05Z",
      },
      user: {
        username: "example-user",
      },
    },
    version: 0,
  };

  const result = parseCredentialStorage(encodeURIComponent(JSON.stringify(storage)));
  const partiallyEncoded = JSON.stringify(storage)
    .replaceAll('"', "%22")
    .replaceAll(",", "%2C");

  assert.deepEqual(result, {
    accessToken: "synthetic-access-token",
    accessExpiresAt: "2030-01-02T03:04:05.000Z",
    refreshToken: "synthetic-refresh-token",
    refreshExpiresAt: "2030-01-09T03:04:05.000Z",
  });
  assert.deepEqual(parseCredentialStorage(partiallyEncoded), result);
  assert.doesNotMatch(JSON.stringify(result), /example-user/);
});

test("rejects credentialStorage without an access token", () => {
  assert.throws(
    () => parseCredentialStorage(encodeURIComponent(JSON.stringify({ state: {} }))),
    /state\.access\.token/,
  );
});

test("command-line bearer takes precedence over environment and stored credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-auth-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
    STOCKBIT_BEARER_TOKEN: "environment-token",
  };

  try {
    await saveBearerToken("stored-token", environment);
    await saveLocalBearerToken("local-token", directory);

    assert.deepEqual(
      await resolveBearerToken({
        bearer: "argument-token",
        environment,
        cwd: directory,
      }),
      { token: "argument-token", source: "command-line" },
    );
    assert.deepEqual(await resolveBearerToken({ environment, cwd: directory }), {
      token: "environment-token",
      source: "environment",
    });

    delete environment.STOCKBIT_BEARER_TOKEN;
    assert.deepEqual(await resolveBearerToken({ environment, cwd: directory }), {
      token: "local-token",
      source: "local-credentials-file",
    });

    await clearLocalStoredBearerToken(directory);
    assert.deepEqual(await resolveBearerToken({ environment, cwd: directory }), {
      token: "stored-token",
      source: "credentials-file",
    });

    const saved = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    assert.deepEqual(saved, { schemaVersion: 1, accessToken: "stored-token" });
    await assert.rejects(readFile(localCredentialsPath(directory), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads legacy bearerToken files and persists rotated refresh credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-refresh-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };

  try {
    await writeFile(
      credentialsPath(environment),
      `${JSON.stringify({ bearerToken: "legacy-access-token" })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(await resolveCredentials({ environment, cwd: directory }), {
      accessToken: "legacy-access-token",
      source: "credentials-file",
      credentialsPath: credentialsPath(environment),
    });

    await saveCredentials(
      {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        accessExpiresAt: "2030-01-02T03:04:05Z",
        refreshExpiresAt: "2030-01-09T03:04:05Z",
      },
      environment,
    );
    const resolved = await resolveCredentials({ environment, cwd: directory });
    await persistRefreshedCredentials(resolved, {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      accessExpiresAt: "2030-02-02T03:04:05Z",
      refreshExpiresAt: "2030-02-09T03:04:05Z",
    });

    const saved = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    assert.deepEqual(saved, {
      schemaVersion: 1,
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      accessExpiresAt: "2030-02-02T03:04:05.000Z",
      refreshExpiresAt: "2030-02-09T03:04:05.000Z",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
