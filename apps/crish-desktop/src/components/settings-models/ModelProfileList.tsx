/**
 * apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx
 *
 * 模型管理页面核心列表与级联选择组件（Task-C 级联菜单与 Portal 逃逸重构）：
 * 1. ModelsCascadeSelect: 全局默认模型级联选择器
 *    - 名单与展示名只读统一树镜像（listLivePickerEntries / getLiveProvider / getLiveModel）；
 *    - 触发器标签唯一判据 = 树 activeModel 的 (providerId, modelId) 在树中存在且启用；
 *    - 刷新订 useModelsCatalogVersion，不订 model-meta-changed；
 *    - 二级子菜单采用 createPortal 挂载逃逸，避免 Paint 阶段物理裁切；
 *    - 挂载 data-floating-layer="true" 与 role="listbox"，免疫 FocusTrap 冻结与 Tab 焦点拉回；
 *    - 向 LayerStack 注册 parentId: menuId，彻底根除 Outside Click 误杀闪退；
 *    - 修复安全三角向量叉积方向向左反转 180° Bug，实现动态方位同构；
 *    - 接入 FALLBACK_EMPTY_SELECTION 安全空态假体，杜绝全停用白屏。
 * 2. ModelProfileList: 左侧 AI 服务商导航轨栏，平滑展示启用/停用与密钥状态。
 *    名单只来自统一树 providers 面（listLiveProviders），启用状态读 provider.enabled，
 *    密钥状态读快照 credentialStates[providerId].hasKey；不读旧档案存储。
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
  listLiveProviders,
  providerHasKey,
} from '../../api/modelsCatalogLive';
import type { IndexedModelEntry } from '../../api/modelsCatalogTypes';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import styles from './ModelsSettingsTab.module.css';
import { Button, Tooltip, Menu } from '../ui';
import { MenuContext } from '../ui/Menu/Menu';
import { DialogOverlayContext } from '../ui/Dialog/dialogOverlayContext';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import { SafeTriangleTracker } from '../ui/internal/SafeTriangle';
import {
  calculateSubmenuPosition,
  type SubmenuPlacementResult,
} from '../ui/Menu/position';
import { AppIcon } from '../ui/icons/index';

/** 全局安全空态兜底契约（RED-04 防御） */
export const FALLBACK_EMPTY_SELECTION = {
  profileId: null,
  modelId: null,
  triggerLabel: '暂无已启用模型（请前往开启）',
  emptyMenuText: '暂无已启用的可用模型',
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
    let i = index.get(providerId);
    if (i === undefined) {
      i = groups.length;
      index.set(providerId, i);
      groups.push({
        id: providerId,
        name: provider.displayName || providerId,
        models: [],
      });
    }
    groups[i]!.models.push(model.id);
  }
  return groups;
}

// ============================================================================
// 子组件：CascadeSubmenuFlyout（Portal 逃逸与 LayerStack 拓扑锚定）
// ============================================================================

interface CascadeSubmenuFlyoutProps {
  profile: CascadeProviderGroup;
  placement: SubmenuPlacementResult;
  activeProfileId: string;
  activeModelId: string;
  flyoutRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (profileId: string, modelId: string) => void;
  onClose: () => void;
  onReach: () => void;
  onKeyDownOption?: (e: React.KeyboardEvent, modelId: string) => void;
}

const CascadeSubmenuFlyout: React.FC<CascadeSubmenuFlyoutProps> = ({
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
      data-floating-layer="true"          // 核心防线 2：FocusTrap 白名单，免疫 inert 物理冻结
      data-slot="cascade-submenu-content" // 语义槽位契约
      role="listbox"                      // 核心防线 3：免疫 Tab 键暴力拉回弹窗起点
      aria-label={`${cleanProfileName} 模型列表`}
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
        const selected = profile.id === activeProfileId && m === activeModelId;
        return (
          <Button
            bare
            key={m}
            type="button"
            role="option"
            aria-selected={selected}
            className={`${styles.cascadeOption} ${selected ? styles.isOn : ''}`}
            onClick={() => {
              onSelect(profile.id, m);
            }}
            onKeyDown={(e) => onKeyDownOption?.(e, m)}
          >
            <span className={styles.cascadeOptionText}>
              {liveModelLabel(profile.id, m)}
            </span>
            {selected && (
              <AppIcon name="check" size={14} className={styles.cascadeCheck} />
            )}
          </Button>
        );
      })}
    </div>,
    mountContainer
  );
};

// ============================================================================
// 主组件：ModelsCascadeSelect（全局默认模型级联选择器）
// ============================================================================

interface ModelsCascadeSelectProps {
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

export const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = ({
  activeProfileId,
  activeModelId,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const [flyoutPlacement, setFlyoutPlacement] = useState<SubmenuPlacementResult | null>(null);

  const safeTrackerRef = useRef(new SafeTriangleTracker(300));
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  const catalogVersion = useModelsCatalogVersion();

  const enabledProfiles = useMemo(
    () => groupLivePickerByProvider(listLivePickerEntries()),
    [catalogVersion]
  );

  const liveProvider = getLiveProvider(activeProfileId);
  const liveActiveModel = activeModelId
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
      : '请选择默认模型...';

  const closeSubmenu = useCallback(() => {
    safeTrackerRef.current.reset();
    setFlyProfileId(null);
    setFlyoutPlacement(null);
  }, []);

  const openSubmenu = useCallback((profileId: string) => {
    const rowEl = rowRefs.current.get(profileId);
    if (!rowEl) return;
    const rect = rowEl.getBoundingClientRect();
    // preferredSide 优先尝试 'right'，若空间不足自动翻转至 'left'
    const placement = calculateSubmenuPosition(rect, 200, 280, 4, 8, 'right');
    // 对坐标执行亚像素四舍五入，消除高 DPI 渲染模糊
    placement.x = Math.round(placement.x);
    placement.y = Math.round(placement.y);
    setFlyoutPlacement(placement);
    setFlyProfileId(profileId);
  }, []);

  const currentFlyProfile = useMemo(() => {
    return enabledProfiles.find((p) => p.id === flyProfileId) ?? null;
  }, [enabledProfiles, flyProfileId]);

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) closeSubmenu();
        },
      }}
      position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
      panel={{ contentClassName: styles.cascadeMenuContent }}
      trigger={
        <Button
          bare
          type="button"
          className={styles.cascadeSelectTrigger}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className={styles.cascadeSelectValue}>{activeLabel}</span>
          <AppIcon name="chevron-down" size={14}
            className={styles.cascadeChev} />
        </Button>
      }
    >
      <div
        className={styles.cascadeList}
        role="menu"
        onMouseLeave={() => {
          if (!safeTrackerRef.current.isGraceActive()) {
            closeSubmenu();
          }
        }}
      >
        <div className={styles.addMenuTitle}>选择服务商与模型</div>

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
                  <AppIcon name="chevron-left" size={14} className={styles.cascadeChev} />
                ) : (
                  <AppIcon name="chevron-right" size={14} className={styles.cascadeChev} />
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

// ============================================================================
// 关联组件：ModelProfileList（左侧 AI 服务商导航轨栏）
// ============================================================================

interface ModelProfileListProps {
  selectedId: string | null;
  onSelectProfile: (id: string) => void;
}

export const ModelProfileList: React.FC<ModelProfileListProps> = ({
  selectedId,
  onSelectProfile,
}) => {
  const catalogVersion = useModelsCatalogVersion();
  const providers = useMemo(() => listLiveProviders(), [catalogVersion]);

  return (
    <aside
      className={`${styles.modelsRail} models-rail`}
      aria-label="服务商列表"
    >
      <div className={`${styles.mrlHeader} mrl-header`}>
        <h3 className="settings-ui-section-title">AI 服务商</h3>
      </div>

      <div className={`${styles.mrlList} mrl-list`} role="list">
        {providers.length === 0 ? (
          <div className={`${styles.mrlEmpty} mrl-empty`}>还没有服务商</div>
        ) : (
          providers.map(({ providerId, provider }) => {
            const isActive = providerId === selectedId;
            const label = provider.displayName?.trim() || providerId;
            const keyOk = providerHasKey(providerId);
            const enabled = provider.enabled !== false;

            return (
              <Button
                bare
                key={providerId}
                type="button"
                role="listitem"
                className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelectProfile(providerId)}
              >
                <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
                  <Tooltip content={label}>
                    <span className={`${styles.mrlItemName} mrl-item-name`}>
                      {label}
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      !keyOk ? '缺少密钥' : !enabled ? '已停用' : '已配置并启用'
                    }
                  >
                    <span
                      className={`${styles.mrlItemDot} mrl-item-dot ${
                        !keyOk
                          ? styles.mrlItemDotNoKey
                          : !enabled
                            ? styles.mrlItemDotDisabled
                            : styles.mrlItemDotOn
                      }`}
                    />
                  </Tooltip>
                </div>
              </Button>
            );
          })
        )}
      </div>
    </aside>
  );
};
