import { logger } from './logger';
import { startApp } from './app';

const args = process.argv.slice(2);
const continuousMode = args.includes('--continuous') || args.includes('-c');

startApp({ continuous: continuousMode }).catch((error) => {
    logger.error('Fatal application error', {
        error,
        continuousMode,
    });
    process.exit(1);
});