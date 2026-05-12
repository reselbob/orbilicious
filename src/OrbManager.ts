import { Orberator } from './Orberator';
import logger from './Logger';

export class OrbManager {
    private orberator: Orberator | null = null;
    private isRunning: boolean = false;

    constructor() { }

    /**
     * Initializes the Orberator. 
     * Returning a Promise allows for .to.be.fulfilled in Mocha/Chai.
     */
    public async initialize(): Promise<void> {
        try {
            logger.info("OrbManager: Initializing system dependencies...");

            // The static factory method 'create' already performs 
            // the Alpaca ping and credential check.
            this.orberator = await Orberator.create();

            logger.info("OrbManager: Initialization successful.");
            // Promise resolves automatically on completion
        } catch (error: any) {
            logger.error(`OrbManager: Initialization failed -> ${error.message}`);
            // Re-throwing ensures the Promise is rejected, 
            // allowing tests to catch failures.
            throw error;
        }
    }

    /**
     * Orchestrates the startup sequence
     */
    public async startStrategy(): Promise<void> {
        if (!this.orberator) {
            throw new Error("Cannot start strategy: OrbManager is not initialized.");
        }

        if (this.isRunning) return;

        this.isRunning = true;
        const symbols = await this.orberator.getActives();

        if (symbols.length > 0) {
            await this.orberator.initMonitoring(symbols);
        } else {
            this.isRunning = false;
            logger.warn("No symbols found; monitoring not started.");
        }
    }

    public stop(): void {
        this.isRunning = false;
        logger.info("OrbManager: Strategy stopped.");
    }
}