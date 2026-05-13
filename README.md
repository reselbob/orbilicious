# Orbilicious

**Work in progress**

Orbilicious is a TypeScript-based Node.js trading program that scans the 40 most active U.S. stocks at the market open and looks for [Opening Range Breakout](navigational_search:Opening Range Breakout strategy) (ORB) trade setups using a 15-minute opening range and 5-minute candles.

The system is intended to identify intraday momentum opportunities after the opening range is established, then pass qualified setups to a typed execution module.

## TypeScript orientation

Orbilicious is designed to be implemented in TypeScript rather than plain JavaScript. This means the program should favor:

- explicit interfaces for domain models,
- strongly typed state transitions,
- typed configuration objects,
- typed collections such as `Map<string, SymbolState>`,
- and clear separation between market-data ingestion, signal generation, risk logic, and execution.

TypeScript is a good fit here because the program manages multiple kinds of structured data, including candles, symbols, trade candidates, risk settings, and execution instructions. Strong typing should reduce errors caused by ambiguous object shapes and make the trading workflow easier to maintain as the system grows.

## Strategy overview

An opening range is the high-low price interval formed during the first part of the trading session, commonly 15, 30, or 60 minutes.

In this project, the opening range is defined as the first 15 minutes after the market opens, using 5-minute candlesticks.

The core idea is:

1. Identify the most active stocks at the open.
2. Build the 15-minute opening range for each symbol from 5-minute candles.
3. Watch for a retest of the range high or low after the opening range is established.
4. Confirm that price is moving away from the range after the retest.
5. If confirmed, mark the symbol as a trade candidate and send it to the execution logic.

## Workflow

### 1. Build the watchlist

At the market open, collect 40 symbols from the most active stocks across the NYSE and Nasdaq.

> Note: the exact data source and selection rules should be configurable, because “most active” rankings depend on the provider and may update intraday.

A TypeScript implementation should represent the watchlist with typed records so that symbol, exchange, and rank metadata are validated at compile time.

### 2. Capture the opening range

For each symbol in the watchlist:

1. Collect 5-minute candlesticks for the first 15 minutes of regular trading.
2. Store the candlesticks in a symbol-specific structure, such as a `Map<string, SymbolState>`, rather than separate arrays.
3. Calculate:
   - Opening range high
   - Opening range low
   - Opening range width

A valid opening range breakout strategy depends on identifying the high and low of that initial interval and then monitoring price action around those levels.

### 3. Detect the retest

After the first 15 minutes have completed, process each symbol independently.

For each symbol:

1. Wait for price to revisit either:
   - the opening range high, or
   - the opening range low
2. Treat that revisit as a **retest event**.
3. After a retest occurs, monitor the next 5 minutes of price action.
4. If price rejects the level and moves away from the range boundary with sufficient momentum, mark the symbol as a trade candidate.

A TypeScript implementation should make this state progression explicit by using a union type or enum for setup status, rather than relying on loosely named boolean flags alone.

## Trade candidate logic

A symbol is added to the `tradeCandidates` collection when all of the following are true:

- The 15-minute opening range has been established.
- Price retests either the opening range high or low.
- The retest is followed by confirmation that price is moving away from that level.
- The move still satisfies the risk rules defined by the position-sizing module.

This design helps avoid entering on the first touch and instead waits for additional confirmation before creating a setup.

In TypeScript, `tradeCandidates` should be modeled as a typed collection of normalized trade setup objects rather than raw symbol strings.

## Trade execution

Once a symbol is added to `tradeCandidates`, pass it to the execution module.

The execution module should accept a strongly typed trade instruction object that includes direction, symbol, planned entry, stop price, target price, and share quantity.

### Long setup

If price breaks and confirms above the opening range high:

1. Enter a **long** trade.
2. Use the candle immediately before the impulse candle as the reference candle.
3. Set the stop price near the **low of that reference candle’s wick**, or by whatever stop rule is ultimately configured.
4. Calculate the profit target from the configured reward-to-risk ratio.

### Short setup

If price breaks and confirms below the opening range low:

1. Enter a **short** trade.
2. Use the candle immediately before the impulse candle as the reference candle.
3. Set the stop price near the **high of that reference candle’s wick**, or by whatever stop rule is ultimately configured.
4. Calculate the profit target from the configured reward-to-risk ratio.

### Impulse candle

An **impulse candle** is the candle that decisively breaks above the opening range high or below the opening range low and begins the directional move away from the range.

## Risk and position sizing

The overall goal is to execute as many valid ORB trades as possible from the selected 40 symbols while keeping total daily risk within a fixed limit.

By default, the program allocates a fixed daily trading budget of `$1,000`. This value should be configurable.

### Position-sizing rules

For each symbol in `tradeCandidates`:

1. Get the current market price.
2. Determine the planned entry price.
3. Determine the stop price.
4. Calculate the per-share risk:

```text
perShareRisk = abs(entryPrice - stopPrice)
```

1. Determine the maximum shares allowed by risk.
2. Allocate shares across all candidates as evenly as possible without exceeding the total daily risk limit.

A TypeScript implementation should represent pricing and sizing inputs with dedicated interfaces so the sizing logic receives validated numeric fields.

### Daily risk rule

The combined maximum loss of all open trades should never exceed the configured daily risk budget.

```text
totalRisk = sum(shares × perShareRisk for all active trades)
```

The execution engine should reject any new trade that would push total risk above the configured daily limit.

### Reward-to-risk rule

The default reward-to-risk ratio is `1:3`.

For example, if:

- entry price = `$100`
- stop price = `$95`

then:

- risk per share = `$5`
- target price for a long trade = `$115`
- target price for a short trade = `$85`

This target should only be used if the trade also fits within the position-sizing and daily-risk rules.

## Suggested TypeScript data model

Instead of managing “distinct arrays” manually, the program will be easier to maintain if it uses typed interfaces, union types, and `Map` collections.

Example:

```ts
type TradeDirection = "long" | "short";

type SetupStatus =
  | "collectingOpeningRange"
  | "waitingForRetest"
  | "confirmingMove"
  | "candidate"
  | "rejected"
  | "executed";

interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OpeningRange {
  high: number | null;
  low: number | null;
  width: number | null;
}

interface TradePlan {
  direction: TradeDirection | null;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  shares: number;
  rewardRiskRatio: number;
}

interface SymbolState {
  symbol: string;
  openingCandles: Candle[];
  openingRange: OpeningRange;
  retestDetected: boolean;
  impulseCandle: Candle | null;
  status: SetupStatus;
  tradeCandidate: boolean;
  tradePlan: TradePlan;
}

const symbols = new Map<string, SymbolState>();

symbols.set("AAPL", {
  symbol: "AAPL",
  openingCandles: [],
  openingRange: {
    high: null,
    low: null,
    width: null
  },
  retestDetected: false,
  impulseCandle: null,
  status: "collectingOpeningRange",
  tradeCandidate: false,
  tradePlan: {
    direction: null,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
    shares: 0,
    rewardRiskRatio: 3
  }
});
```

This structure makes it easier to process each symbol independently, enforce valid state transitions, and pass normalized trade objects to the execution layer.

## Suggested module structure

A TypeScript implementation will likely be easier to maintain if the codebase is split into modules such as:

- `types/` for domain interfaces and union types
- `config/` for runtime settings
- `marketData/` for symbol selection and candle ingestion
- `strategy/` for opening range, retest, and confirmation logic
- `risk/` for position sizing and daily risk enforcement
- `execution/` for order submission and broker integration

This separation will make it easier to test each part of the workflow independently.

## Configuration

The following values should be configurable:

- Number of symbols to scan
- Source for most-active symbols
- Candle timeframe
- Opening range duration
- Retest confirmation duration
- Daily tradable amount
- Maximum daily risk
- Reward-to-risk ratio
- Entry rules
- Stop-loss rules
- Profit-target rules

In TypeScript, these settings should be represented by a dedicated configuration interface and validated when the program starts.

## Open questions

These areas still need to be defined more precisely:

- What qualifies as a valid retest: wick touch, candle close, or bid/ask touch?
- What qualifies as “moving away” from the range after retest?
- Will execution use market, limit, or stop orders?
- How will slippage, commissions, and rejected orders be handled?
- Can multiple candidates be entered at the same time?
- Should the program avoid symbols with spreads that are too wide?
- Should volume, VWAP, or relative volume be used as additional filters?

A TypeScript implementation should eventually encode as many of these rules as possible in explicit types, configuration objects, and validation logic rather than leaving them as informal assumptions.

## Future sections

UNDER CONSTRUCTION

### Changing the fixed daily amount of money available for trading

UNDER CONSTRUCTION

This section should explain:

- where the configuration value is stored,
- how it is changed,
- whether it is read from environment variables, a config file, or a UI,
- and whether the value represents buying power, max loss, or total capital allocated.

### Example daily scenario

UNDER CONSTRUCTION

This section should walk through one full example, including:

- selected symbol,
- opening range high and low,
- retest,
- confirmation candle,
- entry price,
- stop price,
- position size,
- target price,
- and estimated maximum loss.

## Reference

[Opening Range Breakout](https://www.warriortrading.com/opening-range-breakout/)
