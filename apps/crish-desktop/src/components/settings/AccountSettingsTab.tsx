import React from "react";
import { Plus, RefreshCw, ExternalLink, Loader2, AlertCircle, Copy, Timer } from "lucide-react";
import type { Account, AccountProvider } from "../../store/provider/types";
import { useProviderStore } from "../../store/provider/providerStore";
import {
  startOAuthFlow,
  generateAccountId,
  refreshChatGPTToken,
  cancelOAuthFlow,
  type AuthFlowState,
} from "../../api/providerAuth";
import { AccountCard } from "../accounts/AccountCard";
import { Tooltip } from "./SettingsUI";
import styles from "./AccountSettingsTab.module.css";

const CHECK_INTERVAL = 60000;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export function AccountSettingsTab() {
  const accounts = useProviderStore((s) => s.accounts);
  const addAccount = useProviderStore((s) => s.addAccount);
  const updateAccount = useProviderStore((s) => s.updateAccount);
  const removeAccount = useProviderStore((s) => s.removeAccount);
  const refreshAllAccounts = useProviderStore((s) => s.refreshAllAccounts);
  const [refreshing, setRefreshing] = React.useState(false);
  const [authFlow, setAuthFlow] = React.useState<AuthFlowState>({ stage: "idle" });
  const [manualCode, setManualCode] = React.useState("");
  const [exchangeError, setExchangeError] = React.useState("");

  const flowStartTime = (authFlow.stage === "opening-browser" || authFlow.stage === "exchanging-code") ? Date.now() : 0;

  const handleAddChatGPT = () => {
    setManualCode("");
    setExchangeError("");
    setAuthFlow({ stage: "preparing" });
    startOAuthFlow({ onStateChange: setAuthFlow }).then(result => {
      if (result) {
        const newAccount: Account = {
          id: result.accountId,
          provider: "chatgpt",
          label: result.label,
          authType: "oauth2",
          status: "active",
          isDefault: accounts.length === 0,
          lastUsedAt: new Date().toISOString(),
          poolWeight: 1,
        };
        addAccount(newAccount);
        cancelOAuthFlow();
        setAuthFlow({ stage: "idle" });
      }
    });
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await refreshAllAccounts();
    } finally {
      setRefreshing(false);
    }
  };

  const handleManualCodeSubmit = async () => {
    const trimmed = manualCode.trim();
    if (!trimmed || authFlow.stage !== "manual-input-needed") return;
    setExchangeError("");
    const result = await authFlow.exchangeCode(trimmed);
    if (result) {
      const newAccount: Account = {
        id: result.accountId,
        provider: "chatgpt",
        label: result.label,
        authType: "oauth2",
        status: "active",
        isDefault: accounts.length === 0,
        lastUsedAt: new Date().toISOString(),
        poolWeight: 1,
      };
      addAccount(newAccount);
      cancelOAuthFlow();
      setManualCode("");
      setAuthFlow({ stage: "idle" });
    }
  };

  const handleCancelFlow = () => {
    cancelOAuthFlow();
    setManualCode("");
    setExchangeError("");
    setAuthFlow({ stage: "idle" });
  };

  const handleCancelTimeout = () => {
    cancelOAuthFlow();
    setManualCode("");
    setExchangeError("");
    setAuthFlow({ stage: "idle" });
  };

  const handleRefreshToken = async (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!account || account.provider !== "chatgpt") return;
    const result = await refreshChatGPTToken(account);
    if (result) {
      const patch: Partial<Account> = {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        status: "active",
      };
      if (result.refreshToken) {
        patch.refreshToken = result.refreshToken;
      }
      updateAccount(id, patch);
    }
  };

  const handleRemove = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    const label = account.label || id;
    if (
      !window.confirm(
        `确定要移除账号 "${label}"？\n关联的 Token 将被清除，不可撤销。`,
      )
    ) {
      return;
    }
    removeAccount(id);
  };

  const [timeLeft, setTimeLeft] = React.useState(0);

  React.useEffect(() => {
    if (flowStartTime > 0 && authFlow.stage !== "idle" && authFlow.stage !== "success" && authFlow.stage !== "error" && authFlow.stage !== "timeout") {
      const tick = () => {
        const elapsed = Date.now() - flowStartTime;
        const remaining = Math.max(0, OAUTH_TIMEOUT_MS - elapsed);
        setTimeLeft(remaining);
        if (remaining > 0) requestAnimationFrame(tick);
      };
      const frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    setTimeLeft(0);
    return undefined;
  }, [flowStartTime, authFlow.stage]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const needsCheck = accounts.some(
        (a) =>
          (a.status === "active" && a.expiresAt != null && a.expiresAt - now < CHECK_INTERVAL * 2) ||
          (a.status === "cooling" && a.cooldownUntil != null && a.cooldownUntil - now < CHECK_INTERVAL * 2)
      );
      if (needsCheck) {
        refreshAllAccounts();
      }
    }, CHECK_INTERVAL);

    return () => clearInterval(timer);
  }, [accounts, refreshAllAccounts]);

  const isFlowActive = authFlow.stage !== "idle" && authFlow.stage !== "error" && authFlow.stage !== "success" && authFlow.stage !== "timeout";
  const isManualMode = authFlow.stage === "manual-input-needed";
  const isError = authFlow.stage === "error";

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const formatTimeLeft = (ms: number): string => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  };

  const chatgptAccounts = accounts.filter((a) => a.provider === "chatgpt");

  return (
    <div className={styles.accountSettingsTab}>
      <div className={styles.tabHeader}>
        <h2>账号中心</h2>
        <Tooltip content="刷新全部状态">
          <button
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={handleRefreshAll}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
          </button>
        </Tooltip>
      </div>

      <section className={styles.accountSection}>
        <div className={styles.sectionHeader}>
          <h3>ChatGPT Plus 账号池</h3>
          <button
            className="settings-btn-primary"
            onClick={handleAddChatGPT}
            disabled={isFlowActive}
          >
            {isFlowActive ? (
              <><Loader2 size={16} className={styles.spinner} /> 正在添加...</>
            ) : (
              <><Plus size={16} /> 添加账号</>
            )}
          </button>
        </div>
        <p className={styles.sectionDesc}>
          通过 OAuth 登录 ChatGPT Plus 账号，使用订阅附带的 Codex API 访问权限。
        </p>

        {authFlow.stage === "opening-browser" && (
          <div className={styles.flowIndicator}>
            <Loader2 size={18} className={styles.spinner} />
            <span>正在打开浏览器进行 OAuth 授权...</span>
          </div>
        )}

        {authFlow.stage === "waiting" && (
          <div className={styles.flowIndicator}>
            <Loader2 size={18} className={styles.spinner} />
            <span>等待授权完成，请在浏览器中登录并授权...</span>
          </div>
        )}

        {authFlow.stage === "exchanging-code" && (
          <div className={styles.flowIndicator}>
            <Loader2 size={18} className={styles.spinner} />
            <span>正在交换授权码获取 Token...</span>
          </div>
        )}

        {authFlow.stage === "timeout" && (
          <div className={styles.flowError}>
            <Timer size={16} />
            <span>OAuth 授权已超时（5 分钟），请重新尝试。</span>
            <button className="settings-btn-ghost" onClick={handleCancelTimeout}>关闭</button>
          </div>
        )}

        {isError && (
          <div className={styles.flowError}>
            <AlertCircle size={16} />
            <span>{authFlow.message}</span>
            <button className="settings-btn-ghost" onClick={handleCancelFlow}>关闭</button>
          </div>
        )}

        {isManualMode && (
          <div className={styles.manualFlowPanel}>
            <p className={styles.manualFlowHint}>
              无法自动打开浏览器。请手动复制以下链接在浏览器中打开并完成授权：
            </p>
            <div className={styles.urlRow}>
              <code className={styles.authUrl}>{authFlow.url}</code>
              <Tooltip content="复制链接">
                <button className="settings-btn-ghost" onClick={() => copyToClipboard(authFlow.url)}>
                  <Copy size={14} />
                </button>
              </Tooltip>
            </div>
            <p className={styles.manualFlowHint}>
              授权后浏览器地址栏会包含 <code>?code=...</code> 参数，请复制完整 code 值粘贴到下方输入框：
            </p>
            {exchangeError && (
              <div className={styles.errorBanner}>
                <AlertCircle size={14} />
                <span>{exchangeError}</span>
              </div>
            )}
            <div className={styles.codeInputRow}>
              <input
                type="text"
                className={styles.codeInput}
                placeholder="粘贴授权码 (code)..."
                value={manualCode}
                onChange={e => { setManualCode(e.target.value); setExchangeError(""); }}
                onKeyDown={e => e.key === "Enter" && handleManualCodeSubmit()}
              />
              <button className="settings-btn-primary" onClick={handleManualCodeSubmit} disabled={!manualCode.trim()}>
                交换 Token
              </button>
            </div>
            {timeLeft > 0 && (
              <span className={styles.manualFlowHint}>
                授权码将在 {formatTimeLeft(timeLeft)} 后过期
              </span>
            )}
            <button className="settings-btn-ghost" onClick={handleCancelFlow}>
              取消
            </button>
          </div>
        )}

        <div className={styles.accountList}>
          {chatgptAccounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onRemove={handleRemove}
              onRefreshToken={handleRefreshToken}
            />
          ))}
          {chatgptAccounts.length === 0 && !isFlowActive && !isManualMode && (
            <div className={styles.accountEmpty}>
              暂无 ChatGPT 账号。点击"添加账号"通过 OAuth 登录。
            </div>
          )}
        </div>
      </section>

      <section className={styles.accountSection}>
        <div className={styles.sectionHeader}>
          <h3>OAuth 连接</h3>
        </div>
        <div className={styles.oauthProviders}>
          {(["openrouter", "anthropic", "google"] as AccountProvider[]).map(provider => (
            <div key={provider} className={styles.oauthProviderCard}>
              <span className={styles.providerName}>{provider}</span>
              <button className="settings-btn-secondary" disabled>
                <ExternalLink size={14} /> 授权
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
