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
2. Fill in your Alpaca API credentials
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

## Web UI Usage

The web client provides a complete control panel to run and monitor the ORB strategy. Start it using:

```bash
./start.sh
```

This launches both the trading app and web server on port 8787 (or use `WEB_PORT=XXXX ./start.sh` to override), and opens the browser automatically.

### Runtime Controls

- **Session mode**: Choose `EMULATION` (Alpaca data, no orders), `PAPER` (paper trading), or `LIVE` (live trading).
- **Emulation session date**: For `EMULATION` mode, select a past trading day to run a historical backtest from that date forward.
- **Continuous mode**: Run the strategy continuously (only available in `PAPER` and `LIVE` modes).
- **Money in Account**: Total account capital available (default $25,000). Overrides `HARD_BASKET_CAP` env var.
- **Max Amount to Risk Per Trading Day**: Maximum total stop-loss risk per day (default $1,000). Overrides `MAX_TOTAL_RISK` env var.
- **Current status**: Real-time execution state (running, stopped, error details).
- **Backtest progress**: For historical runs, shows current date, total dates, and completion.

### Trade Monitor

Live view of all executed entries and closes with:

- **Date/Time**: When the trade entry or close occurred.
- **Status**: `OPEN` for entries, `CLOSED` for exits.
- **Symbol, Side, Qty**: Trade details.
- **Entry, Stop, Target, Close**: Price levels.
- **P/L**: Profit/loss for closed trades, or "Open" for active positions. Green text for profits, red for losses.

Expand the pane to see more rows at once.

### Daily Summary

Aggregated profit/loss by trading day. Shows:

- **Date**: Calendar day.
- **Total P/L**: Sum of all closed-trade P/L for that day. Green for net profit, red for net loss.

Expand the pane to scroll through historical days.

### Reports

- **Select a report**: Choose from generated HTML or PDF reports.
- **Refresh List**: Fetch latest reports from the `reports/` directory.
- **Open Report**: Display the selected report in an embedded viewer.

## Environment variables

The app reads configuration from `.env` (via `dotenv`) and supports the following variables.

| Variable | Required | Default | Purpose and use |
| --- | --- | --- | --- |
| `ALLOW_LONG` | No | `true` | Enables long-side trade eligibility. |
| `ALLOW_SHORT` | No | `true` | Enables short-side trade eligibility. |
| `ALPACA_DATA_BASE_URL` | No | `https://data.alpaca.markets` | Base URL for market data endpoints. |
| `ALPACA_DATA_FEED` | No | `iex` | Data feed selector used when requesting Alpaca market data. |
| `ALPACA_TRADING_BASE_URL` | No | Mode-dependent (`https://paper-api.alpaca.markets` for `EMULATION`/`PAPER`, `https://api.alpaca.markets` for `LIVE`) | Optional override for trading/account endpoint base URL. |
| `APCA_API_KEY_ID` | Yes | None | Alpaca API key ID. Required for all Alpaca data/account/order API calls. |
| `APCA_API_SECRET_KEY` | Yes | None | Alpaca API secret key paired with `APCA_API_KEY_ID`. |
| `ATR_STOP_MULTIPLE` | No | `1` | ATR multiplier used as one candidate stop-distance component in sizing fallback. |
| `CANDLE_MINUTES` | No | `1` | Bar interval used by strategy logic. |
| `FORCE_EXIT_TIME` | No | `15:55` | NY cutoff used for end-of-day position management and cycle close/report timing. |
| `HARD_BASKET_CAP` | No | `25000` | Hard maximum total notional for the entire basket after normalization. |
| `LAST_ENTRY_TIME` | No | `15:30` | Last allowed NY time for new entries in live loop mode. |
| `LOG_LEVEL` | No | `debug` in development, `info` otherwise | Logger verbosity (`error`, `warn`, `info`, `debug`, etc.). |
| `MAX_POSITIONS_PER_SIDE` | No | `3` | Max number of selected long candidates and short candidates each (top-N per side). |
| `MAX_POSITION_NOTIONAL` | No | `5000` | Per-position notional cap applied before final basket scaling. |
| `MAX_TOTAL_RISK` | No | `1000` | Basket-wide planned stop-loss dollar cap before normalization. |
| `MIN_STOP_PCT` | No | `0.0075` | Minimum stop distance as a fraction of entry price (example: `0.0075` = 0.75%). |
| `NODE_ENV` | No | `development` | Runtime environment mode used for logging format/verbosity defaults. |
| `OPENING_RANGE_MINUTES` | No | `15` | Number of minutes used to build the opening range window. |
| `POLL_INTERVAL_SECONDS` | No | `20` | Wait interval between live loop cycles. |
| `QTY` | No | `1` | Baseline strategy quantity field in config. Not used by weighted basket sizing path. |
| `QUANTITY_TO_RETRIEVE` | No | `40` | Number of most-active symbols to request from Alpaca for candidate generation. |
| `SESSION_DATE` | No | Empty | Session date (`YYYY-MM-DD`). If set, app runs a one-shot historical report for that date and exits; if empty, app runs current-day live scheduling and generates end-of-day report(s). |
| `SESSION_MODE` | No | `EMULATION` | Execution mode: `EMULATION` (Alpaca data, no order submission), `PAPER` (Alpaca paper trading), `LIVE` (Alpaca live trading). |
| `STOP_LOSS_PROFIT_RATIO` | No | `1:4` | Risk/reward ratio in `risk:reward` format. Example `1:2` gives a 2R target. |
| `SYMBOL` | No | `SPY` | Strategy config symbol baseline (kept for config completeness; main scanner still uses most-active universe). |

Notes:

- Date inputs are validated and normalized to `YYYY-MM-DD`.
- Boolean values are parsed as lowercase string `true` or `false`.
- Numeric values must parse as valid numbers or startup will fail fast.

## Report modes and scheduling

- **Live end-of-day mode (default):** If `SESSION_DATE` is not set, app runs current-day scheduling, starts trading logic at market open, generates one end-of-day ORB report after market close, then exits.
- **Live continuous mode:** Start with `--continuous` (or `-c`) to keep the process running across sessions. In this mode, data gathering/trade cycles run while NY markets are open, end-of-day report generation runs once per session, and the app waits for the next session instead of exiting.
- **Historical one-shot mode:** If `SESSION_DATE=YYYY-MM-DD` is set, app runs a single historical ORB report for that session date and exits.

Usage:

```bash
# Live daily loop with end-of-day report then exit:
npm run dev

# Live continuous mode across sessions:
npm run dev -- --continuous

# Historical report for a specific date:
SESSION_DATE=2026-05-14 npm run dev
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
- This should be tested in Alpaca PAPER mode before any live use.

## Recommended next upgrades

- Check open orders before sizing and execution.
- Persist daily execution state so restarts do not lose duplicate-entry protection.
- Use an exchange calendar and DST-safe session handling.
- Add asset-tradability and shortability checks.
- Add retry/backoff and rate-limit handling around Alpaca API requests.
