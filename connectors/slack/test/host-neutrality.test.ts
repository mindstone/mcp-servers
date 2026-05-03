/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HIGH-2 — Host-neutrality regression test.
 *
 * The OSS package must NOT carry host-specific vocabulary anywhere users
 * see it: source files, compiled `dist/`, and the published tarball
 * (`README.md`, etc). § 13.4 lists "internal-reference scan returns
 * matches outside the allowlist" as a publish-blocking condition, and
 * § 13.5 requires "all user-facing strings host-neutral".
 *
 * Forbidden case-insensitive substrings: 'rebel', 'mindstone', 'nspr'.
 * Allowlist is intentionally minimal so an accidental reintroduction
 * fails loudly rather than silently slipping through.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');

// Patterns to ban in source + tarball (case-insensitive substring match).
const FORBIDDEN_PATTERNS = ['rebel', 'mindstone', 'nspr'] as const;

// Tarball-side allowlist: files that may legitimately reference these
// substrings without violating host-neutrality. Match by suffix on the
// tarball path (which always starts with `package/`).
const TARBALL_ALLOWLIST_SUFFIXES = [
  '/LICENSE',
  '/package.json',
  '/scripts/check-no-bridge-strings.sh',
];

// The npm-canonical package name from package.json. Lines that contain
// this literal are allowlisted everywhere because the scope is the
// package's canonical npm identity (per task allowlist: package.json
// `name`/`scope`). Users cannot install the package without referencing
// this scope, so install instructions in README.md MUST use it verbatim.
function packageJsonName(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8')) as {
    name: string;
  };
  return pkg.name;
}

function walkTs(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, files);
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function hasForbiddenSubstring(text: string, pkgName: string): string | null {
  const pkgNameLc = pkgName.toLowerCase();
  // Strip out the canonical package name before scanning so install
  // instructions / canonical references don't trip the check.
  const lc = text.toLowerCase().split(pkgNameLc).join('');
  for (const p of FORBIDDEN_PATTERNS) {
    if (lc.includes(p)) return p;
  }
  return null;
}

describe('host-neutrality — src/**/*.ts', () => {
  it('contains no host-specific vocabulary', () => {
    const pkgName = packageJsonName();
    const violations: { file: string; pattern: string; sample: string }[] = [];
    for (const file of walkTs(SRC_DIR)) {
      const contents = fs.readFileSync(file, 'utf-8');
      for (const line of contents.split(/\r?\n/)) {
        const hit = hasForbiddenSubstring(line, pkgName);
        if (hit) {
          violations.push({
            file: path.relative(PKG_ROOT, file),
            pattern: hit,
            sample: line.slice(0, 200),
          });
          // One violation per line is enough — keep the report short.
          break;
        }
      }
    }
    expect(
      violations,
      `Forbidden host vocabulary found in src/**/*.ts:\n` +
        violations.map((v) => `  - ${v.file} [${v.pattern}]: ${v.sample}`).join('\n'),
    ).toEqual([]);
  });
});

describe('host-neutrality — packed tarball', () => {
  it('contains no host-specific vocabulary outside the allowlist', () => {
    // Skip if dist/ is missing — the tarball can't be packed without it.
    // CI runs `npm run build` before tests so this should rarely skip.
    const distDir = path.join(PKG_ROOT, 'dist');
    if (!fs.existsSync(distDir)) {
      console.warn('[host-neutrality] dist/ missing — run `npm run build` first');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-host-neutrality-'));
    try {
      execSync(
        `npm pack --pack-destination "${tmpDir}" --silent --ignore-scripts`,
        { cwd: PKG_ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      const tarball = fs
        .readdirSync(tmpDir)
        .find((name) => name.endsWith('.tgz'));
      expect(tarball, 'npm pack should produce a .tgz').toBeTruthy();
      const tarballPath = path.join(tmpDir, tarball!);

      // List file paths inside the tarball.
      const fileList = execSync(`tar -tzf "${tarballPath}"`, { encoding: 'utf-8' })
        .split(/\r?\n/)
        .filter((p) => p && !p.endsWith('/'));

      const pkgName = packageJsonName();
      const violations: { file: string; pattern: string; sample: string }[] = [];
      for (const filePath of fileList) {
        if (TARBALL_ALLOWLIST_SUFFIXES.some((s) => filePath.endsWith(s))) continue;
        // Extract the file's contents to stdout — works on macOS bsdtar
        // and gnu tar.
        let contents = '';
        try {
          contents = execSync(`tar -xzOf "${tarballPath}" "${filePath}"`, {
            encoding: 'utf-8',
            maxBuffer: 25 * 1024 * 1024,
          });
        } catch {
          continue; // binary file extraction failure is rare; ignore.
        }
        for (const line of contents.split(/\r?\n/)) {
          const hit = hasForbiddenSubstring(line, pkgName);
          if (hit) {
            violations.push({
              file: filePath,
              pattern: hit,
              sample: line.slice(0, 200),
            });
            break;
          }
        }
      }
      expect(
        violations,
        `Forbidden host vocabulary found in packed tarball:\n` +
          violations.map((v) => `  - ${v.file} [${v.pattern}]: ${v.sample}`).join('\n'),
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
