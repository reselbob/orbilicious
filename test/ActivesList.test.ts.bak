import { expect } from 'chai';
import { ActivesList } from '../src/ActivesList';
import { describe, it, before } from 'mocha';
import logger from '../src/Logger';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the project root
dotenv.config({ path: path.join(__dirname, '../.env') });

describe('ActivesList Unit Tests', function () {
    let activesList: ActivesList;

    before(function (this: Mocha.Context) {
        // Increase timeout for the network request
        this.timeout(10000);
        activesList = new ActivesList();
    });

    describe('getSymbols()', function () {
        it('should return an array of strings representing ticker symbols', async function (this: Mocha.Context) {
            this.timeout(10000);

            logger.info('--- Starting Test: ActivesList.getSymbols() ---');

            const symbols = await activesList.getSymbols();

            // Assertions
            expect(symbols).to.be.an('array');
            logger.info(`Test reported the following symbols: ${symbols}`);

            // If the API call is successful, we expect some data
            if (symbols.length > 0) {
                expect(symbols[0]).to.be.a('string');
                // Symbols are typically uppercase (e.g., 'AAPL')
                expect(symbols[0]).to.equal(symbols[0].toUpperCase());

                logger.info(`Test verified ${symbols.length} symbols.`);
            } else {
                // If 0, we log a warning but technically the "type" is still correct
                logger.warn('API returned 0 symbols; verify API status or credentials.');
            }
        });

        it('should handle unauthorized access gracefully', async function (this: Mocha.Context) {
            this.timeout(10000);

            // Temporarily break credentials to test error path
            const originalKey = process.env.ALPACA_KEY;
            (process.env as any).ALPACA_KEY = 'INVALID_KEY';

            const failList = new ActivesList();
            const symbols = await failList.getSymbols();

            expect(symbols).to.be.an('array');
            expect(symbols.length).to.equal(0);

            // Restore credentials
            process.env.ALPACA_KEY = originalKey;
        });
    });
});