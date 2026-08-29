# Stockbit CLI

A TypeScript command-line client for retrieving authorized Stockbit fundamentals, broker-summary data, and daily price history.

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

## Agent-friendly help

Show the complete command and usage reference:

```bash
stockbit help
```

AI agents and scripts should request the versioned JSON document:

```bash
stockbit help --json
stockbit help auth --json
stockbit help fundamental --json
stockbit help broker-summary --json
stockbit help price --json
stockbit help formats --json
```

Available topics are `all`, `commands`, `auth`, `fundamental`, `broker-summary`, `price`, and `formats`. The structured reference includes authentication precedence and safety, fundamental and broker-summary enums, price-range semantics, output contracts, examples, exit-code meanings, and guidance for choosing `json`, `raw`, or `csv`. The help command is local-only and does not read credentials or access the network.

Standard command-specific help remains available:

```bash
stockbit auth --help
stockbit fundamental --help
stockbit broker-summary --help
stockbit price --help
```

## Authentication

The CLI resolves the access token in this order:

1. `--bearer` for the current invocation
2. `STOCKBIT_BEARER_TOKEN`
3. `credentials-stockbit.json` in the current directory
4. The user-level credentials file

### Login from credentialStorage

Run:

```bash
stockbit auth login
```

To save the credentials for only the current project directory:

```bash
stockbit auth login --local
```

The command will ask you to:

1. Log in at <https://stockbit.com>.
2. Open browser Developer Tools.
3. Select **Application → Local Storage → https://stockbit.com**.
4. Copy the value named `credentialStorage` and paste it into the local CLI prompt.

The prompt does not echo the value. The CLI URL-decodes it and stores `state.access.token`, `state.refresh.token`, and their expiration metadata. It does not store the raw `credentialStorage` value or embedded user profile.

Do not paste `credentialStorage`, access tokens, or refresh tokens into chat, issue trackers, or source files.

### Token storage

By default, the access and refresh tokens are stored at `~/.config/stockbit-cli/credentials.json`. The directory uses user-only mode `0700`, and the file uses `0600`. Set `STOCKBIT_CONFIG_DIR` to override that directory.

With `--local`, the credentials are instead stored as `credentials-stockbit.json` in the directory where the CLI is called. The file uses mode `0600`, and the CLI automatically checks it before the user-level credentials file.

Local credential files are convenient for separate project accounts, but they can be committed accidentally. Add `credentials-stockbit.json` to every applicable `.gitignore`; this repository already ignores it. Do not use local storage inside an untrusted or shared directory.

Credentials are not stored in a temporary directory, where they may disappear unexpectedly.

An operating-system keychain is the preferred future upgrade for stronger at-rest protection; the permission-restricted config file is the portable, dependency-free fallback.

### Automatic refresh

Credentials imported with `stockbit auth login` enable automatic access-token refresh:

1. Before a protected request, the CLI refreshes if the access token is expired or expires within 30 seconds.
2. If expiration is unknown and Stockbit returns HTTP `401`, the CLI refreshes then.
3. It sends the saved refresh token to `POST /login/refresh`.
4. It saves the new access token and any rotated refresh token back to the same credentials file.
5. It retries the original request once.

If Stockbit rejects the refresh token, the CLI stops with `REFRESH_FAILED` and asks for `stockbit auth login` again. It never retries refresh indefinitely.

Explicit `--bearer`, `STOCKBIT_BEARER_TOKEN`, legacy access-only files, and `stockbit auth set-token` do not use a saved refresh token from another source. Run `stockbit auth login` to enable refresh safely for the selected credential file.

### Direct token input

Store an access token interactively without displaying it:

```bash
stockbit auth set-token
stockbit auth status
```

To store a directly supplied access token for the current directory:

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
stockbit --bearer "your-token" price ERAA --from 2026-08-01 --to 2026-08-28
```

Avoid `--bearer` when possible because command-line arguments may be retained in shell history or exposed in the process list. The environment variable or saved credentials file is safer.

`stockbit auth status` refreshes when needed, validates authentication through Stockbit's user endpoint, and returns the current profile plus non-secret expiration and refresh-status metadata. It never prints either token.

Remove the stored credentials:

```bash
stockbit auth clear
stockbit auth clear --local
```

## Fetch fundamentals

Fetch the quarterly income statement for JTPE:

```bash
stockbit fundamental JTPE
```

The default `raw` view preserves Stockbit's response, including `html_report`:

```bash
stockbit fundamental BBCA --report income --statement annual --view raw
```

Use the `json` view for agents, scripts, and data analysis. It parses the HTML into normalized JSON:

```bash
stockbit fundamental BBCA --report income --statement annual --view json
```

Use the `csv` view for spreadsheets and tabular pipelines:

```bash
stockbit fundamental BBCA --report income --statement q2 --view csv
stockbit fundamental BBCA --report income --statement q2 --view csv > bbca-q2.csv
```

Raw responses use this outer shape:

```json
{
  "schema_version": "1",
  "view": "raw",
  "data": {
    "message": "...",
    "data": {
      "html_report": "<table>...</table>"
    }
  },
  "meta": {}
}
```

Normalized JSON responses remove the HTML and expose tables, period definitions, account rows, and exact values:

```json
{
  "schema_version": "1",
  "view": "json",
  "data": {
    "currencies": ["IDR", "USD"],
    "default_currency": "IDR",
    "tables": [
      {
        "kind": "financials",
        "periods": [{ "key": "12M25", "label": "12M 2025" }],
        "rows": [
          {
            "label": "Total Revenue",
            "local_label": "Total Pendapatan",
            "values": [
              {
                "period": "12M25",
                "display": "...",
                "available": true,
                "raw": "118572759000000.000000",
                "idr": "118572759000000",
                "usd": "7196032308"
              }
            ]
          }
        ]
      }
    ]
  },
  "meta": {
    "parser": {
      "name": "stockbit-financial-html",
      "version": "1",
      "warnings": []
    }
  }
}
```

Normalized numeric fields remain strings to prevent precision loss. Missing or `n/a` values use `available: false` and `null` numeric fields. Use `raw` when debugging an upstream HTML change and `json` for normal agent consumption.

CSV output uses one row per account-period value and RFC-compatible quoting. It includes statement metadata, table and account identifiers, English and local labels, period keys and labels, exact IDR/USD/raw values, availability, parser warnings, and fetch time. Empty numeric cells represent unavailable values.

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

The `json` and `raw` views print a versioned JSON envelope. Use `--compact` for single-line JSON:

```bash
stockbit fundamental JTPE --view json --compact
```

## Fetch broker summaries

Fetch BBCA's gross regular-market broker summary for one trading date:

```bash
stockbit broker-summary BBCA \
  --from 2026-08-19 \
  --transaction gross \
  --investor all \
  --board regular \
  --view json
```

`--to` defaults to the `--from` date. For a range:

```bash
stockbit broker-summary BBCA --from 2026-08-19 --to 2026-08-20 --view json
```

Fetch net foreign activity across all market boards:

```bash
stockbit broker-summary BBCA \
  --from 2026-08-19 \
  --transaction net \
  --investor foreign \
  --board all \
  --view json
```

Export one row per broker side to CSV:

```bash
stockbit broker-summary BBCA --from 2026-08-19 --view csv > bbca-brokers.csv
```

Supported transaction types:

| CLI value | Stockbit value | Meaning |
| --- | --- | --- |
| `gross` | `TRANSACTION_TYPE_GROSS` | Buy and sell activity is ranked independently; a broker may appear on both sides. |
| `net` | `TRANSACTION_TYPE_NET` | Each entry is the broker's buy-minus-sell difference; sell lots and values may be negative. |

Supported investor types:

| CLI value | Stockbit value |
| --- | --- |
| `all` | `INVESTOR_TYPE_ALL` |
| `domestic` | `INVESTOR_TYPE_DOMESTIC` |
| `foreign` | `INVESTOR_TYPE_FOREIGN` |

Supported market boards:

| CLI value | Stockbit value |
| --- | --- |
| `all` | `MARKET_BOARD_ALL` |
| `regular` | `MARKET_BOARD_REGULER` |
| `cash` | `MARKET_BOARD_TUNAI` |
| `negotiated` | `MARKET_BOARD_NEGO` |

The normalized `json` response includes:

- buy/sell broker counts and overlap count;
- a transaction-semantics explanation;
- normalized broker codes, side, rank, date, average price, lots, volume, value, frequency, and investor origin;
- `appears_on_both_sides` for gross analysis;
- market-detector accumulation/distribution analytics and top-broker tiers;
- exact broker numeric strings, including scientific notation and signed net sells.

For each broker, `lots` and `value` represent the requested gross or net measure. `side_volume` and `side_value` preserve Stockbit's side reference fields (`blotv`/`slotv` and `bvalv`/`svalv`).

Broker counts and overlap counts describe the rows returned under `--limit`, not every broker outside that response window.

Valid success responses may contain both sides, only one side, or two empty arrays. Empty data—observed for BBCA on `cash`/`TUNAI` for 2026-08-19—is returned with `summary.empty: true`, not treated as an error. In CSV mode, an empty response still emits one metadata row. HTTP `429` is reported as `RATE_LIMITED` with exit code `4`.

Use `--view raw` to preserve Stockbit's original response:

```bash
stockbit broker-summary BBCA --from 2026-08-19 --view raw --compact
```

## Fetch daily prices

Fetch ERAA daily OHLCV history as normalized JSON:

```bash
stockbit price ERAA \
  --from 2025-06-09 \
  --to 2026-08-31 \
  --view json
```

The CLI uses conventional range semantics: `--from` is the oldest requested date and `--to` is the newest. Stockbit's private Chartbit endpoint uses those query names in reverse, so the CLI automatically sends the newer boundary as upstream `from` and the older boundary as upstream `to`. Normalized bars are sorted oldest-first even though the raw endpoint returns newest-first.

`--from` and `--to` are both required. `--limit` defaults to `0`, which asks Stockbit for all rows in the range:

```bash
stockbit price BBCA --from 2026-01-01 --to 2026-08-28 --limit 0 --view json
```

Normalized JSON uses this shape:

```json
{
  "schema_version": "1",
  "view": "json",
  "data": {
    "symbol": "ERAA",
    "interval": "daily",
    "requested_range": {
      "from": "2025-06-09",
      "to": "2026-08-31"
    },
    "returned_range": {
      "from": "2025-06-09",
      "to": "2026-08-28"
    },
    "count": 300,
    "empty": false,
    "bars": [
      {
        "date": "2025-06-09",
        "unix_timestamp": 1749402000,
        "open": "440",
        "high": "450",
        "low": "438",
        "close": "446",
        "volume": "1234567"
      }
    ]
  },
  "meta": {
    "parser": {
      "name": "stockbit-daily-price",
      "version": "1",
      "warnings": []
    }
  }
}
```

OHLCV fields are decimal strings to avoid precision loss; `unix_timestamp` and `count` are numbers. A valid range with no sessions is returned as `count: 0`, `empty: true`, and `bars: []`.

Export one row per daily bar to CSV:

```bash
stockbit price ERAA --from 2025-06-09 --to 2026-08-31 --view csv > eraa-prices.csv
```

Use `raw` to preserve Stockbit's original `data.chartbit` payload and newest-first order:

```bash
stockbit price ERAA --from 2025-06-09 --to 2026-08-31 --view raw --compact
```

## Checks

```bash
npm run check
npm test
```
