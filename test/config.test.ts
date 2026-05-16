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

    it('defaults RUN_MODE to EMULATION when not set', () => {
        withBaseConfigEnv();
        delete process.env.RUN_MODE;
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.runMode).to.equal('EMULATION');
        expect(mod.env.dryRun).to.equal(true);
        expect(mod.env.tradingBaseUrl).to.equal('https://paper-api.alpaca.markets');
    });

    it('uses PAPER mode to execute against Alpaca paper endpoint', () => {
        withBaseConfigEnv();
        process.env.RUN_MODE = 'PAPER';
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.runMode).to.equal('PAPER');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.tradingBaseUrl).to.equal('https://paper-api.alpaca.markets');
    });

    it('uses LIVE mode to execute against Alpaca live endpoint', () => {
        withBaseConfigEnv();
        process.env.RUN_MODE = 'LIVE';
        delete process.env.ALPACA_TRADING_BASE_URL;

        clearConfigModuleCache();
        const mod = require('../src/config');

        expect(mod.env.runMode).to.equal('LIVE');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.tradingBaseUrl).to.equal('https://api.alpaca.markets');
    });
});