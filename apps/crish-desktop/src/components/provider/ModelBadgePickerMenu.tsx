import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';

import { activateProfileModel } from '../../api/providerProfiles';
import { useModelMetaTick } from '../../hooks/useModelMetaTick';
import {
  formatModelDisplayName,
  getModelMeta,
  listPickerProfiles,
} from '../../api/modelCatalog';
import { openSettings } from '../../api/storeAccess';
import { Menu, Tooltip } from '../ui';
import { useSettingsStore } from '../../store/settingsStore';
import {
  getAppSettings,
  setAppSettings,
} from '../../api/store-access/settingsAccess';
import { clientApi } from '../../api/clientApi';
import {
  THINKING_LEVEL_LABELS,
  thinkingLevelOptionsFor,
  resolveCatalogEfforts,
} from '../../api/thinkingGear';

export type Props = {
  activeModel?: string | null;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  side?: 'top' | 'bottom';
  /** 真实可见徽标，作 Radix Anchor；禁止再走 Popover.Trigger */
  anchor: React.RefObject<HTMLElement | null>;
};

export const ModelBadgePickerMenu: React.FC<Props> = ({
  activeModel,
  onClose,
  onOpenChange,
  open = true,
  side = 'top',
  anchor,
}) => {
  const [keyword, setKeyword] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const storedThinking = useSettingsStore(
    (s) => s.appSettings?.defaultThinkingLevel ?? 'default'
  );

  // 元数据变更信号：设置页开关切换后本面板即时重过滤
  const metaTick = useModelMetaTick();

  const profiles = useMemo(() => {
    return listPickerProfiles().filter((p) => p.enabled !== false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaTick 仅作重算信号
  }, [metaTick]);

  const filteredGroups = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const groups: {
      profileId: string;
      profileName: string;
      models: { id: string; name: string }[];
    }[] = [];

    for (const p of profiles) {
      const models = (p.models || [])
        .filter((m) => getModelMeta(p.id, m).enabled !== false)
        .map((m) => ({ id: m, name: formatModelDisplayName(p.id, m) }));

      if (!kw) {
        if (models.length > 0) {
          groups.push({
            profileId: p.id,
            profileName: p.name || p.id,
            models,
          });
        }
      } else {
        const matchesProfile = p.name.toLowerCase().includes(kw);
        const matchingModels = models.filter(
          (m) =>
            matchesProfile ||
            m.id.toLowerCase().includes(kw) ||
            m.name.toLowerCase().includes(kw)
        );
        if (matchingModels.length > 0) {
          groups.push({
            profileId: p.id,
            profileName: p.name || p.id,
            models: matchingModels,
          });
        }
      }
    }
    return groups;
  }, [profiles, keyword, metaTick]);

  const handleSelectModel = useCallback(
    async (profileId: string, modelId: string) => {
      try {
        await activateProfileModel(profileId, modelId);
      } catch (err) {
        console.error('activateProfileModel failed:', err);
      }
      onOpenChange?.(false);
      onClose();
    },
    [onOpenChange, onClose]
  );

  const handleSelectThinking = useCallback(async (value: string) => {
    const prev = getAppSettings();
    setAppSettings({
      ...(prev ?? {}),
      defaultThinkingLevel: value,
    });
    try {
      await clientApi.updateSettings({ defaultThinkingLevel: value });
    } catch {
      /* swallow-ok */
    }
  }, []);

  const handleOpenSettings = useCallback(() => {
    openSettings('models');
    onOpenChange?.(false);
    onClose();
  }, [onOpenChange, onClose]);

  const currentThinkingDisplay = useMemo(() => {
    // 档位标签单源 = thinkingGear（default → 『默认』），不在此硬编码文案
    if (!storedThinking || storedThinking === 'default') {
      return THINKING_LEVEL_LABELS['default'] ?? '默认';
    }
    return THINKING_LEVEL_LABELS[storedThinking] ?? storedThinking;
  }, [storedThinking]);

  if (!open) return null;

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          if (!nextOpen) {
            onOpenChange?.(false);
            onClose();
          }
        },
      }}
      anchor={anchor}
      position={{ side, align: 'end', sideOffset: 8 }}
      panel={{ contentClassName: styles.mbMenu }}
    >
      <div ref={panelRef} className={styles.mbInner} role="menu">
        <div className={styles.searchHeader}>
          <Lucide.Search size={14} className={styles.searchIcon} />
          <input
            ref={searchInputRef}
            type="text"
            className={styles.searchInput}
            placeholder="搜索模型或厂商..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <Tooltip content="模型管理...">
            <button
              type="button"
              className={styles.settingsBtn}
              aria-label="模型管理"
              onClick={handleOpenSettings}
            >
              <Lucide.SlidersHorizontal size={14} />
              <span style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', border: 0 }}>模型管理...</span>
            </button>
          </Tooltip>
        </div>

        <div className={styles.modelScrollArea}>
          {filteredGroups.length === 0 ? (
            <div className={styles.emptyState}>未找到匹配的模型或厂商</div>
          ) : (
            filteredGroups.map((group) => (
              <div
                key={group.profileId}
                className={styles.profileGroup}
                data-testid={`profile-item-${group.profileId}`}
              >
                <div className={styles.groupHeader}>{group.profileName}</div>
                {group.models.map((m) => {
                  const isSelected = m.id === activeModel;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitem"
                      data-testid={`model-option-${m.id}`}
                      className={`${styles.modelItem} ${isSelected ? styles.isSelected : ''}`}
                      onClick={() => handleSelectModel(group.profileId, m.id)}
                    >
                      <span className={styles.modelName}>{m.name || m.id}</span>
                      {isSelected ? (
                        <Lucide.Check size={14} className={styles.checkIcon} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className={styles.divider} />

        {/* 底部高级选项（折叠手风琴包含思考强度） */}
        <div className={styles.advancedSection}>
          <button
            type="button"
            className={styles.advancedTrigger}
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <span>高级选项</span>
            <Lucide.ChevronDown
              size={13}
              className={`${styles.advancedChevron} ${showAdvanced ? styles.rotated : ''}`}
            />
          </button>
          {showAdvanced ? (
            <div className={styles.advancedContent}>
              <div className={styles.thinkingSection}>
                <div className={styles.thinkingHeader}>
                  <span className={styles.thinkingTitle}>思考强度</span>
                  <span className={styles.thinkingValue}>{currentThinkingDisplay}</span>
                </div>
                {/* 档位单源 = thinkingGear（catalog 描述接口白名单 + 默认项）；
                    删除了 THINKING_PILLS 硬编码数组与 'High' 谎报（模型能力战役 v2） */}
                <div className={styles.thinkingTrack}>
                  {thinkingLevelOptionsFor(resolveCatalogEfforts(activeModel ?? '')).map(
                    (o) => {
                      const isActive =
                        storedThinking === o.value ||
                        (!storedThinking && o.isProviderDefault);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          className={`${styles.thinkingPill} ${isActive ? styles.activePill : ''}`}
                          onClick={() => handleSelectThinking(o.value)}
                        >
                          {o.label}
                        </button>
                      );
                    }
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Menu>
  );
};
