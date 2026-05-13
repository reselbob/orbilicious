import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'node:path';
import fs from 'node:fs';

const logDir = path.resolve(process.cwd(), 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const env = process.env.NODE_ENV || 'development';
const isDevelopment = env === 'development';
const level = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaString = Object.keys(meta).length
      ? ` ${JSON.stringify(meta, null, 2)}`
      : '';
    const errString = stack ? `\n${stack}` : '';
    return `${timestamp} [${level}] ${message}${metaString}${errString}`;
  })
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const fileTransport = new DailyRotateFile({
  dirname: logDir,
  filename: 'orbilicious-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: jsonFormat,
  level,
});

fileTransport.on('error', (err) => {
  console.error('DailyRotateFile transport error:', err);
});

export const logger = winston.createLogger({
  level,
  defaultMeta: {
    service: 'orb-alpaca-node',
    environment: env,
  },
  transports: [
    new winston.transports.Console({
      format: isDevelopment ? consoleFormat : jsonFormat,
    }),
    fileTransport,
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      dirname: logDir,
      filename: 'orbilicious-exceptions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: jsonFormat,
    }),
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      dirname: logDir,
      filename: 'orbilicious-rejections-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: jsonFormat,
    }),
  ],
  exitOnError: false,
});