import { beforeEach, describe, expect, it, vi } from 'vitest';

const listOwnersMock = vi.fn();
const getCurrentAccountEmailMock = vi.fn();

vi.mock('../src/api/hubspot-client.js', () => ({
  getHubSpotClientAsync: vi.fn(async () => ({
    listOwners: listOwnersMock,
  })),
}));

vi.mock('../src/modules/accounts/manager.js', () => ({
  getAccountManager: () => ({
    getCurrentAccountEmail: getCurrentAccountEmailMock,
  }),
}));

import { clearOwnerCache, injectHostMetadata } from '../src/utils/user-context.js';

describe('injectHostMetadata', () => {
  beforeEach(() => {
    clearOwnerCache();
    vi.clearAllMocks();
    delete process.env.HUBSPOT_SOURCE_LABEL;
    getCurrentAccountEmailMock.mockResolvedValue('test@example.com');
  });

  it('injects HUBSPOT_SOURCE_LABEL when configured', async () => {
    process.env.HUBSPOT_SOURCE_LABEL = 'Test Label';
    listOwnersMock.mockResolvedValue({
      results: [{ id: '5001', firstName: 'Test', lastName: 'User', email: 'test@example.com' }],
    });

    const result = await injectHostMetadata({ email: 'new@example.com' }, 'contacts');

    expect(result.hs_object_source_detail_2).toBe('Created by Test User via Test Label');
  });

  it('defaults to HubSpot MCP when HUBSPOT_SOURCE_LABEL is unset', async () => {
    listOwnersMock.mockResolvedValue({ results: [] });

    const result = await injectHostMetadata({ email: 'new@example.com' }, 'contacts');

    expect(result.hs_object_source_detail_2).toBe('Created by test@example.com via HubSpot MCP');
  });

  it('preserves pre-existing via Rebel labels without retroactive rewrite', async () => {
    process.env.HUBSPOT_SOURCE_LABEL = 'Test Label';
    const original = 'Created by Legacy User via Rebel';

    const result = await injectHostMetadata(
      { hs_object_source_detail_2: original, email: 'legacy@example.com' },
      'contacts'
    );

    expect(result.hs_object_source_detail_2).toBe(original);
    expect(listOwnersMock).not.toHaveBeenCalled();
  });
});
