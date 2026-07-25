import React from "react";
import { Key } from "lucide-react";
import type { AuthConfig } from "../../store/provider/types";
import styles from "./ProviderDetail.module.css";

interface AuthConfigSectionProps {
  auth: AuthConfig;
  expanded: boolean;
  onToggle: () => void;
}

export function AuthConfigSection({ auth, expanded, onToggle }: AuthConfigSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader} onClick={onToggle}>
        <h3 className={styles.sectionTitle}>认证配置</h3>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
      </div>
      {expanded && (
        <div className={styles.sectionBody}>
          <div className={styles.formRow}>
            <label className={styles.label}>认证方式</label>
            <select className={styles.select} value={auth.type} disabled>
              <option value="api_key">API Key</option>
              <option value="oauth2">OAuth 2.0</option>
              <option value="none">无需认证</option>
            </select>
          </div>
          {auth.type === 'api_key' && (
            <div className={styles.formRow}>
              <label className={styles.label}>API Key</label>
              <div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Key size={14} />
                <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                  {auth.apiKey ? '••••••••' : '未设置'}
                </span>
              </div>
            </div>
          )}
          {auth.type === 'oauth2' && (
            <>
              <div className={styles.formRow}>
                <label className={styles.label}>Client ID</label>
                <input className={styles.input} type="text" value={auth.oauthClientId || ''} readOnly />
              </div>
              <div className={styles.formRow}>
                <label className={styles.label}>授权端点</label>
                <input className={styles.input} type="url" value={auth.oauthTokenUrl || ''} readOnly />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
