import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatGPTAccount } from './chatgpt-pool';
import { type SecretStore } from '../secret-store';
import { createSecret } from '../types';

const STORE_FILE = 'chatgpt-accounts.json';

function accessTokenKey(accountId: string): string {
  return `chatgpt-account:${accountId}:access-token`;
}

function refreshTokenKey(accountId: string): string {
  return `chatgpt-account:${accountId}:refresh-token`;
}

export class AccountStore {
  private filePath: string;

  constructor(basePath: string) {
    this.filePath = path.join(basePath, STORE_FILE);
  }

  async save(
    accounts: ChatGPTAccount[],
    secretStore: SecretStore
  ): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    for (const a of accounts) {
      await secretStore.store(
        accessTokenKey(a.id),
        createSecret(a.accessToken)
      );
      if (a.refreshToken) {
        await secretStore.store(
          refreshTokenKey(a.id),
          createSecret(a.refreshToken)
        );
      }
    }

    const storedKeys = await secretStore.list();
    const accountIds = new Set(accounts.map((a) => a.id));
    for (const key of storedKeys) {
      const match = key.match(
        /^chatgpt-account:(.+?):(?:access-token|refresh-token)$/
      );
      if (match && match[1] && !accountIds.has(match[1])) {
        await secretStore.delete(key);
      }
    }

    const metadata = accounts.map((a) => ({
      id: a.id,
      label: a.label,
      email: a.email,
      status: a.status,
      expiresAt: a.expiresAt,
      chatgptAccountId: a.chatgptAccountId,
      lastUsedAt: a.lastUsedAt,
      usageScore: a.usageScore,
      cooldownUntil: a.cooldownUntil,
      errorCount: a.errorCount,
      poolWeight: a.poolWeight,
    }));

    fs.writeFileSync(this.filePath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  async load(secretStore: SecretStore): Promise<ChatGPTAccount[]> {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const baseAccounts: ChatGPTAccount[] = data.filter(
        (a: any) => a.id && a.label
      );

      const restored = await Promise.all(
        baseAccounts.map(async (meta) => {
          const accessToken = await secretStore.load(accessTokenKey(meta.id));
          if (!accessToken) {
            return {
              ...meta,
              accessToken: '',
              refreshToken: undefined,
              status: 'error' as const,
            };
          }
          const refreshToken = await secretStore.load(refreshTokenKey(meta.id));
          return {
            ...meta,
            accessToken,
            refreshToken: refreshToken ?? undefined,
          };
        })
      );

      return restored;
    } catch {
      return [];
    }
  }
}
