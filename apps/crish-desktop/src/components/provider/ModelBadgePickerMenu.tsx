import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './ModelBadgePickerMenu.module.css';

import { activateProfileModel } from '../../api/providerProfiles';
import {
  getLiveModel,
  listThinkingOptions,
  resolveThinkingHandoffSafe,
} from '../../api/modelsCatalogLive';
import { listAvailableModelPickerEntries } from '../../api/modelPickerAvailability';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { openSettings } from '../../api/storeAccess';
import { Menu, Tooltip, Button, Input } from '../ui';
import { getActiveProfileId } from '../../api/provider-profiles/profileActiveSelection';
import {
  setSessionThinkingTitle,
  resolveEffectiveThinkingTitle,
  persistThinkingSelection,
} from '../../api/SessionRuntimeRegistry';
import { groupLivePickerEntries } from './ModelBadgePickerMenu.data';
import { recordPendingContextState } from '../../api/provider-profiles/contextStatePending';
import { AppIcon } from '../ui/icons/index';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';

export type Props = {
  sessionId?: string | null;
  activeModel?: string | null;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  side?: 'top' | 'bottom';
  /** 真实可见徽标，作 Radix Anchor；禁止再走 Popover.Trigger */
  anchor: React.RefObject<HTMLElement | null>;
};

export const ModelBadgePickerMenu: React.FC<Props> = ({
  sessionId: sessionIdProp,
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
  const sessionId = useScopedSessionId(sessionIdProp);

  const providerId = getActiveProfileId() ?? '';
  const modelId = activeModel || '';

  // 只列「可用」供应商：镜像凭据状态带 key 或凭据壳带 key（未配置的预置壳不占列表，
  // 避免选择器出现从未配置过的供应商导致切换 profile_not_found）
  const entries = useMemo(
    () => listAvailableModelPickerEntries(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogVersion]
  );

  const filteredGroups = useMemo(
    () => groupLivePickerEntries(entries, keyword),
    [entries, keyword]
  );

  const selectedSpec = useMemo(
    () =>
      providerId && modelId ? getLiveModel(providerId, modelId) : undefined,
    [providerId, modelId, catalogVersion]
  );

  const thinkingOptions = useMemo(
    () =>
      providerId && modelId ? listThinkingOptions(providerId, modelId) : [],
    [providerId, modelId, catalogVersion]
  );

  // 统一从 SSOT 中枢读取有效思考档位（用户设置优先，跨会话保留）
  const selectedTitle = resolveEffectiveThinkingTitle(
    sessionId,
    providerId,
    modelId
  );
  const handoff = useMemo(() => {
    return resolveThinkingHandoffSafe(providerId, modelId, selectedTitle);
  }, [providerId, modelId, selectedTitle, catalogVersion]);

  const showThinking = thinkingOptions.length > 0 && Boolean(selectedSpec);

  // 仅在当前模型物理不支持思考时，清理会话临时覆盖，杜绝反向覆写有效用户偏好
  useEffect(() => {
    if (!sessionId || !providerId || !modelId || !selectedSpec) return;
    if (!handoff.supported && selectedTitle != null) {
      setSessionThinkingTitle(sessionId, null);
    }
  }, [
    sessionId,
    providerId,
    modelId,
    selectedSpec,
    handoff.supported,
    selectedTitle,
  ]);

  const handleSelectModel = useCallback(
    async (profileId: string, nextModelId: string) => {
      // 跨模型切换时：优先加载目标模型专属偏好；若无则平移继承用户当前选中的档位。
      // 目标模型未声明该档位 → 视为未选（不持久化、不降级），由 UI 引导重选。
      const targetTitle = resolveEffectiveThinkingTitle(
        sessionId,
        profileId,
        nextModelId
      );
      const nextHandoff = resolveThinkingHandoffSafe(
        profileId,
        nextModelId,
        targetTitle
      );
      if (nextHandoff.supported && nextHandoff.selectedTitle != null) {
        persistThinkingSelection(
          sessionId,
          profileId,
          nextModelId,
          nextHandoff.selectedTitle
        );
      } else if (!nextHandoff.supported) {
        setSessionThinkingTitle(sessionId, null);
      }

      try {
        await activateProfileModel(profileId, nextModelId);
      } catch (err) {
        console.error('activateProfileModel failed:', err);
      }

      // 仅记录待发送快照，绝不提前向对话流注入卡片（发送按钮触发时才带上）
      recordPendingContextState(sessionId);
      onOpenChange?.(false);
      onClose();
    },
    [onOpenChange, onClose, sessionId]
  );

  const handleSelectThinking = useCallback(
    (title: string) => {
      persistThinkingSelection(sessionId, providerId, modelId, title);
      setThinkingEpoch((n) => n + 1);
      // 仅记录待发送快照，绝不提前向对话流注入卡片（发送按钮触发时才带上）
      recordPendingContextState(sessionId);
    },
    [sessionId, providerId, modelId]
  );

  const handleOpenSettings = useCallback(() => {
    openSettings('models');
    onOpenChange?.(false);
    onClose();
  }, [onOpenChange, onClose]);

  // 生效档位：命中当前模型 thinking 声明才显示；未选 / 未命中 → 引导重选（不降级）。
  const currentThinkingDisplay = handoff.selectedTitle ?? '';
  const thinkingDisplayText = currentThinkingDisplay || '请选择思考档位';

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
          <AppIcon name="search" size={14} className={styles.searchIcon} />
          <Input
            bare
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
            <Button
              type="button"
              variant="ghost"
              className={styles.settingsBtn}
              aria-label="模型管理"
              onClick={handleOpenSettings}
            >
              <AppIcon name="sliders" size={14} />
              <span
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0,0,0,0)',
                  border: 0,
                }}
              >
                模型管理...
              </span>
            </Button>
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
                    <Button
                      key={m.id}
                      type="button"
                      variant="ghost"
                      role="menuitem"
                      data-testid={`model-option-${m.id}`}
                      className={`${styles.modelItem} ${isSelected ? styles.isSelected : ''}`}
                      onClick={() => handleSelectModel(group.profileId, m.id)}
                    >
                      <span className={styles.modelName}>{m.name || m.id}</span>
                      {isSelected ? (
                        <AppIcon
                          name="check"
                          size={14}
                          className={styles.checkIcon}
                        />
                      ) : null}
                    </Button>
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
              <Button
                type="button"
                variant="ghost"
                className={styles.advancedTrigger}
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <span>高级选项</span>
                <AppIcon
                  name="chevron-down"
                  size={13}
                  className={`${styles.advancedChevron} ${showAdvanced ? styles.rotated : ''}`}
                />
              </Button>
              {showAdvanced ? (
                <div className={styles.advancedContent}>
                  <div className={styles.thinkingSection}>
                    <div className={styles.thinkingHeader}>
                      <span className={styles.thinkingTitle}>思考强度</span>
                      <span
                        className={styles.thinkingValue}
                        data-testid="thinking-value"
                      >
                        {thinkingDisplayText}
                      </span>
                    </div>
                    <div className={styles.thinkingTrack}>
                      {thinkingOptions.map((o) => {
                        const isActive =
                          handoff.supported &&
                          handoff.selectedTitle === o.title;
                        return (
                          <Button
                            key={o.title}
                            type="button"
                            variant="ghost"
                            data-testid={`thinking-option-${o.title}`}
                            data-active={isActive ? 'true' : 'false'}
                            className={`${styles.thinkingPill} ${isActive ? styles.activePill : ''}`}
                            onClick={() => handleSelectThinking(o.title)}
                          >
                            {o.label}
                          </Button>
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
