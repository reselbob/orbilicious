# Orbilicious

WORK IN PROGRESS

A Node JS project for running the [Opening Range Breakout][def1] pattern against the 40 most active stocks of the current day in the NYSE and NASDAQ exchanges .

## Workflow

The logic that drives Orbilicious

1. Get the 40 symbols for the most active stocks of the day at the opening of the NYSE and NASDAQ.
2. Collect the candlesticks for each of the 40 symbols during the first fifteen minutes of activity, collecting candlesticks at the 5 minute timeframe.
3. Store each candlestick collected in distinct arrays according to the symbol.
4. After the symbols are collected during the opening 15 minutes, run the members of each array through a distinct process. Each process will do the following:
    1. Within the dedicated array of candlesticks for a given symbol, determine the high and low price range of the symbol with the 15 minute opening collection of candlesticks.
    2. After the high and low price range has been determined, monitor the price action of each symbol waiting for the symbol to return to either the high or low price within the range. Touching high or low end of the range indicates that the symbols is doing a retest.
    3. Once a retest event occurs, monitor the symbol's price range for another 5 minutes to determine if the symbol's price is moving away from the range, either high or low.
    4. **If the symbol is indeed moving away from the range, we have a candidate for a trade.** The symbol for a candidate for a trade is added to an `Trade Candidates` array.
5. Send the trade candidate to a process that will execute the actual trade.
    1. If the trade is against a symbol going up in price, do a long trade setting the stop limit to price at the top of the wick of the candlestick just previous to the candlestick that broke the upper price at the 15 minute opening range. The candlestick that broke through the range is called an *impulse candlestick*.
    2. If the trade is against a symbol going down in price, do a long trade setting the stop limit to price at the bottom of the wick of the candlestick just previous to the candlestick that broke the lower price at the 15 minute opening range.
6. Determining how to set the value of stop and limit prices of the trade is described in the section that follows.

## Determining the pricing setup of the `Trade Candidates`

The overall goal of this program is to execute as many ORB trades as possible from among the 40 most active stocks of the trading day. The amount money to trade is determined from a fixed amount allocated to the trading day. By default the amount of money will be traded on a given day is $1000. (The daily tradable amount is a configurable value that can be changed. Changing the fixed daily amount of money for trade is discussed later in this document.)

The algorithm for determining the stop and limit of a particular trade is determined as follows:

1. Get the current price of each symbol in the `Trade Candidates` array.
2. Determine the number of shares that can be bought for each symbol in a manner that allow money to be allocated to each symbol as evenly as possible with the following consideration:
    1. The combined stop loss amounts of the symbols in the `Trade Candidates` array, as determined by number of shares against stop limit price, should never exceed the fixed daily tradable amount.
    2. The stop loss to profit limit is by default, 1 to 3. In other words, if a stock is selling at $100, the stop price will be $80 and the profit limit price will be $160, **provided that risking $20 is permissable according the pricing algorithm that set the maximum risk amount for each particular symbol against the fixed daily amount for trading.**

## Changing the fixed daily amount of money for available trade

TO BE PROVIDED

## Example: A daily trade scenario

TO BE PROVIDED

[def1]: https://www.warriortrading.com/opening-range-breakout/
