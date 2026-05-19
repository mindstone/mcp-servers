export function readAliasedValue<T>(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): T | undefined {
  return (args[canonicalKey] ?? args[legacyKey]) as T | undefined;
}

export function readAliasedString(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): string | undefined {
  const value = readAliasedValue<unknown>(args, canonicalKey, legacyKey);
  return typeof value === 'string' ? value : undefined;
}

export function readAliasedNumber(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): number | undefined {
  const value = readAliasedValue<unknown>(args, canonicalKey, legacyKey);
  return typeof value === 'number' ? value : undefined;
}

export function readAliasedBoolean(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): boolean | undefined {
  const value = readAliasedValue<unknown>(args, canonicalKey, legacyKey);
  return typeof value === 'boolean' ? value : undefined;
}

export function readAliasedStringArray(
  args: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string
): string[] | undefined {
  const value = readAliasedValue<unknown>(args, canonicalKey, legacyKey);
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : undefined;
}
