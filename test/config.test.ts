import { expect } from 'chai';
import { describe, it } from 'mocha';

function clearConfigModuleCache() {
    delete require.cache[require.resolve('../src/config')];
}

function withBaseConfigEnv() {
    process.env.APCA_API_KEY_ID = 'key';
    process.env.APCA_API_SECRET_KEY = 'secret';
}

describe('config integration', () => {
    it('loads config from environment variables', () => {
        withBaseConfigEnv();
        process.env.MAX_TOTAL_RISK = '1500';
        process.env.POLL_INTERVAL_SECONDS = '30';
        process.env.QUANTITY_TO_RETRIEVE = '25';
        process.env.ALLOW_LONG = 'true';
        process.env.ALLOW_SHORT = 'false';

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.maxTotalRisk).to.equal(1500);
        expect(mod.env.pollIntervalSeconds).to.equal(30);
        expect(mod.env.quantityToRetrieve).to.equal(25);
        expect(mod.strategyConfig.allowLong).to.equal(true);
        expect(mod.strategyConfig.allowShort).to.equal(false);
    });

    it('defaults SESSION_MODE to EMULATION when not set', () => {
        withBaseConfigEnv();
        delete process.env.SESSION_MODE;
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.sessionMode).to.equal('EMULATION');
        expect(mod.env.dryRun).to.equal(true);
        expect(mod.env.tradingBaseUrl).to.equal('https://paper-api.alpaca.markets');
    });

    it('uses PAPER mode to execute against Alpaca paper endpoint', () => {
        withBaseConfigEnv();
        process.env.SESSION_MODE = 'PAPER';
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.sessionMode).to.equal('PAPER');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.tradingBaseUrl).to.equal('https://paper-api.alpaca.markets');
    });

    it('uses LIVE mode to execute against Alpaca live endpoint', () => {
        withBaseConfigEnv();
        process.env.SESSION_MODE = 'LIVE';
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.sessionMode).to.equal('LIVE');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.tradingBaseUrl).to.equal('https://api.alpaca.markets');
    });

    it('defaults CANDIDATE_TRADE_TYPE to LONG_AND_SHORT', () => {
        withBaseConfigEnv();
        delete process.env.CANDIDATE_TRADE_TYPE;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.candidateTradeType).to.equal('LONG_AND_SHORT');
    });

    it('loads CANDIDATE_TRADE_TYPE override from environment', () => {
        withBaseConfigEnv();
        process.env.CANDIDATE_TRADE_TYPE = 'SHORT';

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.candidateTradeType).to.equal('SHORT');
    });

    it('loads breakout confirmation and quality filter defaults', () => {
        withBaseConfigEnv();
        delete process.env.BREAKOUT_CONFIRMATION_CANDLE_MINUTES;
        delete process.env.BREAKOUT_QUALITY_FILTERS_ENABLED;
        delete process.env.BREAKOUT_MIN_VOLUME_EXPANSION;
        delete process.env.BREAKOUT_MIN_RELATIVE_STRENGTH_PCT;
        delete process.env.BREAKOUT_TREND_TIMEFRAME_MINUTES;
        delete process.env.BREAKOUT_TREND_LOOKBACK_BARS;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.breakoutConfirmationCandleMinutes).to.equal(5);
        expect(mod.env.breakoutQualityFiltersEnabled).to.equal(false);
        expect(mod.env.breakoutMinVolumeExpansion).to.equal(1.2);
        expect(mod.env.breakoutMinRelativeStrengthPct).to.equal(0.25);
        expect(mod.env.breakoutTrendTimeframeMinutes).to.equal(5);
        expect(mod.env.breakoutTrendLookbackBars).to.equal(3);
    });

    it('loads breakout confirmation and quality filter overrides', () => {
        withBaseConfigEnv();
        process.env.BREAKOUT_CONFIRMATION_CANDLE_MINUTES = '1';
        process.env.BREAKOUT_QUALITY_FILTERS_ENABLED = 'false';
        process.env.BREAKOUT_MIN_VOLUME_EXPANSION = '1.5';
        process.env.BREAKOUT_MIN_RELATIVE_STRENGTH_PCT = '0.4';
        process.env.BREAKOUT_TREND_TIMEFRAME_MINUTES = '15';
        process.env.BREAKOUT_TREND_LOOKBACK_BARS = '4';

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.breakoutConfirmationCandleMinutes).to.equal(1);
        expect(mod.env.breakoutQualityFiltersEnabled).to.equal(false);
        expect(mod.env.breakoutMinVolumeExpansion).to.equal(1.5);
        expect(mod.env.breakoutMinRelativeStrengthPct).to.equal(0.4);
        expect(mod.env.breakoutTrendTimeframeMinutes).to.equal(15);
        expect(mod.env.breakoutTrendLookbackBars).to.equal(4);
    });
});