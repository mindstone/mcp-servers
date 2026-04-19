import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface TempConfigOptions {
  /**
   * Accounts to write to accounts.json.
   * Each account should have at minimum a way to identify itself.
   * The exact shape is connector-specific — this helper writes whatever you pass.
   */
  accounts?: Array<Record<string, unknown>>;
  /** Default account identifier (written as `defaultSubdomain` or custom key). */
  defaultAccount?: string;
  /** Key name for the default account field in accounts.json. Defaults to `'defaultSubdomain'`. */
  defaultAccountKey?: string;
  /**
   * Credential token files to create in the `credentials/` subdirectory.
   * Each entry creates a file at `credentials/{filename}` with the given data.
   */
  credentials?: Array<{
    filename: string;
    data: Record<string, unknown>;
  }>;
  /** If true, create an empty config dir with no accounts.json. */
  empty?: boolean;
  /** Prefix for the temp directory name. Defaults to `'mcp-test-'`. */
  prefix?: string;
}

export interface TempConfigResult {
  /** Absolute path to the temp config directory. */
  configPath: string;
  /** Absolute path to a temp bridge state file (empty by default). */
  bridgeStatePath: string;
  /** Clean up the temp directory. Call in afterAll/afterEach. */
  cleanup: () => void;
}

/**
 * Creates a temporary config directory with `accounts.json` and optional
 * `credentials/*.token.json` files. Mimics the real `~/.mcp/{connector}/`
 * directory structure used by connectors.
 *
 * @param options - Configuration for the temp directory contents.
 * @returns Paths and a cleanup function.
 */
export function createTempConfig(options: TempConfigOptions = {}): TempConfigResult {
  const prefix = options.prefix ?? 'mcp-test-';
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bridgeStatePath = path.join(configPath, 'bridge-state.json');

  // Write empty bridge state (no bridge by default)
  fs.writeFileSync(bridgeStatePath, '', { mode: 0o600 });

  if (!options.empty) {
    const accounts = options.accounts ?? [];
    const defaultAccountKey = options.defaultAccountKey ?? 'defaultSubdomain';
    const accountsData: Record<string, unknown> = { accounts };
    if (options.defaultAccount) {
      accountsData[defaultAccountKey] = options.defaultAccount;
    }
    fs.writeFileSync(
      path.join(configPath, 'accounts.json'),
      JSON.stringify(accountsData, null, 2),
      { mode: 0o600 },
    );
  }

  if (options.credentials?.length) {
    const credDir = path.join(configPath, 'credentials');
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });

    for (const cred of options.credentials) {
      fs.writeFileSync(
        path.join(credDir, cred.filename),
        JSON.stringify(cred.data, null, 2),
        { mode: 0o600 },
      );
    }
  }

  const cleanup = () => {
    try {
      fs.rmSync(configPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  return { configPath, bridgeStatePath, cleanup };
}
