import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ENABLE_GOOGLE_TASKS_FORMS = 'true';
const definitionsUrl = pathToFileURL(path.join(root, 'dist/tools/definitions/index.js')).href;
const { allTools } = await import(definitionsUrl);

const destructiveOverrides = JSON.parse(
  fs.readFileSync(path.join(root, 'src/tools/definitions/destructive-overrides.json'), 'utf8'),
);
const openWorldOverrides = JSON.parse(
  fs.readFileSync(path.join(root, 'src/tools/definitions/open-world-overrides.json'), 'utf8'),
);

const errors = [];
for (const tool of allTools) {
  if (!Object.prototype.hasOwnProperty.call(destructiveOverrides, tool.name)) {
    errors.push(`Missing destructive override for ${tool.name}`);
    continue;
  }
  if (!Object.prototype.hasOwnProperty.call(openWorldOverrides, tool.name)) {
    errors.push(`Missing openWorld override for ${tool.name}`);
    continue;
  }
  if (tool.annotations?.destructiveHint !== destructiveOverrides[tool.name]) {
    errors.push(
      `${tool.name}: destructiveHint=${tool.annotations?.destructiveHint} expected ${destructiveOverrides[tool.name]}`,
    );
  }
  if (tool.annotations?.openWorldHint !== openWorldOverrides[tool.name]) {
    errors.push(
      `${tool.name}: openWorldHint=${tool.annotations?.openWorldHint} expected ${openWorldOverrides[tool.name]}`,
    );
  }
}

const toolNames = new Set(allTools.map(tool => tool.name));
for (const name of Object.keys(destructiveOverrides)) {
  if (!toolNames.has(name)) errors.push(`Stale destructive override for ${name}`);
}
for (const name of Object.keys(openWorldOverrides)) {
  if (!toolNames.has(name)) errors.push(`Stale openWorld override for ${name}`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

// Deterministic output: no generatedAt timestamp (see generate-tools-inventory.mjs).
// A per-build timestamp dirtied this committed file and aborted the release sync.
const inventory = {
  tools: allTools.map(tool => ({
    name: tool.name,
    annotations: tool.annotations ?? {},
  })),
};
fs.writeFileSync(path.join(root, 'tools-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Tool annotation check passed for ${allTools.length} tools`);
