import { createRedactor } from '../src/api-sensitive.js';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import { apiCatalog } from '../src/generated/api-catalog.js';
import { apiFamilies, discoveryFamilies, profileOperationIds } from '../src/generated/api-metadata.js';
import { validateApiCatalog, loadApiCatalog, discoveryInputSchema, discoverOperations } from '../src/api-catalog.js';
import { validateRequest } from '../src/api-validation.js';
import { loadCoverageRosters, renderMetadata, validatePolicy } from '../scripts/generate-api-catalog.mjs';
import { readFile } from 'node:fs/promises';
import wireCases from './fixtures/api-json-family-wire-cases.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const postReads = ['get_agent_response_tests_summaries_route', 'get_public_llm_expected_cost_calculation', 'get_agent_llm_expected_cost_calculation'] as const;

describe('additional JSON family admission boundaries', () => {
  it('covers exactly the reviewed additional 34 IDs with stated nondeprecated status and valid examples', async () => {
    const catalog = await loadApiCatalog();
    const additions = catalog.operations.filter(op => wireCases.some(wire => wire.id === op.operation_id));
    expect(additions.map(op => op.operation_id).sort()).toEqual(wireCases.map(wire => wire.id).sort());
    expect(additions).toHaveLength(34);
    for (const op of additions) {
      expect(op.deprecated, op.operation_id).toBe(false);
      expect(op.examples.length, op.operation_id).toBeGreaterThan(0);
      for (const example of op.examples) await expect(validateRequest(op.profile, example, createRedactor([]))).resolves.toMatchObject({ operation_id: op.operation_id });
      for (const followUp of op.follow_ups) expect(catalog.operations.find(candidate => candidate.operation_id === followUp)?.profile).toBe('read');
      expect(op.effects.destructiveHint).toBe(['change', 'delete'].includes(op.profile));
      if (op.method === 'DELETE') expect(op.profile).toBe('delete');
    }
  });

  it.each(postReads)('%s requires an explicit reviewed POST-read reason at generation and runtime', id => {
    const policy = structuredClone(policyInput);
    delete (policy.operations[id] as { reviewed_post_read?: string }).reviewed_post_read;
    expect(() => validatePolicy(policy, rosters)).toThrow('unreviewed POST read');
    const catalog = validateApiCatalog(apiCatalog);
    const broken = structuredClone(catalog);
    delete broken.operations.find(op => op.operation_id === id)!.reviewed_post_read;
    expect(() => validateApiCatalog(broken)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    expect(catalog.operations.find(op => op.operation_id === id)).toMatchObject({ method: 'POST', profile: 'read', effects: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } });
  });

  it.each(postReads)('refuses reviewed POST read %s as a family retry check at generation', id => {
    const policy = structuredClone(policyInput);
    policy.family_retry_checks.tags.read = id;
    expect(() => validatePolicy(policy, rosters)).toThrow('family retry check must be an admitted GET read');
  });

  it.each(postReads)('refuses reviewed POST read %s as a family retry check at runtime', id => {
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    catalog.operations.find(op => op.operation_id === 'create_conversation_tag_route')!.check_before_retry = id;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it('does not send collection, settings or calculation results back to themselves for an ID readback', async () => {
    for (const op of (await loadApiCatalog()).operations) expect(op.follow_ups, op.operation_id).not.toContain(op.operation_id);
  });

  it.each(['update_settings_route', 'update_dashboard_settings_route'])('%s explains the workspace scope in discovery', async operation_id => {
    const result = await discoverOperations({ operation_id });
    expect(result).toHaveProperty('instructions', expect.stringContaining('This operation changes settings for the whole workspace.'));
    expect(result).toHaveProperty('effects', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });

  it('keeps all other method floors and named effect assignments when a reviewed reason is supplied', () => {
    for (const id of ['get_agents_route', 'create_agent_route', 'update_settings_route', 'delete_environment'] as const) {
      const policy = structuredClone(policyInput);
      Object.assign(policy.operations[id], { reviewed_post_read: 'A reason cannot override a method floor or named review.', profile: 'read', effects: policy.operations.get_agents_route.effects });
      expect(() => validatePolicy(policy, rosters)).toThrow();
    }
  });

  it('rejects missing, planned and mutation retry-check targets in policy and runtime', () => {
    for (const target of ['invented', 'get_signed_url_deprecated', 'create_conversation_tag_route']) {
      const policy = structuredClone(policyInput);
      policy.family_retry_checks.tags.read = target;
      expect(() => validatePolicy(policy, rosters)).toThrow('family retry check must be an admitted GET read');
      const catalog = structuredClone(validateApiCatalog(apiCatalog));
      catalog.operations.find(op => op.operation_id === 'create_conversation_tag_route')!.check_before_retry = target;
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
  });

  it('derives lightweight descriptions and the discovery enum from every admitted family/profile', async () => {
    const catalog = await loadApiCatalog();
    expect(await readFile(resolve(root, 'src/generated/api-metadata.ts'), 'utf8')).toBe(renderMetadata(catalog));
    expect(discoveryInputSchema.innerType().shape.family.unwrap().options).toEqual(discoveryFamilies);
    expect(new Set(discoveryFamilies)).toEqual(new Set(Object.values(apiFamilies)));
    for (const family of discoveryFamilies) {
      const result = await discoverOperations({ family, limit: 25 });
      expect('operations' in result && result.operations.length).toBeGreaterThan(0);
      if ('operations' in result) expect(result.operations.every(op => op.family === family)).toBe(true);
    }
    for (const [profile, ids] of Object.entries(profileOperationIds)) expect(ids).toEqual(catalog.operations.filter(op => op.profile === profile).map(op => op.operation_id).sort());
  });
});
