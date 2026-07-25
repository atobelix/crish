import { OAuthFlowManager } from "./oauth-flow";
import { CHATGPT_OAUTH_CONFIG } from "./pkce";
import type { AccountStore } from "./account-store";
import { type SecretStore } from "../secret-store";

export interface ChatGPTAccount {
  id: string;
  label: string;
  email?: string;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: number;
  chatgptAccountId?: string;
  status: "active" | "expired" | "error" | "cooling";
  lastUsedAt: number;
  usageScore: number;
  cooldownUntil?: number;
  errorCount: number;
  poolWeight: number;
}

export type AccountSelectionStrategy = "lowest-usage" | "round-robin" | "weighted-random";

export type AccountPoolChangeKind = "added" | "removed" | "refreshed" | "updated";
export type AccountPoolChangeCallback = (kind: AccountPoolChangeKind, accountId: string) => void;

export interface DaemonConfigUpdate {
  credentialMode?: string;
  accounts?: Array<{
    id: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    status: string;
  }>;
}

export type DaemonConfigUpdateCallback = (update: DaemonConfigUpdate) => void;

type RefreshResult = boolean;

export class ChatGPTAccountPool {
  private accounts: ChatGPTAccount[] = [];
  private strategy: AccountSelectionStrategy = "lowest-usage";
  private rrIndex = 0;
  private oauthFlow: OAuthFlowManager;
  private accountStore: AccountStore | undefined;
  private secretStore: SecretStore | undefined;
  private onChange: AccountPoolChangeCallback | undefined;
  private onDaemonConfigUpdate: DaemonConfigUpdateCallback | undefined;
  private refreshInflight: Map<string, Promise<RefreshResult>> = new Map();

  constructor(
    redirectUri: string,
    options?: { accountStore?: AccountStore; secretStore?: SecretStore; onChange?: AccountPoolChangeCallback },
  ) {
    this.oauthFlow = new OAuthFlowManager({
      clientId: CHATGPT_OAUTH_CONFIG.clientId,
      authorizeUrl: CHATGPT_OAUTH_CONFIG.authorizeUrl,
      tokenUrl: CHATGPT_OAUTH_CONFIG.tokenUrl,
      scopes: [...CHATGPT_OAUTH_CONFIG.scopes],
      redirectUri,
    });
    this.accountStore = options?.accountStore;
    this.secretStore = options?.secretStore;
    this.onChange = options?.onChange;
  }

  setOnChange(callback: AccountPoolChangeCallback | undefined): void {
    this.onChange = callback;
  }

  setDaemonConfigUpdateCallback(callback: DaemonConfigUpdateCallback | undefined): void {
    this.onDaemonConfigUpdate = callback;
  }

  private notifyDaemonConfigUpdate(): void {
    if (!this.onDaemonConfigUpdate) return;
    try {
      this.onDaemonConfigUpdate({
        credentialMode: "account-center",
        accounts: this.accounts.map(a => ({
          id: a.id,
          accessToken: a.accessToken,
          ...(a.refreshToken !== undefined ? { refreshToken: a.refreshToken } : {}),
          expiresAt: a.expiresAt,
          status: a.status,
        })),
      });
    } catch (err) {
      console.error("[ChatGPTAccountPool] Failed to notify daemon config update:", err);
    }
  }

  async addAccount(account: ChatGPTAccount): Promise<void> {
    this.accounts.push(account);
    await this.persist();
    this.onChange?.("added", account.id);
    this.notifyDaemonConfigUpdate();
  }

  async removeAccount(id: string): Promise<void> {
    this.accounts = this.accounts.filter(a => a.id !== id);
    await this.persist();
    this.onChange?.("removed", id);
    this.notifyDaemonConfigUpdate();
  }

  async updateAccount(id: string, updates: Partial<ChatGPTAccount>): Promise<void> {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) return;
    this.accounts[idx] = { ...this.accounts[idx], ...updates } as ChatGPTAccount;
    await this.persist();
    this.onChange?.("updated", id);
    this.notifyDaemonConfigUpdate();
  }

  getAccount(id: string): ChatGPTAccount | undefined {
    return this.accounts.find(a => a.id === id);
  }

  listAccounts(): ChatGPTAccount[] {
    return [...this.accounts];
  }

  selectAccount(): ChatGPTAccount | null {
    const eligible = this.accounts.filter(a =>
      a.status === "active" &&
      (!a.cooldownUntil || a.cooldownUntil < Date.now())
    );

    if (eligible.length === 0) return null;

    switch (this.strategy) {
      case "lowest-usage":
        return eligible.sort((a, b) => a.usageScore - b.usageScore)[0]!;
      case "round-robin":
        const account = eligible[this.rrIndex % eligible.length]!;
        this.rrIndex++;
        return account;
      case "weighted-random":
        const totalWeight = eligible.reduce((sum, a) => sum + a.poolWeight, 0);
        let random = Math.random() * totalWeight;
        for (const account of eligible) {
          random -= account.poolWeight;
          if (random <= 0) return account;
        }
        return eligible[0]!;
    }
  }

  recordUsage(accountId: string): void {
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.lastUsedAt = Date.now();
      account.usageScore = Math.min(100, account.usageScore + 5);
    }
  }

  recordFailure(accountId: string, errorType: "auth" | "quota" | "timeout" | "server"): void {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return;

    account.errorCount++;

    const cooldowns: Record<string, number> = {
      auth: 5 * 60 * 1000,
      quota: 60 * 60 * 1000,
      timeout: 30 * 1000,
      server: 60 * 1000,
    };

    account.cooldownUntil = Date.now() + (cooldowns[errorType] ?? 60000);

    if (errorType === "auth" && account.errorCount >= 3) {
      account.status = "error";
    }
  }

  async refreshAccount(accountId: string): Promise<RefreshResult> {
    const existing = this.refreshInflight.get(accountId);
    if (existing) return existing;

    const promise = this._doRefreshAccount(accountId);
    this.refreshInflight.set(accountId, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.refreshInflight.delete(accountId);
    }
  }

  private async _doRefreshAccount(accountId: string): Promise<RefreshResult> {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account || !account.refreshToken) return false;

    try {
      const response = await this.oauthFlow.refreshToken(account.refreshToken);
      account.accessToken = response.accessToken;
      account.refreshToken = response.refreshToken ?? account.refreshToken;
      account.expiresAt = Date.now() + response.expiresIn * 1000;
      account.status = "active";
      account.errorCount = 0;
      await this.persist();
      this.onChange?.("refreshed", accountId);
      this.notifyDaemonConfigUpdate();
      return true;
    } catch (err) {
      account.errorCount++;
      if (account.errorCount >= 3) {
        account.status = "error";
        this.notifyDaemonConfigUpdate();
      }
      return false;
    }
  }

  getAvailableCount(): number {
    return this.accounts.filter(a =>
      a.status === "active" &&
      (!a.cooldownUntil || a.cooldownUntil < Date.now())
    ).length;
  }

  getPoolStats(): PoolStats {
    const total = this.accounts.length;
    const active = this.accounts.filter(a => a.status === "active").length;
    const cooling = this.accounts.filter(a => a.status === "cooling").length;
    const error = this.accounts.filter(a => a.status === "error").length;
    const avgUsage = this.accounts.reduce((sum, a) => sum + a.usageScore, 0) / (total || 1);

    return { total, active, cooling, error, avgUsageScore: avgUsage };
  }

  private async persist(): Promise<void> {
    if (!this.accountStore || !this.secretStore) return;
    try {
      await this.accountStore.save(this.accounts, this.secretStore);
    } catch (err) {
      console.error("[ChatGPTAccountPool] Failed to persist accounts:", err);
    }
  }
}

export interface PoolStats {
  total: number;
  active: number;
  cooling: number;
  error: number;
  avgUsageScore: number;
}
