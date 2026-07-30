import { describe, expect, it, vi } from 'vitest';
import { ChatGPTAccountPool, type ChatGPTAccount } from './chatgpt-pool';

describe('ChatGPTAccountPool', () => {
  it('should deduplicate concurrent refresh requests via single-flight', async () => {
    const pool = new ChatGPTAccountPool('http://localhost/callback');
    const mockAccount: ChatGPTAccount = {
      id: 'acc-1',
      label: 'Test Account',
      accessToken: 'old-access-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: Date.now() - 1000,
      status: 'active',
      lastUsedAt: Date.now(),
      usageScore: 0,
      errorCount: 0,
      poolWeight: 1,
    };

    await pool.addAccount(mockAccount);

    let refreshCallCount = 0;
    vi.spyOn((pool as any).oauthFlow, 'refreshToken').mockImplementation(
      async () => {
        refreshCallCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          expiresIn: 3600,
        };
      }
    );

    const [res1, res2] = await Promise.all([
      pool.refreshAccount('acc-1'),
      pool.refreshAccount('acc-1'),
    ]);

    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(refreshCallCount).toBe(1);
  });

  it('should not increment errorCount on transient network errors', () => {
    const pool = new ChatGPTAccountPool('http://localhost/callback');
    const mockAccount: ChatGPTAccount = {
      id: 'acc-2',
      label: 'Test Account 2',
      accessToken: 'access-token',
      expiresAt: Date.now() + 3600000,
      status: 'active',
      lastUsedAt: Date.now(),
      usageScore: 0,
      errorCount: 0,
      poolWeight: 1,
    };

    (pool as any).accounts = [mockAccount];

    // Transient timeout error cools down account without locking status to error
    pool.recordFailure('acc-2', 'timeout');
    const acc = pool.getAccount('acc-2');
    expect(acc?.status).toBe('active');
    expect(acc?.cooldownUntil).toBeGreaterThan(Date.now());
  });
});
