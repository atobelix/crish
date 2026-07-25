import React, { useState } from "react";
import { ProviderRail } from "../provider/ProviderRail";
import { ProviderDetail } from "../provider/ProviderDetail";
import type { ProviderConfig } from "../../store/provider/types";
import styles from "./ProviderSettingsTab.module.css";

export function ProviderSettingsTab() {
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  return (
    <div className={styles.container}>
      <div className={styles.rail}>
        <ProviderRail
          providers={providers}
          activeId={activeProviderId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={setActiveProviderId}
          onAdd={() => {}}
        />
      </div>

      <div className={styles.divider} />

      <div className={styles.detail}>
        {activeProviderId ? (
          <ProviderDetail providerId={activeProviderId} />
        ) : (
          <div className={styles.empty}>
            <p>选择一个 Provider 查看或编辑配置</p>
          </div>
        )}
      </div>
    </div>
  );
}
