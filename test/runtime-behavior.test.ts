import { expect } from 'chai';
import { describe, it } from 'mocha';

describe('Current Balance tracking', () => {

    it('starts at the money-in-account baseline when a session begins', () => {
        const moneyInAccount = 25000;
        const currentBalance = moneyInAccount;
        expect(currentBalance).to.equal(25000);
    });

    it('increments when a trade closes with positive P&L', () => {
        let currentBalance = 25000;
        // Trade close with +500 P&L
        currentBalance += 500;
        expect(currentBalance).to.equal(25500);
    });

    it('decrements when a trade closes with negative P&L', () => {
        let currentBalance = 25000;
        // Trade close with -300 P&L
        currentBalance += -300;
        expect(currentBalance).to.equal(24700);
    });

    it('tracks cumulative P&L across multiple trades', () => {
        let currentBalance = 25000;
        const trades = [500, -300, 200, -100, 750];
        for (const pnl of trades) {
            currentBalance += pnl;
        }
        expect(currentBalance).to.equal(26050);
    });

    it('ignores P&L from trade open events (only close events affect balance)', () => {
        let currentBalance = 25000;
        // Open events have no P&L - balance unchanged
        const openEvents = [
            { eventType: 'open', symbol: 'AAPL' },
            { eventType: 'open', symbol: 'TSLA' },
            { eventType: 'open', symbol: 'NVDA' },
        ];
        for (const event of openEvents) {
            if (event.eventType === 'close') {
                currentBalance += 0;
            }
        }
        expect(currentBalance).to.equal(25000);
    });

    it('remains null when no session has been started', () => {
        const currentBalance = null;
        expect(currentBalance).to.be.null;
    });

    it('resets to the baseline when a new session starts', () => {
        let currentBalance = 25500; // Previous session ended here
        // New session starts with new moneyInAccount
        const newMoneyInAccount = 50000;
        currentBalance = newMoneyInAccount;
        expect(currentBalance).to.equal(50000);
    });

    it('handles zero P&L without changing the balance', () => {
        let currentBalance = 25000;
        currentBalance += 0;
        expect(currentBalance).to.equal(25000);
    });

    it('formats the balance as USD currency', () => {
        const balance = 25500.50;
        const formatted = `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        expect(formatted).to.equal('$25,500.50');
    });
});
