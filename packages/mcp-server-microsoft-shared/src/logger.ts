export interface MicrosoftLogger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// Sanitised LOG_MODE: only a boolean equality check is observable from the env
// var, so CodeQL does not flow the (possibly sensitive) raw value into log
// sinks below. Anything other than "strict" defaults to verbose logging.
const STRICT_LOGGING: boolean = process.env.LOG_MODE === 'strict';

export function createLogger(service: string): MicrosoftLogger {
  const prefix = `[${service}]`;

  const shouldLog = (level: 'debug' | 'info' | 'warn' | 'error'): boolean => {
    if (STRICT_LOGGING) {
      return level === 'error' || level === 'warn';
    }
    return true;
  };

  const formatData = (data?: Record<string, unknown>): string => {
    if (!data) return '';
    return ' ' + JSON.stringify(data);
  };

  return {
    info(message: string, data?: Record<string, unknown>): void {
      if (shouldLog('info')) {
        console.error(`${prefix} INFO: ${message}${formatData(data)}`);
      }
    },
    error(message: string, data?: Record<string, unknown>): void {
      if (shouldLog('error')) {
        console.error(`${prefix} ERROR: ${message}${formatData(data)}`);
      }
    },
    warn(message: string, data?: Record<string, unknown>): void {
      if (shouldLog('warn')) {
        console.error(`${prefix} WARN: ${message}${formatData(data)}`);
      }
    },
    debug(message: string, data?: Record<string, unknown>): void {
      if (shouldLog('debug')) {
        console.error(`${prefix} DEBUG: ${message}${formatData(data)}`);
      }
    },
  };
}
