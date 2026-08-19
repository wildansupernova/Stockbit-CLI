# Stockbit CLI

A TypeScript command-line client for retrieving authorized Stockbit financial data.

> [!IMPORTANT]
> Use this client only with an account and data access you are authorized to automate. Never commit or share bearer tokens. This project is unofficial and is not affiliated with Stockbit.

## Requirements

- Node.js 20 or newer
- npm

## Development

```bash
npm install
npm run build
node dist/cli.js --help
```

Link the command globally while developing:

```bash
npm link
stockbit --help
```

## Installation

Install from the project directory:

```bash
npm install -g .
```

After the package is published:

```bash
npm install -g stockbit-cli
```

## Authentication

The CLI resolves authentication in this order:

1. `--bearer` for the current invocation
2. `STOCKBIT_BEARER_TOKEN`
3. `credentials-stockbit.json` in the current directory
4. The user-level credentials file

### Login from credentialStorage

Run:

```bash
stockbit auth login
```

To save the access token for only the current project directory:

```bash
stockbit auth login --local
```

The command will ask you to:

1. Log in at <https://stockbit.com>.
2. Open browser Developer Tools.
3. Select **Application → Local Storage → https://stockbit.com**.
4. Copy the value named `credentialStorage` and paste it into the local CLI prompt.

The prompt does not echo the value. The CLI URL-decodes the value, extracts `state.access.token`, and stores only that access token. It does not store the raw `credentialStorage` value, refresh token, or embedded user profile.

Do not paste `credentialStorage`, access tokens, or refresh tokens into chat, issue trackers, or source files.

### Token storage

By default, the access token is stored at `~/.config/stockbit-cli/credentials.json`. The directory uses user-only mode `0700`, and the file uses `0600`. Set `STOCKBIT_CONFIG_DIR` to override that directory.

With `--local`, the token is instead stored as `credentials-stockbit.json` in the directory where the CLI is called. The file uses mode `0600`, and the CLI automatically checks it before the user-level credentials file.

Local credential files are convenient for separate project accounts, but they can be committed accidentally. Add `credentials-stockbit.json` to every applicable `.gitignore`; this repository already ignores it. Do not use local storage inside an untrusted or shared directory.

Credentials are not stored in a temporary directory, where they may disappear unexpectedly.

An operating-system keychain is the preferred future upgrade for stronger at-rest protection; the permission-restricted config file is the portable, dependency-free fallback.

### Direct token input

Store a token interactively without displaying it:

```bash
stockbit auth set-token
stockbit auth status
```

To store a directly supplied token for the current directory:

```bash
stockbit auth set-token --local
```

For ephemeral environments, provide the token through an environment variable:

```bash
export STOCKBIT_BEARER_TOKEN="your-token"
stockbit auth status
```

Or use the requested one-command override:

```bash
stockbit --bearer "your-token" fundamental JTPE
stockbit --bearer "your-token" auth status --json
```

Avoid `--bearer` when possible because command-line arguments may be retained in shell history or exposed in the process list. The environment variable or saved credentials file is safer.

`stockbit auth status` validates the token through Stockbit's authenticated user endpoint and returns the current user profile. It never prints the token.

Remove the stored token:

```bash
stockbit auth clear
stockbit auth clear --local
```

## Fetch fundamentals

Fetch the quarterly income statement for JTPE:

```bash
stockbit fundamental JTPE
```

Select the report and statement period by name:

```bash
stockbit fundamental JTPE --report balance --statement annual
stockbit fundamental JTPE --report cashflow --statement ttm
```

Numeric values are also supported:

```bash
stockbit fundamental JTPE --report 1 --statement 1
```

Report types:

| Value | Name |
| --- | --- |
| 1 | `income` |
| 2 | `balance` |
| 3 | `cashflow` |

Statement types:

| Value | Name |
| --- | --- |
| 1 | `quarterly` |
| 2 | `annual` |
| 3 | `ttm` |
| 4 | `interim-ytd` |
| 5 | `q1` |
| 6 | `q2` |
| 7 | `q3` |
| 8 | `q4` |
| 9 | `qoq-growth` |
| 10 | `quarter-yoy-growth` |
| 11 | `ytd-yoy-growth` |
| 12 | `annual-yoy-growth` |
| 13 | `3-year-cagr` |

The command prints a versioned JSON envelope. Use `--compact` for single-line JSON:

```bash
stockbit fundamental JTPE --compact
```

## Checks

```bash
npm run check
npm test
```
