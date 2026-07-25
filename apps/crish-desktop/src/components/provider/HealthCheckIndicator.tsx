import React from "react";
import type { ProviderHealth } from "../../store/provider/types";
import styles from "./HealthCheckIndicator.module.css";

interface HealthCheckIndicatorProps {
  health: ProviderHealth;
}

const STATUS_LABELS: Record<ProviderHealth["status"], string> = {
  healthy: "健康",
  degraded: "降级",
  down: "不可用",
  unknown: "未知",
  ok: "健康",
  error: "异常",
};

export function HealthCheckIndicator({ health }: HealthCheckIndicatorProps) {
  const statusClass = styles[health.status] ?? styles.unknown;

  const formatLatency = (ms?: number) => {
    if (ms == null) return null;
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTime = (ts?: number) => {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <span className={`${styles.indicator} ${statusClass}`}>
      <span className={styles.dot} />
      <span>{STATUS_LABELS[health.status]}</span>
      {health.latencyMs != null && (
        <span className={styles.latency}>{formatLatency(health.latencyMs)}</span>
      )}
      {health.lastCheckedAt != null && (
        <span className={styles.lastChecked}>{formatTime(health.lastCheckedAt)}</span>
      )}
    </span>
  );
}
