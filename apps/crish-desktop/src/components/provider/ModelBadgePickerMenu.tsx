import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';

import { activateProfileModel } from '../../api/providerProfiles';
import {
  getLiveModel,
  listLivePickerEntries,
  listThinkingOptions,
  resolveThinkingHandoff,
} from '../../api/modelsCatalogLive';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { openSettings } from '../../api/storeAccess';
import { Menu, Tooltip } from '../ui';
import { getActiveProfileId } from '../../api/provider-profiles/profileActiveSelection';
import { profileHasConfiguredKey } from '../../api/providerProfiles';
import { useSessionStore } from '../../store/sessionStore';
import {
  getSessionThinkingTitle,
  setSessionThinkingTitle,
} from '../../api/SessionRuntimeRegistry';
import { groupLivePickerEntries } from './ModelBadgePickerMenu.data';

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
  const [, setThinkingEpoch] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const catalogVersion = useModelsCatalogVersion();
  const sessionId = useSessionStore((s) => s.activeSessionId);

  const providerId = getActiveProfileId() ?? '';
  const modelId = activeModel || '';

  // 只列「可用」供应商：yaml 带 apiKey 或凭据壳带 key（未配置的预置壳不占列表，
  // 避免选择器出现从未配置过的供应商导致切换 profile_not_found）
  // 只列「可用」供应商：yaml 带 apiKey 或凭据壳带 key（未配置的预置壳不占列表，
  // 避免选择后 activateProfileModel 报 profile_not_found）
  const entries = useMemo(
    () =>
      listLivePickerEntries().filter((e) => {
        const yamlKey = e.provider.apiKey;
        if (yamlKey && yamlKey.trim()) return true;
        return profileHasConfiguredKey(e.providerId);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogVersion],
  );

  const filteredGroups = useMemo(
    () => groupLivePickerEntries(entries, keyword),
    [entries, keyword],
  );

  const selectedSpec = useMemo(
    () => (providerId && modelId ? getLiveModel(providerId, modelId) : undefined),
    [providerId, modelId, catalogVersion],
  );

  const thinkingOptions = useMemo(
    () => (providerId && modelId ? listThinkingOptions(providerId, modelId) : []),
    [providerId, modelId, catalogVersion],
  );

  const selectedTitle = getSessionThinkingTitle(sessionId);
  const handoff = useMemo(
    () => resolveThinkingHandoff(providerId, modelId, selectedTitle),
    [providerId, modelId, selectedTitle, catalogVersion],
  );

  const showThinking = thinkingOptions.length > 0 && Boolean(selectedSpec);

  useEffect(() => {
    if (!sessionId || !providerId || !modelId || !selectedSpec) return;
    if (!handoff.supported) {
      if (selectedTitle != null) setSessionThinkingTitle(sessionId, null);
      return;
    }
    if (handoff.selectedTitle !== selectedTitle) {
      setSessionThinkingTitle(sessionId, handoff.selectedTitle);
    }
  }, [sessionId, providerId, modelId, selectedSpec, handoff, selectedTitle]);

  const handleSelectModel = useCallback(
    async (profileId: string, nextModelId: string) => {
      try {
        await activateProfileModel(profileId, nextModelId);
      } catch (err) {
        console.error('activateProfileModel failed:', err);
      }
      const nextOptions = listThinkingOptions(profileId, nextModelId);
      if (nextOptions.length === 0) {
        setSessionThinkingTitle(sessionId, null);
      } else if (
        selectedTitle &&
        !nextOptions.some((o) => o.title === selectedTitle)
      ) {
        setSessionThinkingTitle(sessionId, nextOptions[0]!.title);
      }
      onOpenChange?.(false);
      onClose();
    },
    [onOpenChange, onClose, sessionId, selectedTitle],
  );

  const handleSelectThinking = useCallback(
    (title: string) => {
      setSessionThinkingTitle(sessionId, title);
      setThinkingEpoch((n) => n + 1);
    },
    [sessionId],
  );

  const handleOpenSettings = useCallback(() => {
    openSettings('models');
    onOpenChange?.(false);
    onClose();
  }, [onOpenChange, onClose]);

  const currentThinkingDisplay = handoff.supported
    ? handoff.selectedTitle
    : '';

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

        {showThinking ? (
          <>
            <div className={styles.divider} />
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
                      <span className={styles.thinkingValue}>
                        {currentThinkingDisplay}
                      </span>
                    </div>
                    <div className={styles.thinkingTrack}>
                      {thinkingOptions.map((o) => {
                        const isActive =
                          handoff.supported &&
                          handoff.selectedTitle === o.title;
                        return (
                          <button
                            key={o.title}
                            type="button"
                            data-testid={`thinking-option-${o.title}`}
                            className={`${styles.thinkingPill} ${isActive ? styles.activePill : ''}`}
                            onClick={() => handleSelectThinking(o.title)}
                          >
                            {o.title}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </Menu>
  );
};
