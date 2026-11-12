import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import miniInput from './fixtures/mini-openapi.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '..');
const generator = pathToFileURL(join(root, 'scripts/generate-api-catalog.mjs')).href;
const miniPath = join(root, 'test/fixtures/mini-openapi.json');
const miniSource = {
  url: 'https://example.com/mini-openapi.json', retrieved_at: '2026-11-08T00:00:00+00:00',
  sha256: '2dba79fbc66eff337779fe4713876837fa8261b1947ef3b85892cbd13de3e322',
  bytes: 14918, paths: 4, operations: 4,
};
const miniIds = ['get_agents_route', 'create_agent_route', 'create_file_document_route', 'update_file_document_route'] as const;
function miniPolicy() {
  return {
    ...structuredClone(policyInput), source: miniSource,
    operations: Object.fromEntries(miniIds.map(id => [id, { ...structuredClone(policyInput.operations[id]), follow_ups: [] }])),
  };
}

function runModule(source: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

// Invoke the actual generator in a fresh process; no replacements for its pin,
// policy validation, schema compiler or coverage rosters run in this seam.
const compileModule = `
  import { readFile } from 'node:fs/promises';
  import { compileCatalog, loadCoverageRosters, renderCatalog } from ${JSON.stringify(generator)};
  const [root, specPath, policyPath] = process.argv.slice(1);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const catalog = compileCatalog(await readFile(specPath), policy, policy.source, await loadCoverageRosters(root));
  process.stdout.write(renderCatalog(catalog));
`;
function compile(specPath: string, policyPath: string) {
  return runModule(compileModule, [root, specPath, policyPath]);
}
function addQueryParameter(spec: typeof miniInput, parameter: {
  name: string; in: string; required?: boolean; schema: Record<string, unknown>;
}) {
  const parameters: typeof parameter[] = spec.paths['/v1/convai/agents'].get.parameters;
  parameters.push(parameter);
}
async function compileFixture(directory: string, spec: unknown, sha256: string) {
  const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n');
  const policy = miniPolicy();
  policy.source = { ...miniSource, sha256, bytes: bytes.length };
  const specPath = join(directory, 'spec.json');
  const policyPath = join(directory, 'policy.json');
  await writeFile(specPath, bytes);
  await writeFile(policyPath, JSON.stringify(policy));
  return compile(specPath, policyPath);
}
async function expectImportedCatalog(directory: string, result: ReturnType<typeof compile>, assertions: string) {
  expect(result.status, result.stderr).toBe(0);
  const sourcePath = join(directory, 'catalog.ts');
  const modulePath = join(directory, 'catalog.mjs');
  await writeFile(sourcePath, result.stdout);
  const imported = runModule(`
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    import ts from 'typescript';
    const [sourcePath, modulePath] = process.argv.slice(1);
    const { outputText } = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    await writeFile(modulePath, outputText);
    const { apiCatalog } = await import(pathToFileURL(modulePath).href);
    ${assertions}
  `, [sourcePath, modulePath]);
  expect(imported.status, imported.stderr).toBe(0);
  expect(imported.stderr).toBe('');
}
async function scratch(test: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'elevenlabs-generator-contract-'));
  try { await test(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function expectRefusal(result: ReturnType<typeof runModule>, diagnostic: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout).toBe('');
}

describe('generator subprocess contracts', () => {
  it.each([
    ['Missing', '22fab9f6377bf98bf28ab7d14c9be64b4e56de919eecde128a7d4d7d75f0ab2b'],
    ['__proto__', 'ddca55577ab360e18e79cc4234272cd8cf46ba232be6aec347ecf1ff2ba9fb3a'],
    ['constructor', 'b82dd2540397d6d18e7d6c88b2c48e2d92cc285a06b0aa584cde7bd2f2627a25'],
    ['toString', 'ab43aeff2b795ce0fbffed71fe5f3c3feeb29b2839ec1da11ebe35a2db5ea195'],
  ])('refuses absent own component %s rather than reading its prototype', async (name, sha256) => {
    await scratch(async directory => {
      const spec = structuredClone(miniInput);
      spec.components.schemas.CreateBody.properties = {
        ...spec.components.schemas.CreateBody.properties,
        ...Object.fromEntries([['missing', { $ref: '#/components/schemas/' + name }]]),
      };
      expectRefusal(await compileFixture(directory, spec, sha256), 'missing component');
    });
  });

  it.each([
    ['multipart root', 'a55c4f34e0dfc0250835d13ce531a140592fad7e9b4f192ae071a666e0acca2a'],
    ['query', 'f734fcb0baf9624f5f41f9b0e49f5da9c9c7daf97a8e64017c3845aaa76af177'],
  ])('refuses an inherited component in a %s reference', async (position, sha256) => {
    await scratch(async directory => {
      const spec = structuredClone(miniInput);
      const schema = { $ref: '#/components/schemas/__proto__' };
      if (position === 'multipart root') {
        spec.paths['/v1/convai/knowledge-base/file'].post.requestBody.content['multipart/form-data'].schema = schema;
      } else {
        addQueryParameter(spec, { name: 'value', in: 'query', schema });
      }
      expectRefusal(await compileFixture(directory, spec, sha256), 'missing component');
    });
  });

  it('retains special query names, their constraints and serialization in the imported module', async () => {
    await scratch(async directory => {
      const spec = structuredClone(miniInput);
      for (const name of ['__proto__', 'constructor', 'toString']) {
        addQueryParameter(spec, {
          name, in: 'query', required: true, schema: { type: 'string', enum: ['yes', 'no'] },
        });
      }
      const result = await compileFixture(directory, spec, '97f645422d4b4f4db0d4021bd3745c22cea9a754f773c308702e215d8de4efa0');
      await expectImportedCatalog(directory, result, `
        const parameters = apiCatalog.operations.find(row => row.operation_id === 'get_agents_route').parameters;
        for (const name of ['__proto__', 'constructor', 'toString']) {
          assert.deepStrictEqual(Object.getOwnPropertyDescriptor(parameters.query.properties, name), {
            value: { type: 'string', enum: ['yes', 'no'] }, writable: true, enumerable: true, configurable: true,
          });
          assert(parameters.query.required.includes(name));
          assert.strictEqual(Object.getOwnPropertyDescriptor(parameters.query_serialization, name)?.value, 'form-explode');
        }
        assert.strictEqual(Object.getPrototypeOf(parameters.query.properties), Object.prototype);
        assert.strictEqual(Object.getPrototypeOf(parameters.query_serialization), Object.prototype);
      `);
    });
  });

  it('preserves own special body properties and component names through TypeScript emission and module import', async () => {
    await scratch(async directory => {
      const spec = structuredClone(miniInput);
      const components = Object.fromEntries([
        ['__proto__', { type: 'string', minLength: 2 }], ['constructor', { type: 'null' }], ['toString', false],
      ]);
      spec.components.schemas = { ...spec.components.schemas, ...components };
      spec.components.schemas.CreateBody.properties = {
        ...spec.components.schemas.CreateBody.properties,
        ...Object.fromEntries(Object.keys(components).map(name => [name, { $ref: '#/components/schemas/' + name }])),
      };
      const result = await compileFixture(directory, spec, 'b6f51898f6e3729293eea7b602ecf68ea6b67b224f6f75a91263885917f1af1e');
      await expectImportedCatalog(directory, result, `
        const properties = apiCatalog.$defs.CreateBody.properties;
        const expected = JSON.parse(${JSON.stringify(JSON.stringify(components))});
        for (const [name, schema] of Object.entries(expected)) {
          assert.deepStrictEqual(Object.getOwnPropertyDescriptor(properties, name), {
            value: { $ref: '#/$defs/' + name }, writable: true, enumerable: true, configurable: true,
          });
          assert.deepStrictEqual(Object.getOwnPropertyDescriptor(apiCatalog.$defs, name)?.value, schema);
        }
        assert.strictEqual(Object.getPrototypeOf(properties), Object.prototype);
        assert.strictEqual(Object.getPrototypeOf(apiCatalog.$defs), Object.prototype);
      `);
    });
  });

  it('emits identical JSON/gzip catalogues but refuses byte changes that preserve the parsed document', async () => {
    await scratch(async directory => {
      const bytes = await readFile(miniPath);
      const policyPath = join(directory, 'policy.json');
      const gzipPath = join(directory, 'spec.gz');
      await writeFile(policyPath, JSON.stringify(miniPolicy()));
      await writeFile(gzipPath, gzipSync(bytes));
      const json = compile(miniPath, policyPath);
      const gzip = compile(gzipPath, policyPath);
      expect(json.status).toBe(0);
      expect(json.stderr).toBe('');
      expect(json.stdout).toContain('export const apiCatalog');
      expect(gzip.status).toBe(0);
      expect(gzip.stderr).toBe('');
      expect(gzip.stdout).toBe(json.stdout);

      const changed = Buffer.from(bytes);
      changed[bytes.indexOf(0x20)] = 0x09;
      expect(changed.length).toBe(bytes.length);
      expect(changed.equals(bytes)).toBe(false);
      expect(JSON.parse(changed.toString())).toEqual(JSON.parse(bytes.toString()));
      const changedPath = join(directory, 'changed.json');
      await writeFile(changedPath, changed);
      await writeFile(gzipPath, gzipSync(changed));
      expectRefusal(compile(changedPath, policyPath), 'source pin mismatch');
      expectRefusal(compile(gzipPath, policyPath), 'source pin mismatch');
    });
  });

  it('refuses an unreviewed census or unsupported header before emitting any catalogue', async () => {
    await scratch(async directory => {
      const policyPath = join(directory, 'policy.json');
      const specPath = join(directory, 'spec.json');
      await writeFile(policyPath, JSON.stringify(miniPolicy()));
      expect(compile(miniPath, policyPath).status).toBe(0);

      const cases = [
        {
          spec: {
            ...miniInput, paths: {
              ...miniInput.paths,
              '/v1/convai/agents': {
                ...miniInput.paths['/v1/convai/agents'],
                post: { operationId: 'unreviewed_operation', responses: { '204': { description: 'Empty' } } },
              },
            },
          },
          sha256: '769a4dfaa955869355bf35cb319c48e91fa9fed03d32c7f4161f6777a2455a60',
          diagnostic: 'exact spec/policy operation ID set',
        },
        {
          spec: (() => {
            const spec = structuredClone(miniInput);
            spec.paths['/v1/convai/agents'].get.parameters.push({ name: 'x-session', in: 'header', schema: { type: 'string' } });
            return spec;
          })(),
          sha256: '1cb95d6c714753d676d134dd65bcb32f6e35c9fd577e3717d830a73ce1dc7b2b',
          diagnostic: 'unsupported header parameter',
        },
      ];
      for (const { spec, sha256, diagnostic } of cases) {
        const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n');
        const policy = miniPolicy();
        policy.source = { ...miniSource, sha256, bytes: bytes.length };
        await writeFile(policyPath, JSON.stringify(policy));
        await writeFile(specPath, bytes);
        expectRefusal(compile(specPath, policyPath), diagnostic);
      }
    });
  });
});

const sourcePath = process.env.ELEVENLABS_OPENAPI_SPEC;
it.skipIf(!sourcePath)('regenerates deterministically and detects drift without rewriting either artifact', async () => {
  await scratch(async directory => {
    const fixtureRoot = join(directory, 'elevenlabs');
    await mkdir(join(fixtureRoot, 'api'), { recursive: true });
    await mkdir(join(fixtureRoot, 'test/fixtures'), { recursive: true });
    await copyFile(join(root, 'api/operation-policy.json'), join(fixtureRoot, 'api/operation-policy.json'));
    await copyFile(join(root, 'test/fixtures/legacy-tools.json'), join(fixtureRoot, 'test/fixtures/legacy-tools.json'));
    await symlink(resolve(root, '../elevenlabs-agents'), join(directory, 'elevenlabs-agents'), 'dir');
    const generateModule = `
      import { generateArtifacts } from ${JSON.stringify(generator)};
      const [root, spec, mode] = process.argv.slice(1);
      console.log(JSON.stringify(await generateArtifacts(root, spec, mode === 'check')));
    `;
    const generate = (mode: string) => runModule(generateModule, [fixtureRoot, resolve(sourcePath!), mode]);
    const artifacts = ['src/generated/api-catalog.ts', 'API_COVERAGE.md'];
    const contents = () => Promise.all(artifacts.map(file => readFile(join(fixtureRoot, file), 'utf8')));
    expect(generate('write').status).toBe(0);
    const original = await contents();
    expect(generate('write').status).toBe(0);
    expect(await contents()).toEqual(original);
    expect(generate('check').status).toBe(0);

    const drift = original[0] + '// Deliberate contract-test drift.\n';
    await writeFile(join(fixtureRoot, artifacts[0]), drift);
    expectRefusal(generate('check'), 'generated artifact drift: src/generated/api-catalog.ts');
    expect(await contents()).toEqual([drift, original[1]]);
    await writeFile(join(fixtureRoot, artifacts[0]), original[0]);
    expect(generate('check').status).toBe(0);
  });
}, 30_000);
