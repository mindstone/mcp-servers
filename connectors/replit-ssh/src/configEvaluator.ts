import SSHConfig from 'ssh-config';

type ParsedConfig = ReturnType<typeof SSHConfig.parse>;

interface ParsedEntry {
  param?: unknown;
  value?: unknown;
  config?: unknown;
}

interface ParsedToken {
  val?: unknown;
}

function asEntryArray(value: unknown): ParsedEntry[] {
  return Array.isArray(value) ? (value as ParsedEntry[]) : [];
}

function normalizeParam(param: unknown): string {
  return typeof param === 'string' ? param.toLowerCase() : '';
}

function splitHostPatterns(rawValue: unknown): string[] {
  // ssh-config emits a plain string for comma-only pattern lists and an
  // array of {val} tokens when patterns are space-separated.
  const rawPatterns = typeof rawValue === 'string'
    ? [rawValue]
    : Array.isArray(rawValue)
      ? rawValue.map((token) => {
          if (typeof token === 'string') return token;
          if (token && typeof token === 'object') {
            const parsedToken = token as ParsedToken;
            if (typeof parsedToken.val === 'string') return parsedToken.val;
          }
          return '';
        })
      : [];

  return rawPatterns
    .flatMap((segment) => segment.split(/\s+/))
    .flatMap((segment) => segment.split(','))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function escapeRegexChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function globToRegex(globPattern: string): RegExp {
  let regex = '^';
  for (const char of globPattern) {
    if (char === '*') {
      regex += '.*';
      continue;
    }
    if (char === '?') {
      regex += '.';
      continue;
    }
    regex += escapeRegexChar(char);
  }
  regex += '$';
  return new RegExp(regex, 'i');
}

function matchesHostPattern(pattern: string, host: string): boolean {
  return globToRegex(pattern).test(host);
}

function extractIdentityValues(rawValue: unknown): string[] {
  if (typeof rawValue === 'string') {
    return rawValue
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (Array.isArray(rawValue)) {
    return rawValue
      .map((token) => {
        if (typeof token === 'string') {
          return token;
        }
        if (token && typeof token === 'object') {
          const parsedToken = token as ParsedToken;
          if (typeof parsedToken.val === 'string') {
            return parsedToken.val;
          }
        }
        return '';
      })
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
}

function findIdentityFilesInSection(rawConfig: unknown): string[] {
  const entries = asEntryArray(rawConfig);
  const identityFiles: string[] = [];

  for (const entry of entries) {
    if (normalizeParam(entry.param) !== 'identityfile') {
      continue;
    }
    identityFiles.push(...extractIdentityValues(entry.value));
  }

  return identityFiles;
}

export function findIdentityFilesForHost(
  config: ParsedConfig,
  host: string,
): string[] {
  const normalizedHost = host.trim();
  if (!normalizedHost) {
    return [];
  }

  const identityFiles: string[] = [];

  for (const entry of asEntryArray(config)) {
    const sectionType = normalizeParam(entry.param);
    if (!sectionType) {
      continue;
    }

    if (sectionType === 'match') {
      // Intentionally ignored: evaluating Match blocks can trigger command execution.
      continue;
    }

    if (sectionType !== 'host') {
      continue;
    }

    const patterns = splitHostPatterns(entry.value);
    if (patterns.length === 0) {
      continue;
    }

    // OpenSSH semantics: a Host block applies when the host matches at least
    // one positive pattern and no negated (!) pattern. A leading "!" must not
    // be treated as a literal character.
    const positive = patterns.filter((pattern) => !pattern.startsWith('!'));
    const negative = patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1))
      .filter(Boolean);

    const sectionMatches =
      positive.some((pattern) => matchesHostPattern(pattern, normalizedHost)) &&
      !negative.some((pattern) => matchesHostPattern(pattern, normalizedHost));
    if (!sectionMatches) {
      continue;
    }

    // OpenSSH semantics: IdentityFile values accumulate across EVERY
    // matching Host block in config order (all configured identities are
    // tried in sequence), so the first value comes from the earliest
    // matching block. Stopping at the first matching block would drop the
    // user's identity when that block sets no IdentityFile (e.g. only Port)
    // and a later block does.
    identityFiles.push(...findIdentityFilesInSection(entry.config));
  }

  return identityFiles;
}

export function findFirstIdentityFileForHost(
  config: ParsedConfig,
  host: string,
): string | undefined {
  return findIdentityFilesForHost(config, host)[0];
}
