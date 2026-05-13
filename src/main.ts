import { logger } from './logger';
import { startApp } from './app';

startApp().catch((error) => {
    logger.error('Fatal application error', { error });
    process.exit(1);
});