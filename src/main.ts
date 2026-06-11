// CLI entry point: runs historical backtests, single-day emulations,
// and generates reports from the command line.
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { logger } from './logger';
import { startApp } from './app';
import { APP_VERSION } from './config';

const args = process.argv.slice(2);
const continuousMode = args.includes('--continuous') || args.includes('-c');

async function stampReadmeVersion() {
    try {
        const readmePath = resolve(__dirname, '..', 'README.md');
        const content = await readFile(readmePath, 'utf-8');
        const updated = content.replace(
            /^# ORBilicious$/m,
            `# ORBilicious ${APP_VERSION}`
        );
        if (updated !== content) {
            await writeFile(readmePath, updated, 'utf-8');
        }
    } catch {
        // Non-fatal — the app should still start if README can't be updated.
    }
}

process.on('uncaughtException', (error) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPIPE') {
        try { process.stderr.write('EPIPE: stdout pipe broken (parent server exited). Shutting down.\n'); } catch { /* stderr may also be broken */ }
        process.exit(1);
    }
});

stampReadmeVersion().then(() =>
    startApp({ continuous: continuousMode }).catch((error) => {
        logger.error('Fatal application error', {
            error,
            continuousMode,
        });
        process.exit(1);
    })
);