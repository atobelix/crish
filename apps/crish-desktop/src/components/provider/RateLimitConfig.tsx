import React from "react";
import { Gauge } from "lucide-react";
import type { RateLimitConfig as RateLimitConfigType } from "../../store/provider/types";
import styles from "./ProviderDetail.module.css";

interface RateLimitConfigProps {
  rateLimit: RateLimitConfigType;
  expanded: boolean;
  onToggle: () => void;
}

export function RateLimitConfig({ rateLimit, expanded, onToggle }: RateLimitConfigProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <h3 className={styles.sectionTitle}>速率限制</h3>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
      </div>
      {expanded && (
        <div className={styles.sectionBody}>
          {rateLimit.maxRequestsPerMinute == null && rateLimit.maxTokensPerMinute == null ? (
            <span className={styles.subLabel}>未配置速率限制</span>
          ) : (
            <>
              {rateLimit.maxRequestsPerMinute != null && (
                <div className={styles.formRow}>
                  <label className={styles.label}>
                    <Gauge size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                    每分钟请求数 (RPM)
                  </label>
                  <input className={styles.input} type="number" value={rateLimit.maxRequestsPerMinute} readOnly />
                </div>
              )}
              {rateLimit.maxTokensPerMinute != null && (
                <div className={styles.formRow}>
                  <label className={styles.label}>
                    <Gauge size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                    每分钟 Token 数 (TPM)
                  </label>
                  <input className={styles.input} type="number" value={rateLimit.maxTokensPerMinute} readOnly />
                </div>
              )}
              {rateLimit.maxConcurrentRequests != null && (
                <div className={styles.formRow}>
                  <label className={styles.label}>最大并发请求数</label>
                  <input className={styles.input} type="number" value={rateLimit.maxConcurrentRequests} readOnly />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
