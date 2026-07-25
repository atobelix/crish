import React from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import type { Account } from "../../store/provider/types";
import { useProviderStore } from "../../store/provider/providerStore";
import { AccountStatusIndicator } from "./AccountStatusIndicator";
import { Tooltip } from "../Tooltip";
import styles from "./AccountCard.module.css";

interface AccountCardProps {
  account: Account;
  onRemove: (id: string) => void;
  onRefreshToken?: (id: string) => Promise<void>;
}

export function AccountCard({ account, onRemove, onRefreshToken }: AccountCardProps) {
  const refreshAccountStatus = useProviderStore((s) => s.refreshAccountStatus);
  const [refreshing, setRefreshing] = React.useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      if (onRefreshToken) {
        await onRefreshToken(account.id);
      }
      await refreshAccountStatus(account.id);
    } finally {
      setRefreshing(false);
    }
  };

  const avatarLetter = account.label.charAt(0);
  const providerInitial = account.provider.charAt(0).toUpperCase();

  return (
    <div className={styles.card}>
      <div className={styles.info}>
        <Tooltip content={account.provider}>
          <div className={styles.avatar}>
            {avatarLetter || providerInitial}
          </div>
        </Tooltip>
        <div className={styles.meta}>
          <span className={styles.label}>{account.label}</span>
          {account.email && <span className={styles.email}>{account.email}</span>}
          <AccountStatusIndicator
            status={account.status}
            expiresAt={account.expiresAt}
            cooldownUntil={account.cooldownUntil}
          />
        </div>
      </div>
      <div className={styles.actions}>
        {account.usageScore != null && (
          <Tooltip content="使用率">
            <span className={styles.usageScore}>
              {account.usageScore}%
            </span>
          </Tooltip>
        )}
        <Tooltip content="刷新状态">
          <button
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
          </button>
        </Tooltip>
        <Tooltip content="移除">
          <button
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => onRemove(account.id)}
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
