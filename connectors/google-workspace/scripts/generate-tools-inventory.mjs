import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const definitionsUrl = pathToFileURL(path.join(root, 'dist/tools/definitions/index.js')).href;
const { allTools } = await import(definitionsUrl);

// Deterministic output: no generatedAt timestamp. A timestamp made every
// build rewrite this committed file, creating a spurious diff that dirtied the
// submodule and aborted the release sync (google-workspace 0.1.4, 2026-07-01).
// git history already records when the inventory changed.
const inventory = {
  tools: allTools.map(tool => ({
    name: tool.name,
    annotations: tool.annotations ?? {},
  })),
};

fs.writeFileSync(
  path.join(root, 'tools-inventory.json'),
  `${JSON.stringify(inventory, null, 2)}\n`,
);

console.log(`Generated tools-inventory.json with ${inventory.tools.length} tools`);
