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

/**
 * Redact an email address before it is written to a log sink. Returns a string
 * shaped like the original (`x***@y*.z*`) so an operator can still distinguish
 * accounts in a multi-account session, but the local-part and domain
 * characters are replaced with asterisks. Defeats CodeQL
 * `js/clear-text-logging` flagging email addresses as sensitive PII.
 */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const domain = email.slice(at + 1);
  const redactedDomain = domain
    .split('.')
    .map((part) => (part.length > 0 ? part[0] + '*' : '*'))
    .join('.');
  return `${email[0]}***@${redactedDomain}`;
}

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
