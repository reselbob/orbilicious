import { expect } from 'chai';
import { Orberator } from '../src/Orberator';
import logger from '../src/Logger';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

describe('Orberator Logger Integration', function () {
    // Note: We use regular functions (not arrows) for describe/it 
    // if we need to access 'this.timeout'
    const logFilePath = path.join(process.cwd(), 'Orberator.log');

    before(function () {
        // Increase timeout for the entire suite or specific hooks
        this.timeout(15000);

        if (fs.existsSync(logFilePath)) {
            fs.truncateSync(logFilePath, 0);
        }
    });

    it('should log a successful connection message on create()', async function () {
        this.timeout(15000); // Specific timeout for API handshake

        logger.info('--- Starting Test: create() ---');

        const instance = await Orberator.create();

        // Chai assertions
        expect(instance).to.not.be.undefined;

        const logContent = fs.readFileSync(logFilePath, 'utf8');
        expect(logContent).to.contain('Successfully authenticated');
    });

    it('should log a warning when no active stocks are found', async function () {
        this.timeout(15000);

        const instance = await Orberator.create();
        await instance.getActives();

        const logContent = fs.readFileSync(logFilePath, 'utf8');

        // Chai regex testing
        const found = /Watchlist identified|Alpaca returned no active movers/.test(logContent);
        expect(found).to.be.true;
    });
});