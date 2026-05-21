# ORBilicious 0.0.8

## Table of Contents

- [Strategy rules](#strategy-rules)
- [Operational Rules](#operational-rules)
- [Logging](#logging)
- [Setup](#setup)
  - [Configure `.env`](#configure-env)
- [Web UI Usage](#web-ui-usage)
  - [Runtime Controls](#runtime-controls)
  - [How to use the Breakout Confirmation and Quality Filters](#how-to-use-the-breakout-confirmation-and-quality-filters)
  - [Trade Monitor](#trade-monitor)
  - [Daily Summary](#daily-summary)
  - [Reports](#reports)
- [Environment variables](#environment-variables)
- [Report modes and scheduling](#report-modes-and-scheduling)
- [Tests](#tests)
- [Notes](#notes)
- [Recommended next upgrades](#recommended-next-upgrades)

A complete Node + TypeScript starter project for a 15-minute Opening Range Breakout strategy on 1-minute bars with:

- Alpaca market-data integration
- Alpaca bracket-order execution
- Configurable most-active universe scan (default 40)
- Top-10 long and top-10 short candidate selection
- Weighted total stop-risk sizing
- Basket normalization to fit both total planned stop-loss risk and available buying power
- Winston-based structured logging
- Source-level ORB PDF report generation (end-of-day live or historical by date)

![ORBilicious Dashboard with Maximize Profit feature](docs/dashboard.png)

## Intended User

The intended user of this application is a person familiar with the practice of active investing in the NY Stock Markets and understands the Open Range Breakout strategy as it applies to day trading.

**Be advised:** The creator of this application is NOT a financial adviser in any sense and takes absolutely no responsibility for the performance and behavior of this application. You are using the application AT YOUR OWN RISK!

## Strategy rules
  
- Universe: configurable number of most-active stocks (default 40), determined 30 seconds after the NY market opens.
- Opening range: begins 1 minute after NY market open (default 9:31 ET) and ends 15 minutes later (default 9:46 ET).
- Entry confirmation: first 1-minute candle close above OR high for long, or below OR low for short.
- Breakout close confirmation: by default the breakout close must occur on a 5-minute confirmation candle outside the opening range (not just a 1-minute spike).
- Breakout quality filters: by default candidates must pass volume expansion, relative strength/weakness, and higher-timeframe trend alignment checks.
- Candidate trade type: Candidates can be filtered by direction. Long-only mode accepts only bullish breakouts. Short-only mode accepts only bearish breakouts. Both mode (default) accepts either direction.
- Selection: Breakout candidates for long and short trades determined by breakout score.
- Stop loss:
  - Long: The stop loss for a long trade is primarily anchored to the low of the opening range. If a breakout wick anchor exists (the bar immediately before the breakout), its high is used as the stop price for additional conservatism. If not, the stop price defaults to the most conservative value among the opening-range low, an ATR-based stop (using a 14-bar average true range up to the confirmation retest), and the minimum stop-percent rule. The stop is only valid if the distance from entry to stop is positive and not equal at two-decimal precision. If these conditions are not met, the trade is rejected.
  - Short: The stop loss for a short trade is primarily anchored to the high of the opening range. If a breakout wick anchor exists (the bar immediately before the breakout), its low is used as the stop price for additional conservatism. If not, the stop price defaults to the most conservative value among the opening-range high, an ATR-based stop (using a 14-bar average true range up to the confirmation retest), and the minimum stop-percent rule. The stop is only valid if the distance from entry to stop is positive and not equal at two-decimal precision. If these conditions are not met, the trade is rejected.
  - In both cases, the stop loss logic ensures that risk is managed by always using the most conservative and protective stop available, and trades with invalid or insufficient stop distance are not executed.
- Profit target: 4R, where R is the entry-to-stop distance. by default (1:4), or the ratio declared in the environment variable `STOP_LOSS_PROFIT_RATIO`
- Risk budget: total planned stop-loss exposure across the full basket defaults to $1000.
- Basket normalization: trade sizes are scaled so the full basket fits both:
  - configured total stop-loss risk cap
  - Alpaca account buying power
  
- Dynamic Maximize Profit Probability: The Maximize Profit Probability button uses a data-driven backend analysis. When clicked, it fetches recent historical price data for the selected symbol and session, analyzes volume expansion, relative strength, and trend, and automatically sets the breakout confirmation and quality filter values to optimize for current market conditions. This enables adaptive, context-aware filter settings for each run.

## Operational Rules

The list below follows the order the app actually applies rules at runtime.

1. Startup configuration is validated first. Required Alpaca credentials must exist, numeric settings must parse, `STOP_LOSS_PROFIT_RATIO` must be a valid `risk:reward` pair, `SESSION_MODE` must be `EMULATION`, `PAPER`, or `LIVE`, and `SESSION_DATE` is normalized to `YYYY-MM-DD`.
2. Execution mode is derived next. `EMULATION` always sets `dryRun=true`, `PAPER` and `LIVE` allow real order submission, and `--continuous` keeps the current-day scheduler running across sessions instead of exiting after one session.
3. The app then splits into one of two operating paths: historical emulation or current-day scheduling. Historical emulation is only selected when `SESSION_MODE=EMULATION` and `SESSION_DATE` is set to a date before the current New York date. Live emulation for today stays on the current-day path.
4. In historical emulation, the app builds an inclusive date range from `SESSION_DATE` through the current New York date, then filters that range to weekdays only. If no weekday sessions remain, the run ends immediately.
5. For each historical weekday session, the app emits UI progress messages in this order: `Determing open range.`, then `High range prices: {HIGH_RANGE_PRICE}, Low range prices: {LOW_RANGE_PRICE}.`, then `Waiting for breakouts` with the current most-active symbol list when available.
6. Each historical session then generates a full ORB report. If a session cannot be generated because data is unavailable or another error occurs, that session is skipped and the run continues to the next weekday.
7. In current-day mode, the loop runs forever until it is allowed to exit. On weekends it does nothing except wait. Before the New York open it does nothing except wait for the market to open.
8. During market hours, the first 15 minutes are treated as opening-range discovery time. The UI reports `Determing open range.` during that window.
9. After the opening-range window completes, the app computes and publishes the opening-range high and low, then publishes `Waiting for breakouts` with the current most-active symbol list when available.
10. Every active cycle starts by loading the Alpaca account. If `tradingBlocked` is true, the cycle stops immediately and no candidate evaluation or order logic runs.
11. The candidate universe is the top `QUANTITY_TO_RETRIEVE` most-active symbols from Alpaca. The default is 40 symbols, and the Web UI can override this per run using the "Most active stocks to scan" spinner.
12. Candidate trade type filtering is applied next. If `CANDIDATE_TRADE_TYPE=LONG`, only breakout candidates with side `buy` are kept. If `CANDIDATE_TRADE_TYPE=SHORT`, only candidates with side `sell` are kept. If `CANDIDATE_TRADE_TYPE=LONG_AND_SHORT` (default), all candidates are kept.
13. Each symbol is evaluated independently. If the account already has an open position in that symbol, the app switches from entry logic to profit-capture management instead of generating a new breakout candidate.
14. Existing-position management follows this order: if the position has no entry price, it is skipped; if there are no session bars, it is skipped; if the current bar is earlier than `FORCE_EXIT_TIME`, it is skipped; at or after `FORCE_EXIT_TIME`, the position is only closed if the latest close is favorable relative to entry price, meaning `latestClose >= entryPrice` for longs or `latestClose <= entryPrice` for shorts.
15. When an existing position is closed by the profit-capture rule, the UI reports `Closing {SYMBOL} for a {PROFIT_LOSS_STATUS} of {PROFIT_LOSS_AMOUNT}.` and the trade monitor records a close event. In `EMULATION`, this is logged as a dry-run close instead of sending a live close order.
16. If no open position exists, duplicate-entry protection is applied next. Any symbol already present in the in-memory `executedToday` set for that session date is skipped.
17. If the symbol has no intraday bars for the session, it is skipped.
18. Candidate construction begins by deduplicating bars, filtering them to the current session date in New York time, and computing the opening range from the configured market open through the first `OPENING_RANGE_MINUTES` minutes. With default settings, that means 1-minute bars from 9:30 through 9:44 ET, and all required bars must exist or the candidate fails.
19. Breakout detection then examines only the next opening-range-sized evaluation window after the opening range. With defaults, that means the next 15 minutes, evaluated using `BREAKOUT_CONFIRMATION_CANDLE_MINUTES` (default 5-minute candles). A breakout attempt is only created when that candle closes outside the opening range.
20. Breakout quality filters are then applied (enabled by default). The breakout must pass minimum volume expansion, minimum relative strength/weakness beyond the opening-range boundary, and higher-timeframe trend alignment.
21. A breakout is not tradeable by itself. The app requires a confirmation retest after the breakout bar. For longs, a later bar must trade back to or below opening-range high and still close above opening-range high. For shorts, a later bar must trade back to or above opening-range low and still close below opening-range low.
22. The bar immediately before the breakout becomes the wick anchor for stop placement. Its high is used for long stop anchoring and its low is used for short stop anchoring.
23. ATR is then computed from session bars up through the confirmation retest using a 14-bar average true range. If ATR cannot be computed or is not positive, the candidate is rejected.
24. Candidate score is computed as `relative breakout percent * log10(total session volume)`. Only candidates with score greater than `MIN_SCORE` survive sizing.
25. Surviving candidates are ranked separately by side. The app keeps the top `MAX_POSITIONS_PER_SIDE` longs and top `MAX_POSITIONS_PER_SIDE` shorts by score. The current default is 3 per side.
26. Risk dollars are assigned proportionally by score across the selected basket, using `MAX_TOTAL_RISK` as the total planned stop-loss budget.
27. Stop price is determined next. If a breakout wick anchor exists, it is used first. Otherwise the stop falls back to the most conservative price produced by the opening-range bound, the ATR-based stop, and the minimum stop-percent rule.
28. Any trade is rejected if stop distance is zero or negative, if entry price and stop price are equal at two-decimal execution precision, or if computed quantity falls below the minimum quantity threshold.
29. Profit target is then set to `takeProfitMultiple * stopDistance`, which is 4R by default because `STOP_LOSS_PROFIT_RATIO` defaults to `1:4`.
30. After initial sizing, the basket is normalized in two passes. First each trade is individually scaled down to obey `MAX_POSITION_NOTIONAL`. Then the whole basket is scaled by the smaller of the risk cap scale and the available buying power scale. Quantities are floored to four decimal places, and anything below the minimum quantity is dropped.
31. Before execution, duplicate-entry protection is applied again at the trade basket stage. Any already-executed symbol for the session date is skipped.
32. In `EMULATION`, entries are never submitted to Alpaca. The app only logs dry-run entries and emits trade-monitor events. In `PAPER` and `LIVE`, the app submits Alpaca bracket orders with the computed entry side, quantity, stop, and take-profit prices.
33. When historical reports contain closed trades, the UI reports `Closing {SYMBOL} for a {PROFIT_LOSS_STATUS} of {PROFIT_LOSS_AMOUNT}.` before emitting the close event into the trade monitor.
34. After `FORCE_EXIT_TIME`, if the end-of-day report for the session has not yet been generated, the app generates it once. In one-shot current-day mode the process then exits. In continuous mode it stays alive and waits for the next session.

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

1. Install dependencies:

```bash
npm install
```

1. Create and configure `.env` as described below.

### Configure `.env`

Use [.env.example](.env.example) as the starting template for your local runtime configuration.

Copy the file into `.env`:

```bash
cp .env.example .env
```

Then edit `.env` for operational use:

1. Set `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` to your own Alpaca credentials.
2. Set `SESSION_MODE` to the mode you intend to run: `EMULATION`, `PAPER`, or `LIVE`. (This value is reset automatically when the UI resets the value.)
3. Set `SESSION_DATE` to a historical date for historical emulation, or leave it blank for current-day operation. (This value is reset automatically when the UI resets the value.)
4. Set `ALPACA_DATA_FEED` to `iex` if delayed market data is acceptable, or `sip` if your Alpaca account has the required entitlement for real-time consolidated market data.
5. Review trading controls such as `MAX_TOTAL_RISK`, `HARD_BASKET_CAP`, `MAX_POSITION_NOTIONAL`, and `MAX_POSITIONS_PER_SIDE` before running. (This value is reset automatically when the UI resets the value.)
6. If you are operating against live capital, verify `ALPACA_TRADING_BASE_URL`, `SESSION_MODE=LIVE`, and all risk settings before starting the app.

The comments in [.env.example](/home/reselbob/Projects/orbilicious/.env.example) explain the meaning of each variable inline.

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

![Runtime Controls](docs/runtime-controls.png)

- **Session mode**: Choose `EMULATION` (Alpaca data, no orders), `PAPER` (paper trading), or `LIVE` (live trading).
- **Emulation session date**: For `EMULATION` mode, select a past trading day to run a historical backtest from that date forward.
- **Most active stocks to scan**: Set how many most-active symbols are retrieved before breakout candidate discovery starts (default `40`).
- **Continuous mode**: Run the strategy continuously (only available in `PAPER` and `LIVE` modes).
- **Breakout Candidate Trade Type**: Filter which breakout directions are considered. Choose `Long` to accept only bullish breakouts, `Short` to accept only bearish breakouts, or `Both` (default) to accept either direction.
- **Money in Account**: Total account capital available (default $25,000). Overrides `HARD_BASKET_CAP` env var.
- **Max Amount to Risk Per Trading Day**: Maximum total stop-loss risk per day (default $1,000). Overrides `MAX_TOTAL_RISK` env var.
- **Current status**: Real-time execution state (running, stopped, error details).
- **Backtest progress**: For historical runs, shows current date, total dates, and completion.

### How to use the Breakout Confirmation and Quality Filters

![Breakout Confirmation and Quality Filters](docs/breakout-quality-filter.png)

Use these controls together to reduce false breakouts while keeping enough opportunities for your session goals.

- **Breakout Confirmation Candle (minutes)** controls how long the breakout candle is. The breakout must close outside the opening range on this timeframe.
- **Breakout Quality Filters** turns quality gating on or off. Quality gating means a breakout must pass all enabled quality checks before it is considered tradeable (volume expansion, relative strength/weakness, and higher-timeframe trend alignment).
- **Min Volume Expansion** requires breakout-candle volume to exceed recent confirmation-candle volume by a minimum ratio.
- **Min Relative Strength (%)** requires the breakout close to clear the opening-range boundary by a minimum percentage.
- **Trend Timeframe (minutes)** and **Trend Lookback Bars** define higher-timeframe trend alignment.

Suggested workflow:

1. Start with defaults (`5` minute confirmation, quality filters enabled, volume `1.2`, relative strength `0.25`, trend timeframe `5`, lookback `3`).
2. Run emulation for several recent sessions and watch candidate count, pass/fail behavior, and P/L consistency.
3. Tighten filters when you see too many weak or whipsaw entries.
4. Relax filters when you see too few candidates or missed valid breakouts.
5. Change one setting at a time so you can attribute the impact.

Concrete examples:

1. **Noisy open, too many fake breaks**
Configuration purpose: make confirmation stricter so brief spikes do not qualify as breakouts.
Configuration: set Breakout Confirmation Candle to `10` and keep Quality Filters enabled.
Expected outcome: fewer breakout candidates, later but higher-confidence entries, and reduced churn from quick reversals.

2. **Strong trend day, but valid breakouts are being missed**
Configuration purpose: allow more momentum names through without fully removing quality checks.
Configuration: keep confirmation at `5`, lower Min Relative Strength to `0.15`, and lower Min Volume Expansion to `1.1`.
Expected outcome: more candidates pass during broad directional moves, with a moderate increase in trade frequency and slightly more variance in results.

3. **Choppy session with mixed direction and weak follow-through**
Configuration purpose: require stronger alignment so only the cleanest breakouts survive.
Configuration: keep confirmation at `5`, raise Min Volume Expansion to `1.5`, raise Min Relative Strength to `0.35`, set Trend Timeframe to `15`, and Trend Lookback Bars to `4`.
Expected outcome: candidate list shrinks meaningfully, entries align better with sustained trend context, and whipsaw exposure is reduced at the cost of fewer total trades.

### Filter Attribution in Reports

Every generated HTML report includes a **Filter Attribution** section that records the per-candidate quality-filter outcome for each symbol that produced a valid breakout bar and a confirmation retest during the session. This section is designed to support ongoing attribution analysis so you can tune filter settings over time with real data instead of intuition alone.

Each row in the table shows:

| Column | Description |
|---|---|
| **Symbol** | The evaluated ticker. |
| **Side** | Breakout direction (`buy` or `sell`). |
| **Result** | `PASS` if the candidate survived all quality checks; `FAIL` otherwise. |
| **Vol Expansion** | Measured breakout-candle volume divided by prior confirmation-candle average, alongside the configured minimum. |
| **VE ✓/✗** | Whether the volume expansion check passed. |
| **Rel Strength** | Measured close-to-OR-boundary move as a percentage, alongside the configured minimum. |
| **RS ✓/✗** | Whether the relative strength check passed. |
| **Trend** | Whether the higher-timeframe close and slope were aligned with the breakout direction. |
| **TR ✓/✗** | Whether the trend alignment check passed. |
| **Notes** | Any skip reason or multi-filter fail details. When quality filters are globally disabled the row shows `filters off`. |

When quality filters are disabled (`BREAKOUT_QUALITY_FILTERS_ENABLED=false`), all candidates automatically pass and the individual check columns show `n/a`. The table is still populated so you can see the full breakout universe considered for each session.

Rows are sorted with passing candidates first. The interactive drilldown cards in the dark-mode HTML report also include a **Quality Filters** sub-table showing the same per-filter detail inline with the chart and trade data.

To use this data for attribution analysis:

1. Run emulation across several historical sessions using your current filter settings.
2. Open the HTML reports and compare the **Filter Attribution** table against the **Breakout Candidates** trade outcomes.
3. Look for patterns: symbols that failed a specific check but would have been profitable, or symbols that passed all checks but still lost.
4. Adjust one filter threshold at a time and re-run the same sessions to measure the change in both candidate count and P/L distribution.

### Trade Monitor

![Trade Monitor](docs/trade-monitor.png)

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

![Reports](docs/reports.png)

- **Select a report**: Choose from generated HTML or PDF reports.
- **Refresh List**: Fetch latest reports from the `reports/` directory.
- **Open Report**: Display the selected report in an embedded viewer.

### Reports Detail

![Reports](docs/reports-detail.png)

The **candlestick chart** plots 1-minute bars for the session with the opening-range window shaded. The legend identifies:

- **OR High/Low** (yellow dashes) — the opening-range boundaries calculated from the first 15 minutes of trading
- **Stop price** (orange dashes) — the stop-loss level set at the wick of the bar immediately before the breakout
- **Profit target** (green dashes) — the 4R take-profit level based on the entry-to-stop distance
- **Close price** (purple dashes) — the exit price of the trade
- **Entry triangle** (blue) — marks the entry point at the confirmation retest close
- **Determination line** (vertical blue dashed) — the point at which the breakout retest was confirmed

Below the chart, each detail row lists:

- **Symbol** — the ticker being evaluated
- **Opening price** — the first traded price of the session
- **OR High / OR Low** — the highest and lowest prices during the 15-minute opening range
- **Breakout price / timestamp** — the price and time of the first confirmation-candle close outside the opening range
- **Confirmation retest price / timestamp** — the price and time of the subsequent bar that traded back to the opening-range boundary and closed beyond it
- **ATR** — the 14-bar average true range used for evaluating stop-distance viability
- **Side** — whether the breakout was a buy (long) or sell (short) signal

## Environment variables

The app reads configuration from `.env` (via `dotenv`) and supports the following variables.

| Variable | Required | Default | Purpose and use |
| --- | --- | --- | --- |
| `ALLOW_LONG` | No | `true` | Enables long-side trade eligibility. |
| `ALLOW_SHORT` | No | `true` | Enables short-side trade eligibility. |
| `ALPACA_DATA_BASE_URL` | No | `https://data.alpaca.markets` | Base URL for market data endpoints. |
| `CANDIDATE_TRADE_TYPE` | No | `LONG_AND_SHORT` | Filter breakout candidates by direction. Use `LONG` to accept only bullish breakouts, `SHORT` to accept only bearish breakouts, or `LONG_AND_SHORT` (default) to accept either direction. |
| `ALPACA_DATA_FEED` | No | `iex` | Alpaca market data feed selector. Use `iex` for the default feed, which may be delayed, or `sip` for real-time consolidated data if your Alpaca subscription supports it. |
| `ALPACA_TRADING_BASE_URL` | No | Mode-dependent (`https://paper-api.alpaca.markets` for `EMULATION`/`PAPER`, `https://api.alpaca.markets` for `LIVE`) | Optional override for trading/account endpoint base URL. |
| `APCA_API_KEY_ID` | Yes | None | Alpaca API key ID. Required for all Alpaca data/account/order API calls. |
| `APCA_API_SECRET_KEY` | Yes | None | Alpaca API secret key paired with `APCA_API_KEY_ID`. |
| `ATR_STOP_MULTIPLE` | No | `1` | ATR multiplier used as one candidate stop-distance component in sizing fallback. |
| `BREAKOUT_CONFIRMATION_CANDLE_MINUTES` | No | `5` | Candle size (in minutes) used to confirm breakout closes outside the opening range. |
| `BREAKOUT_QUALITY_FILTERS_ENABLED` | No | `true` | Enables breakout quality filters (volume expansion, relative strength/weakness, higher-timeframe trend alignment). |
| `BREAKOUT_MIN_VOLUME_EXPANSION` | No | `1.2` | Minimum breakout-candle volume expansion ratio versus earlier confirmation candles. |
| `BREAKOUT_MIN_RELATIVE_STRENGTH_PCT` | No | `0.25` | Minimum percent close beyond opening-range high/low required for breakout strength. |
| `BREAKOUT_TREND_TIMEFRAME_MINUTES` | No | `5` | Higher-timeframe candle size used for trend alignment checks. |
| `BREAKOUT_TREND_LOOKBACK_BARS` | No | `3` | Number of higher-timeframe bars used to evaluate trend direction before breakout. |
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
| `QUANTITY_TO_RETRIEVE` | No | `40` | Number of most-active symbols to request from Alpaca for candidate generation. In Web UI runs, this is overridden by the Most active stocks to scan control when provided. |
| `SESSION_DATE` | No | Empty | Session date (`YYYY-MM-DD`). If set, app runs a one-shot historical report for that date and exits; if empty, app runs current-day live scheduling and generates end-of-day report(s). |
| `SESSION_MODE` | No | `EMULATION` | Execution mode: `EMULATION` (Alpaca data, no order submission), `PAPER` (Alpaca paper trading), `LIVE` (Alpaca live trading). |
| `STOP_LOSS_PROFIT_RATIO` | No | `1:4` | Risk/reward ratio in `risk:reward` format. Example `1:2` gives a 2R target. |
| `SYMBOL` | No | `SPY` | Strategy config symbol baseline (kept for config completeness; main scanner still uses most-active universe). |

Notes:

- Date inputs are validated and normalized to `YYYY-MM-DD`.
- Boolean values are parsed as lowercase string `true` or `false`.
- Numeric values must parse as valid numbers or startup will fail fast.
- `ALPACA_DATA_FEED=iex` still allows the app to run, but prices can lag real-time market websites. Use `ALPACA_DATA_FEED=sip` when you need real-time Alpaca data and your account is entitled to that feed.

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
