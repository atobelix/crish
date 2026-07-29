import React, { useState } from "react";
import { AuthConfigSection } from "./AuthConfigSection";
import { ModelListSection } from "./ModelListSection";
import { RateLimitConfig } from "./RateLimitConfig";
import { FallbackConfigSection } from "./FallbackConfigSection";
import type { ProviderConfig } from "../../store/provider/types";
import styles from "./ProviderDetail.module.css";

interface ProviderDetailProps {
  providerId: string;
}

export function ProviderDetail({ providerId }: ProviderDetailProps) {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true,
    auth: true,
    models: true,
    rateLimit: true,
    fallback: true,
  });

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // const provider = useProviderStore(s => s.providers.get(providerId));
  const provider = null as ProviderConfig | null;

  if (!provider) return <div className={styles.loading}>加载中...</div>;

  return (
    <div className={styles.detail}>
      <section className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => toggleSection('basic')}>
          <h3 className={styles.sectionTitle}>基本信息</h3>
          <span className={`${styles.chevron} ${expandedSections.basic ? styles.chevronOpen : ''}`} />
        </div>
        {expandedSections.basic && (
          <div className={styles.sectionBody}>
            <div className={styles.formRow}>
              <label className={styles.label}>名称</label>
              <input className={styles.input} type="text" value={provider.name} readOnly />
            </div>
            <div className={styles.formRow}>
              <label className={styles.label}>引擎类型</label>
              <select className={styles.select} value={provider.engineType} disabled>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="anthropic-native">Anthropic</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.label}>Base URL</label>
              <input className={styles.input} type="url" value={provider.baseUrl} readOnly />
            </div>
          </div>
        )}
      </section>

      <AuthConfigSection auth={provider.auth} expanded={expandedSections.auth ?? false} onToggle={() => toggleSection('auth')} />

      <ModelListSection models={provider.models} providerId={provider.id} expanded={expandedSections.models ?? false} onToggle={() => toggleSection('models')} />

      <RateLimitConfig rateLimit={provider.rateLimit} expanded={expandedSections.rateLimit ?? false} onToggle={() => toggleSection('rateLimit')} />

      <FallbackConfigSection fallback={provider.fallback} expanded={expandedSections.fallback ?? false} onToggle={() => toggleSection('fallback')} />
    </div>
  );
}
