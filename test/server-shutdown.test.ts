import { expect } from 'chai';
import { describe, it } from 'mocha';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('server shutdown', () => {
  it('kills a spawned child process when sent SIGTERM', (done) => {
    // Spawn a long-lived child as the "worker"
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
    });

    let childExited = false;
    child.on('exit', () => {
      childExited = true;
    });

    // Give the child a moment to start, then kill it via SIGTERM
    setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          expect(childExited).to.equal(true);
          done();
        } catch (err) {
          done(err);
        }
      }, 200);
    }, 100);
  });
});
