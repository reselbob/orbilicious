import winston from 'winston';
import path from 'path';

/**
 * Define the root path for the log file. 
 * process.cwd() points to the root directory where the command is executed.
 */
const logFilePath = path.join(process.cwd(), 'Orberator.log');

const customFormat = winston.format.printf(({ timestamp, level, message }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    customFormat
  ),
  transports: [
    // 1. Write to Orberator.log at the project root
    new winston.transports.File({ filename: logFilePath }),

    // 2. Output to console
    new winston.transports.Console()
  ],
});

export default logger;