import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTools, AUTH_EXEMPT_TOOL_NAMES } from '../src/tools/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, '../src/tools');
const SERVER_PATH = path.resolve(TOOLS_DIR, 'server.ts');
const HUBSPOT_CLIENT_IMPORT = '../api/hubspot-client.js';

function parseHandlerImports(serverSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRegex = /import\s*{([\s\S]*?)}\s*from\s*['"](\.[^'"]+)['"];/g;

  for (const match of serverSource.matchAll(importRegex)) {
    const rawSymbols = match[1];
    const importPath = match[2];
    const resolvedImportPath = path.resolve(TOOLS_DIR, importPath.replace(/\.js$/, '.ts'));
    const symbols = rawSymbols
      .split(',')
      .map((symbol) => symbol.trim())
      .filter(Boolean)
      .map((symbol) => symbol.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);

    for (const symbol of symbols) {
      map.set(symbol, resolvedImportPath);
    }
  }

  return map;
}

function parseToolHandlers(serverSource: string): Map<string, string> {
  const map = new Map<string, string>();
  const caseRegex = /case\s+'([^']+)':\s*[\s\S]*?result\s*=\s*await\s+([A-Za-z0-9_]+)\(/g;

  for (const match of serverSource.matchAll(caseRegex)) {
    map.set(match[1], match[2]);
  }

  return map;
}

function resolveRelativeImportPath(fromFile: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }

  const candidate = path.resolve(path.dirname(fromFile), importPath.replace(/\.js$/, '.ts'));
  if (existsSync(candidate)) {
    return candidate;
  }

  const withTs = `${candidate}.ts`;
  if (existsSync(withTs)) {
    return withTs;
  }

  return null;
}

function moduleTransitivelyImportsHubspotClient(modulePath: string, visited = new Set<string>()): boolean {
  if (visited.has(modulePath) || !existsSync(modulePath)) {
    return false;
  }
  visited.add(modulePath);

  const source = readFileSync(modulePath, 'utf-8');
  if (
    source.includes(`'${HUBSPOT_CLIENT_IMPORT}'`) ||
    source.includes(`"${HUBSPOT_CLIENT_IMPORT}"`)
  ) {
    return true;
  }

  const importRegex = /from\s*['"](\.[^'"]+)['"]/g;
  for (const match of source.matchAll(importRegex)) {
    const childPath = resolveRelativeImportPath(modulePath, match[1]);
    if (childPath && moduleTransitivelyImportsHubspotClient(childPath, visited)) {
      return true;
    }
  }

  return false;
}

describe('requiresAuth derivation', () => {
  it('keeps auth-exempt tools aligned with handler import graph', () => {
    const serverSource = readFileSync(SERVER_PATH, 'utf-8');
    const handlerImportMap = parseHandlerImports(serverSource);
    const toolHandlerMap = parseToolHandlers(serverSource);

    const exemptTools = allTools.filter((tool) => tool.requiresAuth === false).map((tool) => tool.name).sort();
    expect(exemptTools).toEqual([...AUTH_EXEMPT_TOOL_NAMES].sort());

    for (const tool of allTools) {
      const handlerName = toolHandlerMap.get(tool.name);
      expect(handlerName, `Missing handler mapping for ${tool.name}`).toBeTruthy();

      const handlerModule = handlerName ? handlerImportMap.get(handlerName) : undefined;
      expect(handlerModule, `Missing module import mapping for ${tool.name}/${handlerName}`).toBeTruthy();

      const importsHubspotClient = handlerModule
        ? moduleTransitivelyImportsHubspotClient(handlerModule)
        : false;

      if (tool.requiresAuth === false) {
        expect(
          importsHubspotClient,
          `${tool.name} is auth-exempt but its handler transitively imports hubspot-client`
        ).toBe(false);
      }

      if (importsHubspotClient) {
        expect(
          tool.requiresAuth,
          `${tool.name} imports hubspot-client transitively and must require auth`
        ).toBe(true);
      }
    }
  });
});
