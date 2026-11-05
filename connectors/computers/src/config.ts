/**
 * Which cloud accounts are connected, from the connector's settings (environment variables).
 * Each key is the person's own; it never leaves this process except to its provider.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Provider, ProviderId } from './provider.js';
import { E2bProvider } from './providers/e2b.js';
import { FlyProvider } from './providers/fly.js';
import { GcpProvider, parseServiceAccountKey } from './providers/gcp.js';

/** Unset, blank, or a host placeholder that was never filled in. */
const value = (env: NodeJS.ProcessEnv, name: string) => {
  const raw = env[name]?.trim();
  return raw && !/^\{\{[A-Z0-9_]+\}\}$/.test(raw) ? raw : undefined;
};

/** The Google key may be pasted as JSON or given as a path to the downloaded key file. */
function googleKey(raw: string): string {
  return raw.startsWith('{') || !isAbsolute(raw) ? raw : readFileSync(raw, 'utf8');
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const providers: Provider[] = [];
  const fly = value(env, 'FLY_API_TOKEN');
  if (fly) providers.push(new FlyProvider(fly.replace(/^FlyV1\s+/, 'FlyV1 '), value(env, 'FLY_ORG') ?? 'personal', value(env, 'FLY_APP'), value(env, 'FLY_REGION') ?? 'ams'));
  const e2b = value(env, 'E2B_API_KEY');
  if (e2b) providers.push(new E2bProvider(e2b));
  const google = value(env, 'GOOGLE_CLOUD_KEY');
  if (google)
    providers.push(
      new GcpProvider(
        parseServiceAccountKey(googleKey(google)),
        value(env, 'GOOGLE_CLOUD_PROJECT'),
        value(env, 'GOOGLE_CLOUD_ZONE') ?? 'europe-west1-b',
        value(env, 'GOOGLE_CLOUD_MACHINE_TYPE') ?? 'e2-medium',
      ),
    );
  const preferred = value(env, 'COMPUTERS_DEFAULT_PROVIDER') as ProviderId | undefined;
  return preferred ? [...providers.filter((p) => p.id === preferred), ...providers.filter((p) => p.id !== preferred)] : providers;
}
