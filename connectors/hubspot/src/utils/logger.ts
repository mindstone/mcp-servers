const LOG_MODE = process.env.LOG_MODE || 'normal';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatMessage(level: LogLevel, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
}

const logger = {
  debug(message: string, data?: unknown): void {
    if (LOG_MODE !== 'strict') {
      console.error(formatMessage('debug', message, data));
    }
  },

  info(message: string, data?: unknown): void {
    console.error(formatMessage('info', message, data));
  },

  warn(message: string, data?: unknown): void {
    console.error(formatMessage('warn', message, data));
  },

  error(message: string, data?: unknown): void {
    console.error(formatMessage('error', message, data));
  }
};

export default logger;
