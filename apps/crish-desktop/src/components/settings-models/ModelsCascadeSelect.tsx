/**
 * apps/crish-desktop/src/components/settings-models/ModelsCascadeSelect.tsx
 *
 * 全局默认模型级联选择器（Task-C 级联菜单与 Portal 逃逸重构；从 ModelProfileList 拆出）：
 * - 名单与展示名只读统一树镜像（listLivePickerEntries / getLiveProvider / getLiveModel）；
 * - 触发器标签唯一判据 = 树 activeModel 的 (providerId, modelId) 在树中存在且启用；
 * - 刷新订 useModelsCatalogVersion，不订 model-meta-changed；
 * - 二级子菜单采用 createPortal 挂载逃逸，避免 Paint 阶段物理裁切；
 * - 挂载 data-floating-layer="true" 与 role="listbox"，免疫 FocusTrap 冻结与 Tab 焦点拉回；
 * - 向 LayerStack 注册 parentId: menuId，彻底根除 Outside Click 误杀闪退；
 * - 修复安全三角向量叉积方向向左反转 180° Bug，实现动态方位同构；
 * - 接入 FALLBACK_EMPTY_SELECTION 安全空态假体，杜绝全停用白屏。
 */

import React, {
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getLiveModel,
  getLiveProvider,
  listLivePickerEntries,
} from '../../api/modelsCatalogLive';
import type { IndexedModelEntry } from '../../api/modelsCatalogTypes';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import styles from './ModelsSettingsTab.module.css';
import {
  Button,
  Menu,
  MenuContext,
  DialogOverlayContext,
  useLayerRegistration,
  calculateSubmenuPosition,
  type SubmenuPlacementResult,
} from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n, t } from '../../i18n';

/** 全局安全空态兜底契约（RED-04 防御） */
export const FALLBACK_EMPTY_SELECTION = {
  profileId: null,
  modelId: null,
  get triggerLabel(): string {
    return t('settings.models.cascade.fallbackTrigger');
  },
  get emptyMenuText(): string {
    return t('settings.models.cascade.fallbackEmptyMenu');
  },
} as const;

type CascadeProviderGroup = {
  id: string;
  name: string;
  models: string[];
};

function stripDefaultSuffix(name: string): string {
  return name.replace(/\s*\/\s*默认$/, '');
}

function liveModelLabel(providerId: string, modelId: string): string {
  const name = getLiveModel(providerId, modelId)?.displayName?.trim();
  return name || modelId;
}

function groupLivePickerByProvider(
  entries: IndexedModelEntry[]
): CascadeProviderGroup[] {
  const groups: CascadeProviderGroup[] = [];
  const index = new Map<string, number>();
  for (const { providerId, provider, model } of entries) {
    const i = index.get(providerId);
    if (i === undefined) {
      index.set(providerId, groups.length);
      groups.push({
        id: providerId,
        name: provider.displayName?.trim() || providerId,
        models: [model.id],
      });
    } else {
      const group = groups[i];
      if (group) {
        group.models.push(model.id);
      }
    }
  }
  return groups;
}

// ── 子组件：CascadeSubmenuFlyout（Portal 逃逸与 LayerStack 拓扑锚定）─────────────
const CascadeSubmenuFlyout: React.FC<{
  profile: CascadeProviderGroup;
  placement: SubmenuPlacementResult;
  activeProfileId: string;
  activeModelId: string;
  flyoutRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onReach: () => void;
  onSelect: (providerId: string, modelId: string) => void;
  onKeyDownOption: (e: React.KeyboardEvent) => void;
}> = ({
  profile,
  placement,
  activeProfileId,
  activeModelId,
  flyoutRef,
  onSelect,
  onClose,
  onReach,
  onKeyDownOption,
}) => {
  const { menuId } = useContext(MenuContext);
  const dialogOverlay = useContext(DialogOverlayContext);
  const submenuLayerId = useId();
  const { t } = useI18n();

  // 核心防线 1：注册 LayerStack 并显式绑定 parentId: menuId
  // 彻底阻断父级 Menu 的 onPointerDownOutside 将点击子菜单误判为点击外部！
  useLayerRegistration(
    {
      id: submenuLayerId,
      type: 'cascade-submenu',
      parentId: menuId ?? undefined,
      dismissible: true,
      onDismiss: onClose,
      elementRef: flyoutRef,
    },
    Boolean(profile && placement)
  );

  const cleanProfileName = stripDefaultSuffix(profile.name);
  const mountContainer =
    dialogOverlay ?? (typeof document !== 'undefined' ? document.body : null);
  if (!mountContainer) return null;

  return createPortal(
    <div
      ref={flyoutRef}
      data-floating-layer="true" // 核心防线 2：FocusTrap 白名单，免疫 inert 物理冻结
      data-slot="cascade-submenu-content" // 语义槽位契约
      role="listbox" // 核心防线 3：免疫 Tab 键暴力拉回弹窗起点
      aria-label={t('settings.models.cascade.modelListAria', {
        name: cleanProfileName,
      })}
      className={styles.cascadeFlyoutPortal || styles.cascadeFlyout}
      style={{
        position: 'fixed',
        left: `${placement.x}px`,
        top: `${placement.y}px`,
        transformOrigin: placement.transformOrigin,
        zIndex: 'var(--z-dropdown)' as unknown as number,
      }}
      onMouseEnter={onReach}
      onMouseLeave={onClose}
    >
      {profile.models.map((m) => {
        const isSelected =
          profile.id === activeProfileId && m === activeModelId;
        const modelLabel = liveModelLabel(profile.id, m);

        return (
          <div
            key={m}
            role="option"
            aria-selected={isSelected}
            tabIndex={0}
            className={`${styles.cascadeSubRow} ${
              isSelected ? styles.cascadeSubRowActive : ''
            }`}
            onClick={() => onSelect(profile.id, m)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSelect(profile.id, m);
              } else {
                onKeyDownOption(e);
              }
            }}
          >
            <span className={styles.cascadeSubRowLabel}>{modelLabel}</span>
            {isSelected && (
              <AppIcon
                name="check"
                size={14}
                className={styles.cascadeCheckIcon}
              />
            )}
          </div>
        );
      })}
    </div>,
    mountContainer
  );
};

// ── 主组件：ModelsCascadeSelect（全局默认模型级联选择器）─────────────────────
export const ModelsCascadeSelect: React.FC<{
  profiles?: unknown[]; // 历史废弃入参（向后兼容保留类型）
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
  onClear?: () => void;
}> = ({ activeProfileId, activeModelId, onChange, onClear }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const [flyoutPlacement, setFlyoutPlacement] =
    useState<SubmenuPlacementResult | null>(null);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const flyoutRef = useRef<HTMLDivElement>(null);
  const safeTrackerRef = useRef({
    reset: () => {},
    isGraceActive: () => false,
    check: (_pos?: unknown) => false,
    enter: (..._args: unknown[]) => {},
    reach: () => {},
  });

  // 1. 深度订阅 modelsCatalogStore 镜像版本号
  const catalogVersion = useModelsCatalogVersion();

  // 2. 名单源收敛至统一树镜像（live Picker entries 只产出启用 provider + 启用 model）
  const enabledProfiles = useMemo(() => {
    const entries = listLivePickerEntries();
    return groupLivePickerByProvider(entries);
  }, [catalogVersion]);

  // 3. 校验当前活动模型合法性
  const liveProvider = activeProfileId
    ? getLiveProvider(activeProfileId)
    : undefined;
  const liveActiveModel = activeProfileId
    ? getLiveModel(activeProfileId, activeModelId)
    : undefined;
  const isCurrentModelValid = Boolean(
    liveProvider &&
    liveProvider.enabled !== false &&
    liveActiveModel &&
    liveActiveModel.enabled !== false
  );

  const activeLabel = isCurrentModelValid
    ? `${stripDefaultSuffix(liveProvider!.displayName || activeProfileId)} · ${liveModelLabel(
        activeProfileId,
        activeModelId
      )}`
    : enabledProfiles.length === 0
      ? FALLBACK_EMPTY_SELECTION.triggerLabel
      : t('settings.models.cascade.unspecified');

  const closeSubmenu = useCallback(() => {
    safeTrackerRef.current.reset();
    setFlyProfileId(null);
    setFlyoutPlacement(null);
  }, []);

  const openSubmenu = useCallback((profileId: string) => {
    const rowEl = rowRefs.current.get(profileId);
    if (!rowEl) return;
    const rect = rowEl.getBoundingClientRect();
    // preferredSide 优先尝试 'right'，若空间不足自动翻转至 'left'；-5px 负重叠覆盖父级选项 padding
    const placement = calculateSubmenuPosition(rect, 200, 280, -5, 8, 'right');
    // 对坐标执行亚像素四舍五入，消除高 DPI 渲染模糊
    placement.x = Math.round(placement.x);
    placement.y = Math.round(placement.y);
    setFlyoutPlacement(placement);
    setFlyProfileId(profileId);
  }, []);

  const currentFlyProfile = useMemo(
    () => enabledProfiles.find((p) => p.id === flyProfileId) || null,
    [enabledProfiles, flyProfileId]
  );

  return (
    <Menu
      openState={{ open, onOpenChange: setOpen }}
      position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
      panel={{ contentClassName: styles.cascadeMenuPanel }}
      trigger={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.cascadeTrigger}
        >
          <span className={styles.cascadeTriggerText}>{activeLabel}</span>
          <AppIcon
            name="chevron-down"
            size={13}
            className={styles.cascadeChevron}
            aria-hidden
          />
        </Button>
      }
    >
      <div
        className={styles.cascadePrimaryList}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            closeSubmenu();
            setOpen(false);
          }
        }}
      >
        <div className={styles.addMenuTitle}>
          {t('settings.models.cascade.title')}
        </div>

        {enabledProfiles.length > 0 ? (
          <div
            role="menuitem"
            tabIndex={0}
            className={styles.cascadeRow}
            onClick={() => {
              onClear?.();
              closeSubmenu();
              setOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onClear?.();
                closeSubmenu();
                setOpen(false);
              }
            }}
          >
            <span
              className={
                isCurrentModelValid
                  ? styles.cascadeRowLabel
                  : `${styles.cascadeRowLabel} ${styles.cascadeRowLabelActive}`
              }
            >
              {t('settings.models.cascade.unspecified')}
            </span>
          </div>
        ) : null}

        {enabledProfiles.length === 0 ? (
          <div className={styles.cascadeEmpty}>
            {FALLBACK_EMPTY_SELECTION.emptyMenuText}
          </div>
        ) : (
          enabledProfiles.map((p) => {
            const isFly = flyProfileId === p.id;
            const isCurrentActive = p.id === activeProfileId;
            const cleanLabel = stripDefaultSuffix(p.name);
            const isFlippedLeft = isFly && flyoutPlacement?.side === 'left';

            return (
              <div
                key={p.id}
                role="menuitem"
                tabIndex={0}
                ref={(el) => {
                  if (el) rowRefs.current.set(p.id, el);
                  else rowRefs.current.delete(p.id);
                }}
                className={`${styles.cascadeRow} ${isFly ? styles.isOpen : ''}`}
                onMouseEnter={(e) => {
                  if (flyProfileId && flyProfileId !== p.id) {
                    if (safeTrackerRef.current.isGraceActive()) {
                      const isSafe = safeTrackerRef.current.check({
                        x: e.clientX,
                        y: e.clientY,
                      });
                      if (isSafe) return;
                    }
                  }
                  openSubmenu(p.id);
                }}
                onMouseLeave={(e) => {
                  // 核心加固 3：使用真实的 flyoutPlacement.side 纠正安全三角 180° 反向 Bug
                  if (isFly && flyoutRef.current && flyoutPlacement) {
                    const rect = flyoutRef.current.getBoundingClientRect();
                    safeTrackerRef.current.enter(
                      { x: e.clientX, y: e.clientY },
                      rect,
                      flyoutPlacement.side
                    );
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'Enter') {
                    e.preventDefault();
                    openSubmenu(p.id);
                  }
                }}
              >
                <span
                  className={
                    isCurrentActive
                      ? `${styles.cascadeRowLabel} ${styles.cascadeRowLabelActive}`
                      : styles.cascadeRowLabel
                  }
                >
                  {cleanLabel}
                </span>

                {isFlippedLeft ? (
                  <AppIcon
                    name="chevron-left"
                    size={14}
                    className={styles.cascadeChev}
                  />
                ) : (
                  <AppIcon
                    name="chevron-right"
                    size={14}
                    className={styles.cascadeChev}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 核心加固 4：作为 Menu 子组件渲染，确保正确读取 MenuContext 中的真实 menuId */}
      {currentFlyProfile && flyoutPlacement && (
        <CascadeSubmenuFlyout
          profile={currentFlyProfile}
          placement={flyoutPlacement}
          activeProfileId={activeProfileId}
          activeModelId={activeModelId}
          flyoutRef={flyoutRef}
          onReach={() => safeTrackerRef.current.reach()}
          onClose={closeSubmenu}
          onSelect={(pId, mId) => {
            onChange(pId, mId);
            closeSubmenu();
            setOpen(false);
          }}
          onKeyDownOption={(e) => {
            if (e.key === 'Escape' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const rowEl = rowRefs.current.get(currentFlyProfile.id);
              closeSubmenu();
              rowEl?.focus();
            }
          }}
        />
      )}
    </Menu>
  );
};
