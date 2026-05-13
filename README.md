# ORB Alpaca Node

A complete Node + TypeScript starter project for a 15-minute Opening Range Breakout strategy on 1-minute bars with:

- Alpaca market-data integration
- Alpaca bracket-order execution
- Top-40 most active universe scan
- Top-10 long and top-10 short candidate selection
- Weighted total stop-risk sizing
- Basket normalization to fit both total planned stop-loss risk and available buying power
- Winston-based structured logging

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

- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`
- `APCA_PAPER`
- `ALPACA_TRADING_BASE_URL`
- `ALPACA_DATA_BASE_URL`
- `ALPACA_DATA_FEED`
- `SYMBOL`
- `QTY`
- `OPENING_RANGE_MINUTES`
- `CANDLE_MINUTES`
- `LAST_ENTRY_TIME`
- `FORCE_EXIT_TIME`
- `ALLOW_LONG`
- `ALLOW_SHORT`
- `SESSION_DATE`
- `POLL_INTERVAL_SECONDS`
- `MAX_TOTAL_RISK`
- `LOG_LEVEL`
- `NODE_ENV`

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
