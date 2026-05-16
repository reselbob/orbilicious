# ORB Alpaca Node

A complete Node + TypeScript starter project for a 15-minute Opening Range Breakout strategy on 1-minute bars with:

- Alpaca market-data integration
- Alpaca bracket-order execution
- Top-40 most active universe scan
- Top-10 long and top-10 short candidate selection
- Weighted total stop-risk sizing
- Basket normalization to fit both total planned stop-loss risk and available buying power
- Winston-based structured logging
- Source-level ORB PDF report generation (end-of-day live or historical by date)

## Strategy rules

- Universe: top 40 most active stocks.
- Opening range: 9:30 to 9:44 ET.
- Entry confirmation: first 1-minute candle close above OR high for long, or below OR low for short.
- Selection: top 10 longs and top 10 shorts by breakout score.
- Stop loss:
  - Long: opening-range low
  - Short: opening-range high
- Profit target: 4R, where R is the entry-to-stop distance.
- Risk budget: total planned stop-loss exposure across the full basket defaults to $1000.
- Basket normalization: trade sizes are scaled so the full basket fits both:
  - configured total stop-loss risk cap
  - Alpaca account buying power

## Logging

Logs are written to:

- `logs/combined.log`
- `logs/errors.log`
- `logs/exceptions.log`
- `logs/rejections.log`

Console output is also enabled.

Use `.env` to control log verbosity:

```bash
LOG_LEVEL=debug
```

## Setup

1. Copy `.env.example` to `.env`
2. Fill in your Alpaca paper credentials
3. Install dependencies:

```bash
npm install
```

1. Run in dev mode:

```bash
npm run dev
```

1. Or build and run:

```bash
npm run build
npm start
```

## Environment variables

The app reads configuration from `.env` (via `dotenv`) and supports the following variables.

| Variable | Required | Default | Purpose and use |
| --- | --- | --- | --- |
| `APCA_API_KEY_ID` | Yes | None | Alpaca API key ID. Required for all Alpaca data/account/order API calls. |
| `APCA_API_SECRET_KEY` | Yes | None | Alpaca API secret key paired with `APCA_API_KEY_ID`. |
| `APCA_PAPER` | No | `true` | Set `true` to use paper account behavior; set `false` for live account credentials/environment. |
| `ALPACA_TRADING_BASE_URL` | No | `https://paper-api.alpaca.markets` | Base URL for trading/account endpoints. Change only if targeting a different Alpaca environment. |
| `ALPACA_DATA_BASE_URL` | No | `https://data.alpaca.markets` | Base URL for market data endpoints. |
| `ALPACA_DATA_FEED` | No | `iex` | Data feed selector used when requesting Alpaca market data. |
| `SYMBOL` | No | `SPY` | Strategy config symbol baseline (kept for config completeness; main scanner still uses most-active universe). |
| `QTY` | No | `1` | Baseline strategy quantity field in config. Not used by weighted basket sizing path. |
| `OPENING_RANGE_MINUTES` | No | `15` | Number of minutes used to build the opening range window. |
| `CANDLE_MINUTES` | No | `1` | Bar interval used by strategy logic. |
| `LAST_ENTRY_TIME` | No | `15:30` | Last allowed NY time for new entries in live loop mode. |
| `FORCE_EXIT_TIME` | No | `15:55` | NY cutoff used to stop intraday cycle and transition to report timing. |
| `ALLOW_LONG` | No | `true` | Enables long-side trade eligibility. |
| `ALLOW_SHORT` | No | `true` | Enables short-side trade eligibility. |
| `SESSION_DATE` | No | Empty | Optional fixed trading session date (`YYYY-MM-DD`) for cycle logic instead of current NY date. |
| `RUN_DATE` | No | Empty | Historical one-shot report mode date (`YYYY-MM-DD`). If set, app generates report for that date and exits. |
| `POLL_INTERVAL_SECONDS` | No | `20` | Wait interval between live loop cycles. |
| `MAX_TOTAL_RISK` | No | `1000` | Basket-wide planned stop-loss dollar cap before normalization. |
| `HARD_BASKET_CAP` | No | `25000` | Hard maximum total notional for the entire basket after normalization. |
| `QUANTITY_TO_RETRIEVE` | No | `40` | Number of most-active symbols to request from Alpaca for candidate generation. |
| `MAX_POSITIONS_PER_SIDE` | No | `3` | Max number of selected long candidates and short candidates each (top-N per side). |
| `MAX_POSITION_NOTIONAL` | No | `5000` | Per-position notional cap applied before final basket scaling. |
| `ATR_STOP_MULTIPLE` | No | `1` | ATR multiplier used as one candidate stop-distance component in sizing. |
| `MIN_STOP_PCT` | No | `0.0075` | Minimum stop distance as a fraction of entry price (example: `0.0075` = 0.75%). |
| `STOP_LOSS_PROFIT_RATIO` | No | `1:4` | Risk/reward ratio in `risk:reward` format. Example `1:2` gives a 2R target. |
| `DRY_RUN` | No | `true` | When `true`, computes and logs trades without submitting orders. Set `false` to allow live order submission path. |
| `LOG_LEVEL` | No | `debug` in development, `info` otherwise | Logger verbosity (`error`, `warn`, `info`, `debug`, etc.). |
| `NODE_ENV` | No | `development` | Runtime environment mode used for logging format/verbosity defaults. |

Notes:

- Date inputs are validated and normalized to `YYYY-MM-DD`.
- Boolean values are parsed as lowercase string `true` or `false`.
- Numeric values must parse as valid numbers or startup will fail fast.

## Report modes and scheduling

- **Live end-of-day mode (default):** If `RUN_DATE` is not set, app runs continuously, starts trading logic at market open, stops trading logic at market close, generates one end-of-day ORB PDF report per trading day, then waits for the next market day.
- **Historical one-shot mode:** If `RUN_DATE=YYYY-MM-DD` is set, app runs a single historical ORB report for that session date and exits.

Usage:

```bash
# Live daily loop with end-of-day reports:
npm run dev

# Historical report for a specific date:
RUN_DATE=2026-05-14 npm run dev
```

## Tests

This project uses Mocha + Chai for integration tests.

The test suite covers:

- time utilities
- ORB signal generation
- weighted-risk basket sizing
- basket normalization against risk and buying power
- Alpaca REST read integrations via mocked fetch
- bracket-order request payload construction

The test suite does **not** execute real trades.

Run tests with:

```bash
npm test
```

## Notes

- This project uses direct Alpaca REST calls rather than a separate SDK wrapper.
- Bracket orders are submitted using Alpaca's `/v2/orders` endpoint.
- Buying power is read from Alpaca's `/v2/account` endpoint before basket normalization.
- Realized losses can still exceed planned stop-loss exposure because of slippage, fast markets, gaps, and execution behavior.
- This should be tested in Alpaca paper trading before any live use.

## Recommended next upgrades

- Check open orders before sizing and execution.
- Persist daily execution state so restarts do not lose duplicate-entry protection.
- Use an exchange calendar and DST-safe session handling.
- Add asset-tradability and shortability checks.
- Add retry/backoff and rate-limit handling around Alpaca API requests.
