import React from "react";
import { Search, Plus } from "lucide-react";
import type { ProviderConfig } from "../../store/provider/types";
import { Tooltip } from "../Tooltip";
import styles from "./ProviderRail.module.css";

interface ProviderRailProps {
  providers: ProviderConfig[];
  activeId: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export function ProviderRail({ providers, activeId, searchQuery, onSearchChange, onSelect, onAdd }: ProviderRailProps) {
  const filtered = providers.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className={styles.rail}>
      <div className={styles.header}>
        <div className={styles.searchBox}>
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索 Provider..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>
        <Tooltip content="添加 Provider">
          <button className={styles.addBtn} onClick={onAdd}>
            <Plus size={18} />
          </button>
        </Tooltip>
      </div>

      <div className={styles.list}>
        {filtered.map(p => (
          <div
            key={p.id}
            className={`${styles.item} ${p.id === activeId ? styles.active : ''} ${!p.enabled ? styles.disabled : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <div className={styles.iconWrap}>
              <span className={styles.initial}>{p.name[0].toUpperCase()}</span>
            </div>
            <div className={styles.info}>
              <div className={styles.name}>{p.name}</div>
              <div className={styles.meta}>
                {p.models?.length ?? 0} 个模型
                {p.healthStatus && (
                  <span className={`${styles.healthDot} ${styles[`health_${p.healthStatus.status}`]}`} />
                )}
              </div>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className={styles.empty}>未找到匹配的 Provider</div>
        )}
      </div>
    </div>
  );
}
