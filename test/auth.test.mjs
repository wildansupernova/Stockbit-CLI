import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  addCredentials,
  clearLocalStoredBearerToken,
  credentialsPath,
  getTokenStatus,
  listCredentialStores,
  localCredentialsPath,
  parseCredentialStorage,
  persistRefreshedCredentials,
  readAddAnotherAccount,
  resolveBearerToken,
  resolveCredentials,
  removeStoredCredentialsAccount,
  saveBearerToken,
  saveCredentials,
  saveLocalBearerToken,
} from "../dist/auth.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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

test("additional-account prompt defaults to no and accepts yes interactively", async () => {
  const ask = async (answer) => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    output.isTTY = true;
    output.columns = 120;
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString("utf8");
    });
    const result = readAddAnotherAccount(input, output);
    setImmediate(() => input.write(`${answer}\n`));
    return { answer: await result, rendered };
  };

  const defaultAnswer = await ask("");
  assert.equal(defaultAnswer.answer, false);
  assert.match(defaultAnswer.rendered, /Add another Stockbit account/iu);
  assert.equal((await ask("yes")).answer, true);

  const pipedInput = new PassThrough();
  const pipedOutput = new PassThrough();
  assert.equal(await readAddAnotherAccount(pipedInput, pipedOutput), false);
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
    assert.deepEqual(saved, {
      schemaVersion: 2,
      accounts: [{ name: "default", accessToken: "stored-token" }],
    });
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
      account: "default",
      accountCount: 1,
      selectionMode: "single",
      roundRobin: false,
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
      schemaVersion: 2,
      accounts: [
        {
          name: "default",
          accessToken: "new-access-token",
          refreshToken: "new-refresh-token",
          accessExpiresAt: "2030-02-02T03:04:05.000Z",
          refreshExpiresAt: "2030-02-09T03:04:05.000Z",
        },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("randomly selects named accounts without persisting selection state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-rotation-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials({ accessToken: "alpha-token" }, environment, "alpha");
    await addCredentials({ accessToken: "beta-token" }, environment, "beta");

    const explicitOne = await resolveCredentials({
      environment,
      cwd: directory,
      account: "beta",
    });
    const explicitTwo = await resolveCredentials({
      environment,
      cwd: directory,
      account: "BETA",
    });
    assert.equal(explicitOne.accessToken, "beta-token");
    assert.equal(explicitTwo.accessToken, "beta-token");
    assert.equal(explicitOne.selectionMode, "explicit");
    assert.equal(explicitOne.roundRobin, false);

    const before = await readFile(credentialsPath(environment), "utf8");
    const selected = new Set();
    for (let index = 0; index < 64; index += 1) {
      const credentials = await resolveCredentials({ environment, cwd: directory });
      assert.ok(credentials.account === "alpha" || credentials.account === "beta");
      selected.add(credentials.account);
      assert.equal(credentials.accountCount, 2);
      assert.equal(credentials.selectionMode, "random");
      assert.equal(credentials.roundRobin, false);
    }
    assert.deepEqual([...selected].sort(), ["alpha", "beta"]);

    const after = await readFile(credentialsPath(environment), "utf8");
    assert.equal(after, before);
    const saved = JSON.parse(after);
    assert.equal(saved.nextAccountIndex, undefined);
    assert.deepEqual(
      saved.accounts.map(({ name }) => name),
      ["alpha", "beta"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent random selection does not write credential state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-concurrent-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials({ accessToken: "alpha-token" }, environment, "alpha");
    await addCredentials({ accessToken: "beta-token" }, environment, "beta");
    const before = await readFile(credentialsPath(environment), "utf8");
    const selected = await Promise.all(
      Array.from({ length: 32 }, () =>
        resolveCredentials({ environment, cwd: directory }),
      ),
    );
    assert.ok(
      selected.every(
        ({ account, selectionMode }) =>
          (account === "alpha" || account === "beta") &&
          selectionMode === "random",
      ),
    );
    assert.equal(await readFile(credentialsPath(environment), "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores a legacy round-robin cursor and removes it on the next write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-legacy-cursor-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    const legacy = {
      schemaVersion: 2,
      nextAccountIndex: 1,
      accounts: [
        { name: "alpha", accessToken: "alpha-token" },
        { name: "beta", accessToken: "beta-token" },
      ],
    };
    await writeFile(
      credentialsPath(environment),
      `${JSON.stringify(legacy)}\n`,
      { mode: 0o600 },
    );
    const selected = await resolveCredentials({ environment, cwd: directory });
    assert.ok(selected.account === "alpha" || selected.account === "beta");
    assert.equal(selected.selectionMode, "random");
    assert.deepEqual(
      JSON.parse(await readFile(credentialsPath(environment), "utf8")),
      legacy,
    );

    await addCredentials({ accessToken: "gamma-token" }, environment, "gamma");
    const migrated = JSON.parse(
      await readFile(credentialsPath(environment), "utf8"),
    );
    assert.equal(migrated.nextAccountIndex, undefined);
    assert.deepEqual(migrated.accounts.map(({ name }) => name), [
      "alpha",
      "beta",
      "gamma",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status and account listing describe random selection without revealing tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-list-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials(
      {
        accessToken: "alpha-secret",
        refreshToken: "alpha-refresh-secret",
        accessExpiresAt: "2030-01-02T03:04:05Z",
      },
      environment,
      "alpha",
    );
    await addCredentials({ accessToken: "beta-secret" }, environment, "beta");

    const status = await getTokenStatus({ environment, cwd: directory });
    assert.ok(status.account === "alpha" || status.account === "beta");
    assert.equal(status.accountCount, 2);
    assert.equal(status.selectionMode, "random");
    assert.equal(status.roundRobin, false);

    const stores = await listCredentialStores({ environment, cwd: directory });
    assert.equal(stores.length, 1);
    assert.equal(stores[0].active, true);
    assert.equal(stores[0].selectionMode, "random");
    assert.equal(stores[0].nextAccount, null);
    assert.deepEqual(
      stores[0].accounts.map(({ name, next }) => ({ name, next })),
      [
        { name: "alpha", next: false },
        { name: "beta", next: false },
      ],
    );
    assert.doesNotMatch(JSON.stringify(stores), /secret/);

    const selected = await resolveCredentials({ environment, cwd: directory });
    assert.ok(selected.account === "alpha" || selected.account === "beta");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refresh and removal affect only the selected named account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-account-update-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials(
      { accessToken: "alpha-access", refreshToken: "alpha-refresh" },
      environment,
      "alpha",
    );
    await addCredentials(
      { accessToken: "beta-access", refreshToken: "beta-refresh" },
      environment,
      "beta",
    );
    const beta = await resolveCredentials({
      environment,
      cwd: directory,
      account: "beta",
    });
    await persistRefreshedCredentials(beta, {
      accessToken: "beta-new-access",
      refreshToken: "beta-new-refresh",
    });

    let saved = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    assert.deepEqual(saved.accounts, [
      {
        name: "alpha",
        accessToken: "alpha-access",
        refreshToken: "alpha-refresh",
      },
      {
        name: "beta",
        accessToken: "beta-new-access",
        refreshToken: "beta-new-refresh",
      },
    ]);
    assert.equal(saved.nextAccountIndex, undefined);

    const removed = await removeStoredCredentialsAccount("alpha", environment);
    assert.deepEqual(removed, {
      path: credentialsPath(environment),
      account: "alpha",
      removed: true,
      accountCount: 1,
    });
    saved = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    assert.equal(saved.nextAccountIndex, undefined);
    assert.deepEqual(saved.accounts.map(({ name }) => name), ["beta"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("named account selection takes precedence over environment but conflicts with bearer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-account-precedence-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
    STOCKBIT_BEARER_TOKEN: "environment-token",
  };

  try {
    await addCredentials({ accessToken: "saved-token" }, environment, "saved");
    const named = await resolveCredentials({
      environment,
      cwd: directory,
      account: "saved",
    });
    assert.equal(named.accessToken, "saved-token");
    await assert.rejects(
      resolveCredentials({
        environment,
        cwd: directory,
        bearer: "argument-token",
        account: "saved",
      }),
      { code: "INVALID_OPTION" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("derives a default account name from the Stockbit JWT username", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-jwt-name-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;
  const payload = Buffer.from(
    JSON.stringify({ data: { use: "example.user", uid: 123 } }),
  ).toString("base64url");
  const token = `header.${payload}.signature`;

  try {
    const saved = await addCredentials({ accessToken: token }, environment);
    assert.equal(saved.account, "example.user");
    const credentials = await resolveCredentials({ environment, cwd: directory });
    assert.equal(credentials.account, "example.user");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auth accounts JSON is machine-readable and contains no credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-accounts-command-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials(
      { accessToken: "cli-secret", refreshToken: "cli-refresh-secret" },
      environment,
      "cli-account",
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "auth", "accounts", "--json"],
      { cwd: directory, env: environment },
    );
    const output = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(output.active_source, "credentials-file");
    assert.equal(output.stores[0].selection_mode, "single");
    assert.equal(output.stores[0].next_account, null);
    assert.equal(output.stores[0].accounts[0].name, "cli-account");
    assert.doesNotMatch(stdout, /cli-secret|cli-refresh-secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auth clear with --account removes only that account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-clear-account-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: directory,
  };
  delete environment.STOCKBIT_BEARER_TOKEN;

  try {
    await addCredentials({ accessToken: "alpha-token" }, environment, "alpha");
    await addCredentials({ accessToken: "beta-token" }, environment, "beta");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "auth", "clear", "--account", "alpha"],
      { cwd: directory, env: environment },
    );
    assert.equal(stderr, "");
    assert.match(stdout, /Removed account alpha/u);
    const saved = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    assert.deepEqual(saved.accounts.map(({ name }) => name), ["beta"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing an account from a missing store is a no-op", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbit-cli-remove-missing-"));
  const environment = {
    ...process.env,
    STOCKBIT_CONFIG_DIR: join(directory, "missing-config"),
  };

  try {
    const result = await removeStoredCredentialsAccount("missing", environment);
    assert.equal(result.removed, false);
    assert.equal(result.accountCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
