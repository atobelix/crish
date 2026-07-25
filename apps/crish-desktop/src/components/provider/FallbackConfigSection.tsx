import React from "react";
import { AlertTriangle } from "lucide-react";
import type { FallbackConfig } from "../../store/provider/types";
import styles from "./ProviderDetail.module.css";

interface FallbackConfigSectionProps {
  fallback: FallbackConfig;
  expanded: boolean;
  onToggle: () => void;
}

export function FallbackConfigSection({ fallback, expanded, onToggle }: FallbackConfigSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <h3 className={styles.sectionTitle}>回退配置</h3>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
      </div>
      {expanded && (
        <div className={styles.sectionBody}>
          <div className={styles.formRow}>
            <label className={styles.label}>启用回退</label>
            <div className={`${styles.toggle} ${fallback.enabled ? styles.toggleOn : ''}`} />
          </div>
          {fallback.enabled && (
            <>
              {fallback.fallbackProviderId && (
                <div className={styles.formRow}>
                  <label className={styles.label}>回退 Provider</label>
                  <input className={styles.input} type="text" value={fallback.fallbackProviderId} readOnly />
                </div>
              )}
              {fallback.fallbackModels && fallback.fallbackModels.length > 0 && (
                <div className={styles.formRow}>
                  <label className={styles.label}>回退模型</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {fallback.fallbackModels.map(m => (
                      <div key={m} className={styles.chip}>{m}</div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {fallback.onTimeout && (
                  <span className={styles.chip}>
                    <AlertTriangle size={12} />超时回退
                  </span>
                )}
                {fallback.onRateLimit && (
                  <span className={styles.chip}>
                    <AlertTriangle size={12} />限流回退
                  </span>
                )}
                {fallback.onError && (
                  <span className={styles.chip}>
                    <AlertTriangle size={12} />错误回退
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
