import React from "react";
import type { ProviderModel } from "../../store/provider/types";
import styles from "./ProviderDetail.module.css";

interface ModelListSectionProps {
  models: ProviderModel[];
  providerId: string;
  expanded: boolean;
  onToggle: () => void;
}

export function ModelListSection({ models, expanded, onToggle }: ModelListSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <h3 className={styles.sectionTitle}>模型列表（{models.length}）</h3>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
      </div>
      {expanded && (
        <div className={styles.sectionBody}>
          {models.length === 0 ? (
            <span className={styles.subLabel}>暂无模型</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {models.map(m => (
                <div key={m.id} className={styles.chip}>
                  <span>{m.name || m.id}</span>
                  {m.contextWindow && (
                    <span className={styles.badge}>{Math.round(m.contextWindow / 1000)}K</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
