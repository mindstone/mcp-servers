import { mswServer } from './setup.js';

/** Runs `run` and returns every request it started, as `METHOD origin+pathname`. */
export async function recordRequests<T>(run: () => Promise<T>): Promise<string[]> {
  const seen: string[] = [];
  const record = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.origin}${url.pathname}`);
  };
  mswServer.events.on('request:start', record);
  try {
    await run();
  } finally {
    mswServer.events.removeListener('request:start', record);
  }
  return seen;
}
