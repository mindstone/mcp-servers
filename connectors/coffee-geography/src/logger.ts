const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export const logger = {
  debug: (msg: string, ..._args: unknown[]) => console.log(`${GRAY}${new Date().toISOString()}${RESET} [DEBUG] ${msg}`),
  info: (msg: string, ..._args: unknown[]) => console.log(`${GRAY}${new Date().toISOString()}${RESET} [INFO ] ${msg}`),
  warn: (msg: string, ..._args: unknown[]) => console.log(`${GRAY}${new Date().toISOString()}${RESET} [WARN ] ${msg}`),
  error: (msg: string, ..._args: unknown[]) => console.log(`${RED}${new Date().toISOString()}${RESET} [ERROR] ${msg}`),
};
