import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAccountsMock = vi.fn();

vi.mock('../src/modules/accounts/manager.js', () => ({
  getAccountManager: () => ({
    getAccounts: getAccountsMock,
  }),
}));

import { HubSpotServer } from '../src/tools/server.js';

const readScopeTier = async (server: HubSpotServer): Promise<'readonly' | 'full'> => {
  const internalServer = server as unknown as { getScopeTier: () => Promise<'readonly' | 'full'> };
  return internalServer.getScopeTier();
};

describe('HubSpotServer getScopeTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HUBSPOT_SCOPE_TIER;
    delete process.env.HUBSPOT_ACCOUNT_EMAIL;
  });

  afterEach(() => {
    delete process.env.HUBSPOT_SCOPE_TIER;
    delete process.env.HUBSPOT_ACCOUNT_EMAIL;
  });

  it('uses HUBSPOT_SCOPE_TIER env override when present', async () => {
    process.env.HUBSPOT_SCOPE_TIER = 'readonly';
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'selected@example.com';
    getAccountsMock.mockResolvedValue([{ email: 'selected@example.com', scopeTier: 'full' }]);

    const server = new HubSpotServer();
    await expect(readScopeTier(server)).resolves.toBe('readonly');
  });

  it('uses the selected account tier from HUBSPOT_ACCOUNT_EMAIL when env override is absent', async () => {
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'selected@example.com';
    getAccountsMock.mockResolvedValue([
      { email: 'other@example.com', scopeTier: 'readonly' },
      { email: 'selected@example.com', scopeTier: 'full' },
    ]);

    const server = new HubSpotServer();
    await expect(readScopeTier(server)).resolves.toBe('full');
  });

  it('falls back to full when HUBSPOT_ACCOUNT_EMAIL does not match accounts.json', async () => {
    process.env.HUBSPOT_ACCOUNT_EMAIL = 'missing@example.com';
    getAccountsMock.mockResolvedValue([{ email: 'other@example.com', scopeTier: 'readonly' }]);

    const server = new HubSpotServer();
    await expect(readScopeTier(server)).resolves.toBe('full');
  });

  it('falls back to full when HUBSPOT_ACCOUNT_EMAIL is unset', async () => {
    getAccountsMock.mockResolvedValue([{ email: 'first@example.com', scopeTier: 'readonly' }]);

    const server = new HubSpotServer();
    await expect(readScopeTier(server)).resolves.toBe('full');
  });
});
