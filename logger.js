const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    // 1. Write all logs with level 'info' and below to trading.log
    new winston.transports.File({ filename: 'trading.log' }),
    
    // 2. Also print to the console so you can see it in VS Code
    new winston.transports.Console()
  ],
});

module.exports = logger;
