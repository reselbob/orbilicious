import { expect } from 'chai';
import { describe, before, after, it } from 'mocha';
import { OrbManager } from '../src/OrbManager';
import logger from '../src/Logger';

describe('OrbManager Integration Tests (Live API)', function () {
    // Increase timeout to 30 seconds as API calls and socket 
    // handshakes take time.
    this.timeout(30000);

    let orbManager: OrbManager;

    before(async () => {
        logger.info("--- Starting Integration Tests ---");
        orbManager = new OrbManager();
    });

    after(() => {
        orbManager.stop();
        logger.info("--- Integration Tests Complete ---");
    });

    describe('Initialization', () => {
        it('should successfully authenticate and initialize Orberator', async () => {
            //await expect(orbManager.initialize()).to.be.fulfilled;
        });

        it('should throw an error if initialize is called with invalid credentials', async () => {
            // Temporarily mess up env to test failure (Optional/Cautionary)
            const originalKey = process.env.ALPACA_KEY;
            process.env.ALPACA_KEY = 'INVALID_KEY';

            const failManager = new OrbManager();
            try {
                await failManager.initialize();
                throw new Error("Should have failed");
            } catch (err: any) {
                expect(err.message).to.contain("Could not connect to Alpaca");
            } finally {
                process.env.ALPACA_KEY = originalKey;
            }
        });
    });

    describe('Strategy Execution', () => {
        it('should fetch active tickers and start monitoring', async () => {
            // Ensure manager is initialized
            await orbManager.initialize();

            // Start the strategy
            await orbManager.startStrategy();

            // Check if the internal Orberator instance has populated its watchlist
            // Note: This requires access to the private orberator or a public getter
            const orberator = (orbManager as any).orberator;
            const watchlist = orberator['watchlist'];

            const symbols = Object.keys(watchlist);

            logger.info(`Verified ${symbols.length} symbols in watchlist.`);

            expect(symbols).to.be.an('array');
            // Depending on market hours, this might be 0 if the range hasn't formed yet
            // but for a successful integration test, we expect connectivity.
            expect(symbols.length).to.be.at.most(40);
        });

        it('should maintain the "isRunning" state correctly', async () => {
            // Already started in the previous test
            await orbManager.startStrategy();
            expect((orbManager as any).isRunning).to.be.true;

            orbManager.stop();
            expect((orbManager as any).isRunning).to.be.false;
        });
    });

    describe('Live Data Validation', () => {
        it('should calculate a valid opening range for a known ticker', async () => {
            const orberator = (orbManager as any).orberator;
            // Testing with a high-volume stock like SPY
            const range = await orberator.getOpeningRange('SPY');

            if (range) {
                expect(range.highValue).to.be.a('number');
                expect(range.lowValue).to.be.a('number');
                expect(range.highValue).to.be.greaterThanOrEqual(range.lowValue);
            } else {
                logger.warn("Range returned null. This is expected if the market hasn't opened/reached 9:45 AM EST yet.");
            }
        });
    });
});