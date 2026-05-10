require('dotenv').config();
const { expect } = require('chai');
const { getActiveTickers } = require('../index');
const logger = require('../logger'); // Import the winston logger

describe('getActiveTickers() Live Integration Test', function () {
    // Integration tests can take longer than unit tests
    // We increase the timeout to 10 seconds to allow for network latency
    this.timeout(10000);

    it('should fetch REAL data from Tradier API', async () => {
        logger.info('Starting Live Integration Test: Fetching real tickers from Tradier...');

        const result = await getActiveTickers();

        // Validate the structure of the live response
        expect(result).to.be.an('array', 'The result should be an array of tickers');
        expect(result.length).to.be.at.least(1, 'The API should return at least one ticker');
        expect(result.length).to.be.at.most(20, 'The result should be capped at 20 tickers');

        // Check if the tickers look like valid stock symbols (e.g., AAPL, NVDA)
        result.forEach(ticker => {
            expect(ticker).to.match(/^[A-Z]{1,5}$/, `Ticker ${ticker} is not a valid format`);
        });

        // Replaced console.log with logger.info
        logger.info(`Live Tickers Received: ${result.join(', ')}`);
    });

    it('should fail gracefully if TRADIER_TOKEN is missing', async () => {
        logger.warn('Testing graceful failure: Removing TRADIER_TOKEN...');

        // Temporarily remove token
        const originalToken = process.env.TRADIER_TOKEN;
        delete process.env.TRADIER_TOKEN;

        const result = await getActiveTickers();

        // It should return the fallback list we defined in the function
        expect(result).to.include('AAPL');
        logger.info('Fallback logic verified successfully.');

        // Restore token
        process.env.TRADIER_TOKEN = originalToken;
    });
});