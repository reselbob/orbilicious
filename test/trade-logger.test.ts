import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve(process.cwd(), 'logs', 'trades');

function cleanLogFiles(prefix: string) {
  if (!fs.existsSync(LOG_DIR)) return;
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (f.startsWith(prefix)) {
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  }
}

describe('trade-logger', () => {
  beforeEach(() => {
    cleanLogFiles('trades-');
  });

  afterEach(() => {
    cleanLogFiles('trades-');
  });

  it('writes BREAKOUT_HIGH and BREAKOUT_LOW to a file keyed by the passed timestamp, not the system clock', async () => {
    const { logBreakoutHigh, logBreakoutLow } = await import('../src/trade-logger');

    const sessionTimestamp = '2026-05-14T13:47:00Z';
    logBreakoutHigh('SPY', 101.5, sessionTimestamp);
    logBreakoutLow('SPY', 99.2, sessionTimestamp);

    const expectedFile = path.join(LOG_DIR, 'trades-2026-05-14.log');
    expect(fs.existsSync(expectedFile)).to.equal(true);

    const contents = fs.readFileSync(expectedFile, 'utf8').trim().split('\n');
    expect(contents).to.have.length(2);

    const high = JSON.parse(contents[0]);
    expect(high.type).to.equal('BREAKOUT_HIGH');
    expect(high.symbol).to.equal('SPY');
    expect(high.highPrice).to.equal(101.5);
    expect(high.timestamp).to.equal(sessionTimestamp);

    const low = JSON.parse(contents[1]);
    expect(low.type).to.equal('BREAKOUT_LOW');
    expect(low.symbol).to.equal('SPY');
    expect(low.lowPrice).to.equal(99.2);
    expect(low.timestamp).to.equal(sessionTimestamp);
  });

  it('writes TRADE_OPEN and TRADE_CLOSE to a file keyed by the entry/exit timestamp, not the system clock', async () => {
    const { logTradeOpen, logTradeClose } = await import('../src/trade-logger');

    const entryTime = '2026-05-14T13:47:00Z';
    const exitTime = '2026-05-14T14:15:00Z';

    logTradeOpen('AAPL', 150.25, entryTime);
    logTradeClose('AAPL', 152.1, exitTime);

    const expectedFile = path.join(LOG_DIR, 'trades-2026-05-14.log');
    expect(fs.existsSync(expectedFile)).to.equal(true);

    const contents = fs.readFileSync(expectedFile, 'utf8').trim().split('\n');
    expect(contents).to.have.length(2);

    const open = JSON.parse(contents[0]);
    expect(open.type).to.equal('TRADE_OPEN');
    expect(open.symbol).to.equal('AAPL');
    expect(open.entryPrice).to.equal(150.25);
    expect(open.entryTime).to.equal(entryTime);

    const close = JSON.parse(contents[1]);
    expect(close.type).to.equal('TRADE_CLOSE');
    expect(close.symbol).to.equal('AAPL');
    expect(close.exitPrice).to.equal(152.1);
    expect(close.exitTime).to.equal(exitTime);
  });

  it('writes trades with different session dates to separate files', async () => {
    const { logTradeOpen } = await import('../src/trade-logger');

    logTradeOpen('AAPL', 150, '2026-05-14T13:47:00Z');
    logTradeOpen('GOOG', 2800, '2026-05-28T13:47:00Z');

    const file14 = path.join(LOG_DIR, 'trades-2026-05-14.log');
    const file28 = path.join(LOG_DIR, 'trades-2026-05-28.log');

    expect(fs.existsSync(file14)).to.equal(true);
    expect(fs.existsSync(file28)).to.equal(true);

    const contents14 = fs.readFileSync(file14, 'utf8').trim().split('\n');
    const contents28 = fs.readFileSync(file28, 'utf8').trim().split('\n');

    expect(contents14).to.have.length(1);
    expect(contents28).to.have.length(1);

    expect(JSON.parse(contents14[0]).symbol).to.equal('AAPL');
    expect(JSON.parse(contents28[0]).symbol).to.equal('GOOG');
  });
});
