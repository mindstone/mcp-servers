import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import knowledgeCases from './fixtures/api-knowledge-base-wire-cases.json' with { type: 'json' };
import { apiCatalog } from '../src/generated/api-catalog.js';
import { discoverOperations, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt, validateRequest } from '../src/api-validation.js';
import { loadCoverageRosters, validatePolicy } from '../scripts/generate-api-catalog.mjs';

const rosters = await loadCoverageRosters(resolve(import.meta.dirname, '..'));

describe('knowledge-base admission and discovery', () => {
  it('admits all 14 reviewed contracts with callable follow-ups and GET retry checks', async () => {
    const catalog = await loadApiCatalog();
    expect(knowledgeCases).toHaveLength(14);
    expect(catalog.operations.filter(op => op.family === 'knowledge-base' && op.milestone === 7).map(op => op.operation_id))
      .toEqual(knowledgeCases.map(row => row.id).sort());
    for (const wire of knowledgeCases) {
      const op = catalog.operations.find(op => op.operation_id === wire.id)!;
      expect(op.profile).toBe(wire.profile);
      expect(op.deprecated).toBe(false);
      expect(catalog.operations.find(candidate => candidate.operation_id === op.check_before_retry))
        .toMatchObject({ method: 'GET', profile: 'read' });
      const receipt = await createSuccessReceipt(wire.id, wire.status, wire.media, wire.response);
      expect(receipt.response_contract).toBe('matched');
      for (const id of op.follow_ups) {
        expect(id).not.toBe(wire.id);
        const next = catalog.operations.find(candidate => candidate.operation_id === id)!;
        expect(next.profile).toBe('read');
        const parameters = Object.fromEntries(next.parameters.path.required.map(name => [name, 'example_id']));
        await expect(validateRequest('read', { operation_id: id, path_params: parameters })).resolves.toMatchObject({ operation_id: id });
      }
    }
  });

  it.each([
    ['get_agent_knowledge_base_summaries_route', ['document summaries', 'query_params.document_ids', 'not an agent ID']],
    ['get_documentation_chunk_from_knowledge_base', ['one RAG chunk', 'path_params.documentation_id', 'path_params.chunk_id']],
  ])('%s has an explicit discovery summary distinguishing its operand and result', async (operation_id, terms) => {
    const result = await discoverOperations({ operation_id });
    for (const term of terms) expect(result).toHaveProperty('contract', expect.stringContaining(term));
  });

  it('states crawl fetch/credit, cancellation deletion and deprecated depth effects', async () => {
    expect(await discoverOperations({ operation_id: 'create_crawl_job_route' }))
      .toHaveProperty('instructions', expect.stringContaining('fetch the URL and may consume credits'));
    const create = await discoverOperations({ operation_id: 'create_crawl_job_route' });
    expect(create).toHaveProperty('contract', expect.stringContaining('"deprecated":true'));
    expect(await discoverOperations({ operation_id: 'cancel_crawl_job_route' }))
      .toMatchObject({ profile: 'delete', effects: { destructiveHint: true }, instructions: expect.stringContaining('deletes all associated documents and folders') });
    for (const operation_id of ['delete_rag_index', 'post_knowledge_base_bulk_delete_route']) {
      expect(await discoverOperations({ operation_id })).toMatchObject({ profile: 'delete', effects: { destructiveHint: true } });
    }
  });

  it('requires review for the bulk-dependent-agent POST read at both boundaries', () => {
    const policy = structuredClone(policyInput);
    delete (policy.operations.get_knowledge_base_bulk_dependent_agents_route as { reviewed_post_read?: string }).reviewed_post_read;
    expect(() => validatePolicy(policy, rosters)).toThrow('unreviewed POST read');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    delete catalog.operations.find(op => op.operation_id === 'get_knowledge_base_bulk_dependent_agents_route')!.reviewed_post_read;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it('refuses discovery-summary overrides on non-admitted operations', () => {
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations.assign_conversation_tags_route, { discovery_summary: 'Unreviewed summary.' });
    expect(() => validatePolicy(policy, rosters)).toThrow('non-admitted transport metadata');
  });

  it.each(['create', 'change', 'read'] as const)('refuses assigning POST bulk deletion to %s', profile => {
    const policy = structuredClone(policyInput);
    policy.operations.post_knowledge_base_bulk_delete_route.profile = profile;
    expect(() => validatePolicy(policy, rosters)).toThrow('unreviewed effect assignment');
  });

  it.each(['post_knowledge_base_move_route', 'post_knowledge_base_bulk_move_route'])('%s accepts moving to root without inventing a destination', async operation_id => {
    const args = operation_id === 'post_knowledge_base_move_route'
      ? { path_params: { document_id: 'doc_example' }, body: {} }
      : { body: { document_ids: ['doc_example'] } };
    await expect(validateRequest('change', { operation_id, ...args })).resolves.toMatchObject({ operation_id });
  });
});
