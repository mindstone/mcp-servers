import { createRedactor } from '../src/api-sensitive.js';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import policyInput from '../api/operation-policy.json' with { type: 'json' };
import lifecycleCases from './fixtures/api-agent-lifecycle-wire-cases.json' with { type: 'json' };
import { apiCatalog } from '../src/generated/api-catalog.js';
import { discoverOperations, loadApiCatalog, validateApiCatalog } from '../src/api-catalog.js';
import { createSuccessReceipt, validateRequest } from '../src/api-validation.js';
import { compileCatalog, loadCoverageRosters, PINNED_SOURCE, validatePolicy } from '../scripts/generate-api-catalog.mjs';

const root = resolve(import.meta.dirname, '..');
const rosters = await loadCoverageRosters(root);
const writes = ['create_agent_draft_route', 'update_branch_route', 'update_procedure_draft_route', 'update_merge_proposal_route', 'merge_branch_into_target', 'rebase_branch_onto_main', 'accept_merge_proposal_route', 'create_agent_deployment_route', 'submit_merge_proposal_review_route'] as const;

describe('agent lifecycle admission and effects', () => {
  it('admits the exact 32 reviewed lifecycle contracts and keeps their examples callable', async () => {
    const catalog = await loadApiCatalog();
    const ids = lifecycleCases.map(wire => wire.id).sort();
    expect(ids).toHaveLength(32);
    expect(catalog.operations.filter(op => op.family === 'agents' && op.milestone === 7 && !['get_agent_summaries_route', 'post_agent_avatar_route', 'post_agent_hold_audio_route'].includes(op.operation_id) && !['get_agent_knowledge_base_size', 'get_agent_llm_expected_cost_calculation', 'create_manual_agent_ticket_route', 'list_agent_conversation_tickets_route', 'delete_agent_hold_audio_route'].includes(op.operation_id)).map(op => op.operation_id)).toEqual(ids);
    for (const id of ids) {
      const op = catalog.operations.find(op => op.operation_id === id)!;
      expect(op.deprecated, id).toBe(false);
      for (const example of op.examples) await expect(validateRequest(op.profile, example, createRedactor([]))).resolves.toMatchObject({ operation_id: id });
      for (const followUp of op.follow_ups) {
        expect(followUp).not.toBe(id);
        expect(catalog.operations.find(candidate => candidate.operation_id === followUp)?.profile).toBe('read');
      }
      if (op.method === 'DELETE') expect(op.profile).toBe('delete');
    }
  });

  it.each(writes)('%s changes existing state through the destructive change profile and explains its effect', async operation_id => {
    const result = await discoverOperations({ operation_id });
    const note = policyInput.operations[operation_id].effect_note;
    expect(result).toMatchObject({ profile: 'change', tool: 'elevenlabs_change_resource', effects: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } });
    expect(result).toHaveProperty('instructions', expect.stringContaining(note));
  });

  it.each(['merge_preview_route', 'rebase_preview_route', 'compile_procedures_route'])('%s performs only a preview/read', async operation_id => {
    const result = await discoverOperations({ operation_id });
    expect(result).toMatchObject({ profile: 'read', effects: { readOnlyHint: true, destructiveHint: false } });
    if (operation_id === 'compile_procedures_route') {
      expect(result).toHaveProperty('instructions', expect.stringContaining('Legacy dry-run only'));
    }
  });

  it.each([
    ['get_branch_route', 'branch_id'],
    ['get_version_metadata_route', 'version_id'],
  ])('%s leads from metadata to the selected configuration', async (operation_id, selector) => {
    const wire = lifecycleCases.find(row => row.id === operation_id)!;
    const receipt = await createSuccessReceipt(operation_id, wire.status, wire.media, wire.response, createRedactor([]));
    expect(receipt.response_contract).toBe('matched');
    expect(receipt.follow_up_operations).toEqual(['get_agent_route']);
    expect(receipt.next_step).toContain(`get_agent_route (path_params.agent_id, query_params.${selector} optional)`);
    await expect(validateRequest('read', { operation_id: 'get_agent_route', path_params: { agent_id: 'agent_example' }, query_params: { [selector]: 'selected_example' } }, createRedactor([])))
      .resolves.toMatchObject({ query_params: { [selector]: 'selected_example' } });
  });

  it('leads from the branch list to branch metadata and agent configuration', async () => {
    const wire = lifecycleCases.find(row => row.id === 'get_branches_route')!;
    const receipt = await createSuccessReceipt(wire.id, wire.status, wire.media, wire.response, createRedactor([]));
    expect(receipt.response_contract).toBe('matched');
    expect(receipt.follow_up_operations).toEqual(['get_branch_route', 'get_agent_route']);
    expect(receipt.next_step).toContain('get_branch_route (path_params.agent_id, path_params.branch_id)');
    expect(receipt.next_step).toContain('get_agent_route (path_params.agent_id)');
  });

  it('requires the legacy compile POST-read review at generation and runtime', () => {
    const policy = structuredClone(policyInput);
    delete (policy.operations.compile_procedures_route as { reviewed_post_read?: string }).reviewed_post_read;
    expect(() => validatePolicy(policy, rosters)).toThrow('unreviewed POST read');
    const catalog = structuredClone(validateApiCatalog(apiCatalog));
    delete catalog.operations.find(op => op.operation_id === 'compile_procedures_route')!.reviewed_post_read;
    expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
  });

  it('refuses self-referencing and non-read follow-ups at both boundaries', () => {
    for (const target of ['create_agent_draft_route', 'create_branch_route']) {
      const policy = structuredClone(policyInput);
      policy.operations.create_agent_draft_route.follow_ups = [target];
      expect(() => validatePolicy(policy, rosters)).toThrow();
      const catalog = structuredClone(validateApiCatalog(apiCatalog));
      catalog.operations.find(op => op.operation_id === 'create_agent_draft_route')!.follow_ups = [target];
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
  });

  it.each(['get_branches_route', 'list_agent_deployments_route'] as const)('%s exposes explicit manual paging without cursor projections', async operation_id => {
    const catalog = await loadApiCatalog();
    const op = catalog.operations.find(op => op.operation_id === operation_id)!;
    expect(op.pagination).toBeNull();
    expect(op.manual_pagination).toContain('no automatic next-page instruction');
    expect(await discoverOperations({ operation_id })).toHaveProperty('instructions', expect.stringContaining(op.manual_pagination!));
  });

  it('refuses manual paging on mutations and cursor contracts at the consumed boundary', () => {
    for (const id of ['create_agent_draft_route', 'list_merge_proposals_route', 'get_agent_route']) {
      const catalog = structuredClone(validateApiCatalog(apiCatalog));
      catalog.operations.find(op => op.operation_id === id)!.manual_pagination = 'Invalid paging assignment.';
      expect(() => validateApiCatalog(catalog)).toThrow(expect.objectContaining({ code: 'CATALOG_INVALID' }));
    }
    const policy = structuredClone(policyInput);
    Object.assign(policy.operations.create_agent_draft_route, { manual_pagination: 'Invalid paging assignment.' });
    expect(() => validatePolicy(policy, rosters)).toThrow('invalid manual pagination');
  });

  const source = process.env.ELEVENLABS_OPENAPI_SPEC;
  it.skipIf(!source)('refuses unreviewed or misplaced manual pagination against the pinned source', async () => {
    const bytes = await readFile(source!);
    for (const id of ['get_branches_route', 'list_agent_deployments_route'] as const) {
      const policy = structuredClone(policyInput);
      delete (policy.operations[id] as { manual_pagination?: string }).manual_pagination;
      expect(() => compileCatalog(bytes, policy, PINNED_SOURCE, rosters)).toThrow('unsupported pagination');
    }
    for (const id of ['get_agent_route', 'list_merge_proposals_route', 'create_agent_draft_route'] as const) {
      const policy = structuredClone(policyInput);
      Object.assign(policy.operations[id], { manual_pagination: 'Cannot override an unsupported pagination contract.' });
      expect(() => compileCatalog(bytes, policy, PINNED_SOURCE, rosters)).toThrow('invalid manual pagination');
    }
  });
});
