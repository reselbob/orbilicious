import { expect } from 'chai';
import { describe, it } from 'mocha';

describe('config integration', () => {
    it('loads config from environment variables', () => {
        process.env.APCA_API_KEY_ID = 'key';
        process.env.APCA_API_SECRET_KEY = 'secret';
        process.env.MAX_TOTAL_RISK = '1500';
        process.env.POLL_INTERVAL_SECONDS = '30';
        process.env.QUANTITY_TO_RETRIEVE = '25';
        process.env.ALLOW_LONG = 'true';
        process.env.ALLOW_SHORT = 'false';

        delete require.cache[require.resolve('../src/config')];
        const mod = require('../src/config');

        expect(mod.env.maxTotalRisk).to.equal(1500);
        expect(mod.env.pollIntervalSeconds).to.equal(30);
        expect(mod.env.quantityToRetrieve).to.equal(25);
        expect(mod.strategyConfig.allowLong).to.equal(true);
        expect(mod.strategyConfig.allowShort).to.equal(false);
    });
});