import { expect } from 'chai';
import { describe, it, before } from 'mocha';
import { Orberator } from '../src/Orberator';
import logger from '../src/Logger';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

describe('Orberator Logger Integration', function () {
    const logFilePath = path.join(process.cwd(), 'Orberator.log');

    // Use function(this: Mocha.Context) to fix 'this' errors and allow timeouts
    before(function (this: Mocha.Context) {
        this.timeout(15000);

        if (fs.existsSync(logFilePath)) {
            fs.truncateSync(logFilePath, 0);
        }
    });

    it('should log a successful connection message on create()', async function (this: Mocha.Context) {
        this.timeout(15000);

        logger.info('--- Starting Test: create() ---');

        const instance = await Orberator.create();

        expect(instance).to.not.be.undefined;

        const logContent = fs.readFileSync(logFilePath, 'utf8');
        expect(logContent).to.contain('Successfully authenticated');
    });

    it('should log a warning when no active stocks are found', async function (this: Mocha.Context) {
        this.timeout(15000);

        const instance = await Orberator.create();


        const logContent = fs.readFileSync(logFilePath, 'utf8');
        const found = /Watchlist identified|Alpaca returned no active movers/.test(logContent);
        expect(found).to.be.true;
    });
});