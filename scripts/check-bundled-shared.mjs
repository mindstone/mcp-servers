#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

function refresh(name, detail) {
  throw new Error(`${name}: ${detail}. To fix, run "npm update ${name} --package-lock-only --ignore-scripts" in the folder of the package you are releasing (it moves the locked copy to the version npm serves and edits only package-lock.json), merge that change, then release again. If this release's version bump has already merged, revert it before releasing again.`);
}

function lockedDependency(packages, dependent, name) {
  let location = dependent;
  for (;;) {
    const entry = packages[`${location ? location + '/' : ''}node_modules/${name}`];
    if (entry) return entry;
    if (!location) return undefined;
    const parent = location.lastIndexOf('/node_modules/');
    location = parent === -1 ? '' : location.slice(0, parent);
  }
}

function check(packageDir) {
  let packages;
  try {
    ({ packages } = JSON.parse(readFileSync(join(packageDir, 'package-lock.json'), 'utf8')));
    if (!packages || typeof packages !== 'object' || Array.isArray(packages) || !packages['']) throw new Error();
  } catch {
    throw new Error(`${basename(packageDir)}: cannot read package-lock.json; refresh the package lock before releasing.`);
  }

  for (const [location, dependent] of Object.entries(packages)) {
    if (dependent.dev || dependent.link) continue;
    const dependencies = { ...dependent.peerDependencies, ...dependent.dependencies, ...dependent.optionalDependencies };
    for (const [name, range] of Object.entries(dependencies)) {
      if (!name.startsWith('@mindstone/')) continue;
      const locked = lockedDependency(packages, location, name);
      if (!locked || locked.link || typeof locked.version !== 'string' || !locked.version.trim()) {
        refresh(name, 'missing a locked production version');
      }
      if (typeof range !== 'string' || !range.trim()) refresh(name, 'missing a production dependency range');

      let current;
      let cache;
      try {
        // npm can return stale cached metadata when online revalidation fails.
        cache = mkdtempSync(join(tmpdir(), 'bundled-shared-'));
        const result = spawnSync('npm', ['pack', `${name}@${range}`, '--dry-run', '--json', '--ignore-scripts', '--prefer-online', '--cache', cache], {
          cwd: packageDir,
          encoding: 'utf8',
          timeout: 60_000,
          stdio: 'pipe',
        });
        if (result.error || result.status !== 0) throw new Error();
        const answer = JSON.parse(result.stdout);
        if (!Array.isArray(answer) || answer.length !== 1 || answer[0]?.name !== name ||
          typeof answer[0].version !== 'string' || !answer[0].version.trim() ||
          typeof answer[0].integrity !== 'string' || !answer[0].integrity.trim()) throw new Error();
        current = answer[0];
      } catch {
        throw new Error(`${name}: could not ask npm which version ${range} installs (a network, sign-in or registry problem), so nothing was published. Run "npm ping" to test the connection, then retry the release.`);
      } finally {
        if (cache) rmSync(cache, { recursive: true, force: true });
      }
      if (locked.version !== current.version) refresh(name, `package-lock.json would pack ${locked.version} into this release, but a fresh install of ${range} gets ${current.version}, so users would get a different version from the one npm serves`);
      if (locked.integrity !== current.integrity) refresh(name, 'the lockfile would pack a different file from the one npm serves (its integrity is missing or different)');
    }
  }
}

try {
  if (!process.argv[2]) throw new Error('Pass the package directory to check before releasing.');
  check(resolve(process.argv[2]));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
