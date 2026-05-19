import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ENABLE_GOOGLE_TASKS_FORMS = 'true';
const definitionsUrl = pathToFileURL(path.join(root, 'dist/tools/definitions/index.js')).href;
const { allTools } = await import(definitionsUrl);

const inventory = {
  generatedAt: new Date().toISOString(),
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
