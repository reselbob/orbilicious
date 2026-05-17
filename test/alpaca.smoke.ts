import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';

// Optional smoke checks against live Alpaca endpoints.
// These are intentionally excluded from the default test suite.
describe('alpaca smoke tests', () => {
    it('can fetch account and most-active symbols when explicitly enabled', async function () {
        this.timeout(120_000);

        if (process.env.RUN_SMOKE_TESTS !== '1') {
            this.skip();
            return;
        }

        if (!process.env.APCA_API_KEY_ID || !process.env.APCA_API_SECRET_KEY) {
            this.skip();
            return;
        }

        const client = new AlpacaClient();
        const account = await client.getAccount();
        const symbols = await client.getMostActiveSymbols(5);

        expect(account.buyingPower).to.be.greaterThan(0);
        expect(Array.isArray(symbols)).to.equal(true);
        expect(symbols.length).to.be.greaterThan(0);
    });
});
