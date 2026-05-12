import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const licenseContent = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

describe('LICENSE metadata', () => {
  it('attributes the package to HubSpot and not Salesforce', () => {
    expect(countOccurrences(licenseContent, '**Software**: HubSpot MCP Server')).toBe(1);
    expect(countOccurrences(licenseContent, '| Software | HubSpot MCP Server |')).toBe(1);
    expect(licenseContent.match(/\bSalesforce\b/g) ?? []).toHaveLength(0);
  });
});
