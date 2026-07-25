import React from "react";
import type { Account } from "../../store/provider/types";
import styles from "./AccountStatusIndicator.module.css";

interface AccountStatusIndicatorProps {
  status: Account["status"];
  expiresAt?: number;
  cooldownUntil?: number;
  onClick?: () => void;
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec === 0) return "即将过期";
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }
  return `${min}m ${sec}s`;
}

function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }
  return `${min}m ${sec}s`;
}

const STATUS_LABELS: Record<Account["status"], string> = {
  active: "活跃",
  expired: "Token 已过期",
  error: "错误（点击重新授权）",
  cooling: "冷却中",
};

export function AccountStatusIndicator({ status, expiresAt, cooldownUntil, onClick }: AccountStatusIndicatorProps) {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    if (status !== "active" && status !== "cooling") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  const statusClass = styles[status] ?? styles.error;
  const label = STATUS_LABELS[status];

  let countdownText: string | null = null;
  if (status === "active" && expiresAt) {
    const remaining = expiresAt - now;
    if (remaining > 0) {
      countdownText = `（${formatCountdown(remaining)}）`;
    } else {
      countdownText = "（即将过期）";
    }
  }
  if (status === "cooling" && cooldownUntil) {
    const remaining = cooldownUntil - now;
    if (remaining > 0) {
      countdownText = `（剩余 ${formatRemaining(remaining)}）`;
    }
  }

  const handleClick = status === "error" && onClick ? onClick : undefined;

  return (
    <span
      className={`${styles.indicator} ${statusClass}`}
      onClick={handleClick}
      role={handleClick ? "button" : undefined}
      tabIndex={handleClick ? 0 : undefined}
      onKeyDown={handleClick ? (e) => { if (e.key === "Enter") handleClick(); } : undefined}
    >
      <span className={styles.dot} />
      <span>{label}</span>
      {countdownText && <span className={styles.countdown}>{countdownText}</span>}
    </span>
  );
}
