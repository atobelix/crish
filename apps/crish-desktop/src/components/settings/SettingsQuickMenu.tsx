/**
 * 侧栏「设置」快捷菜单：身份行（头像 + 退出登录）+ 主题子面板 + 常用入口 + 检查更新；
 * 不进全屏设置。
 * （T05.3.2 迁移到 ui/Menu 基座：position/portal 由基座接管，
 * 保留 roving 键盘增强与「Esc/Tab 关闭并还原焦点」语义。）
 *
 * 键盘：↑↓ / Home / End 漫游（本组件保留，含退出登录钮）；Esc / Tab 关闭并还原焦点到触发钮。
 * 主题走 ui/Menu 基座子菜单（SubmenuTrigger + RadioGroup/RadioItem，Portal 免裁剪）。
 * 选中主题后菜单保持打开（用户 2026-11-02 裁决：方便来回切换对比，为特性非缺陷；
 * RadioItem 刻意不设 closeOnClick，勿按「选中即关」方向修改）；
 * 子菜单内的按键归基座自管，本组件漫游不拦截。
 * 入口项 SettingsTabType 字面量，避免 string 漂移。文案全部走 settings.quickMenu.* 词典。
 * 焦点语义：外点关闭不抢焦点（onInteractOutside 置位），
 * Esc/Tab 关闭时还原焦点（restoreOnCloseRef 置位）。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { openSettings, useAuthField } from '../../store/storeAccess';
import { getAppSettings, setAppSettings } from '../../store/settingsAccess';
import { clientApi } from '../../api/clientApi';
import type { SettingsTabType } from '../../store/types';
import { readStoredTheme, setTheme, type UiTheme } from '../../api/themeStore';
import styles from './SettingsQuickMenu.module.css';
import { Button, Menu, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import { useSettingsDomain } from '../../i18n/settingsDomain';
import { useToast } from '../../services/toast/ToastContext';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from '../account/accountIdentity';
import { SignOutConfirmDialog } from '../account/SignOutConfirmDialog';

export interface SettingsQuickMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  trigger?: React.ReactNode;
  renderTrigger?: (params: {
    open: boolean;
    triggerProps: {
      ref?: React.RefObject<HTMLButtonElement | null>;
      'aria-haspopup': 'menu';
      'aria-expanded': boolean;
      'aria-controls'?: string;
      onClick?: () => void;
    };
  }) => React.ReactNode;
}

export type Props = SettingsQuickMenuProps;

/** 可聚焦控件：菜单项（含主题子菜单行）+ 退出登录钮（不含禁用） */
const FOCUSABLE_SEL =
  '.sb-quick-item:not(:disabled):not([aria-disabled="true"]), button.sb-quick-signout:not(:disabled)';

function listFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
}

/** 快捷入口：文案走词典；tab 仅 SettingsTabType 或 undefined（设置默认页） */
type QuickEntry = {
  id: string;
  label: string;
  title: string;
  ariaLabel: string;
  icon: React.ReactNode;
  tab?: SettingsTabType;
};

export const SettingsQuickMenu: React.FC<SettingsQuickMenuProps> = ({
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  anchorRef,
  trigger,
  renderTrigger,
}) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = externalOpen !== undefined;
  const open = isControlled ? externalOpen : internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      externalOnOpenChange?.(next);
    },
    [isControlled, externalOnOpenChange]
  );
  const { t, language } = useI18n();
  const { showToast } = useToast();
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const accountLabel = isLoggedIn
    ? user?.name ||
      user?.email?.split('@')[0] ||
      t('settings.account.quick.myAccount')
    : t('settings.account.quick.signIn');
  const accountTip = isLoggedIn
    ? t('settings.account.quick.manageTip')
    : t('settings.account.quick.signInTip');
  // 身份行展示（与侧栏卡片同一套 accountIdentity 推导，含头像失败回落首字母）
  const displayName =
    accountDisplayName(user, profile) || t('settings.account.quick.myAccount');
  const accountInitialText = accountInitial(displayName);
  const avatarUrl = resolveAvatarUrl(profile?.avatarUrl);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showAvatarImage = avatarUrl !== null && avatarUrl !== failedAvatar;
  const [signOutOpen, setSignOutOpen] = useState(false);
  // 退出确认弹窗的文案在设置域词典（懒加载）：弹窗打开时按需加载，
  // 与 AccountCenterDialog 同款入口范式；常驻的退出钮文案走核心 quickMenu.signOut。
  useSettingsDomain(language, signOutOpen);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [theme, setThemeState] = useState<UiTheme>(() => readStoredTheme());
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Escape / Tab / 键盘激活关闭时还原触发钮焦点；外侧点击不抢焦点 */
  const restoreOnCloseRef = useRef(false);
  /** 侧栏尺寸变化时重挂基座锚点（基座自动重新定位） */
  const [anchorTick, setAnchorTick] = useState(0);

  // 监听全局主题变更事件，确保子面板高亮与真实生效主题 100% 保持一致
  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme?: UiTheme }>;
      if (customEvt?.detail?.theme) {
        setThemeState(customEvt.detail.theme);
      } else {
        setThemeState(readStoredTheme());
      }
    };
    window.addEventListener('crish-theme-changed', handleThemeChange);
    return () => {
      window.removeEventListener('crish-theme-changed', handleThemeChange);
    };
  }, []);

  // 当菜单展开时，立即对齐一次当前 DOM 与 Storage 的真实主题
  useEffect(() => {
    if (open) {
      setThemeState(readStoredTheme());
    }
  }, [open]);
  const menuId = useId();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      // 按关闭来源决定是否还原焦点（Esc/Tab/选中 → 还原；外点/触发器 → 不抢）
      const shouldRestore = restoreOnCloseRef.current;
      restoreOnCloseRef.current = false;
      const targetBtn = anchorRef?.current ?? btnRef.current;
      if (shouldRestore) {
        queueMicrotask(() => {
          targetBtn?.focus();
        });
      } else {
        queueMicrotask(() => {
          if (document.activeElement === targetBtn) {
            targetBtn?.blur();
          }
        });
      }
    }
    setOpen(nextOpen);
  }, []);

  const closeMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    restoreOnCloseRef.current = !!opts?.restoreFocus;
    setOpen(false);
  }, []);

  // 侧栏宽度变化：基座浮层需重新锚定（原实现手动 reposition，现改为重挂）
  useEffect(() => {
    if (!open) return;
    const onSidebarResize = () => setAnchorTick((n) => n + 1);
    window.addEventListener('crish-sidebar-resize', onSidebarResize);
    return () =>
      window.removeEventListener('crish-sidebar-resize', onSidebarResize);
  }, [open]);

  // 打开后聚焦首个可操作控件，便于键盘立即操作
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const first = listFocusable(menuRef.current)[0];
      first?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, anchorTick]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const targetEl = e.target as HTMLElement | null;
    // 主题子菜单位于独立 Portal 子树（DOM 上不在 menuRef 内）：其按键
    // （↑↓ 选择 / ← 收起 / Esc 分层）归基座子菜单自管，本漫游不拦截。
    if (targetEl && menuRef.current && !menuRef.current.contains(targetEl)) {
      return;
    }
    if (e.key === 'Escape') {
      // 基座会处理 Esc；此处接管以便还原焦点
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ restoreFocus: true });
      return;
    }
    // 焦点在主题子菜单行上时 → 交给基座 SubmenuTrigger 展开子菜单
    if (e.key === 'ArrowRight' && targetEl?.closest('[aria-haspopup="menu"]')) {
      return;
    }
    const items = listFocusable(menuRef.current);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const safeIdx = idx >= 0 ? idx : 0;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      items[(safeIdx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      items[(safeIdx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // 离开菜单：关闭并还原触发钮，避免焦点逃到背后
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ restoreFocus: true });
    }
  };

  const applyTheme = (next: UiTheme) => {
    setTheme(next);
    setThemeState(next);
    try {
      const current = getAppSettings();
      if (current && current.theme !== next) {
        setAppSettings({ ...current, theme: next });
      }
    } catch {
      /* swallow-ok: 本地设置镜像同步失败不阻断紧随其后的 saveSettingsEx 权威保存 */
    }
    void clientApi
      .saveSettingsEx('__global__', 'global', { theme: next })
      .catch(() => {
        /* swallow-ok: 主题保存失败不回滚已即时生效的本地主题，设置以服务端下次读取为准 */
      });
  };

  const handleSelectTheme = (next: UiTheme) => {
    applyTheme(next);
  };

  const go = (tab?: SettingsTabType) => {
    closeMenu({ restoreFocus: true });
    openSettings(tab);
  };

  // 退出登录：先关菜单，再走现成确认弹窗（与设置页同一流程、同一弹窗）
  const handleSignOutClick = () => {
    closeMenu();
    setSignOutOpen(true);
  };

  // 检查更新（与关于页同款）：行内检查中态 → 结构化 outcome toast → 关菜单。
  // 检查标记经 updateStore 唯一写入点落盘并广播，页脚更新钮随既有同步链亮起。
  const handleCheckUpdate = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const { checkForUpdate } = await import('../../api/updateStore');
      const result = await checkForUpdate();
      if (result.outcome === 'available') {
        showToast(
          t('about.newVersionAvailable', '发现新版本：{version}', {
            version: result.version ?? '',
          })
        );
      } else if (result.outcome === 'upToDate') {
        showToast(t('about.upToDate', '已是最新版本'));
      } else {
        showToast(result.message || t('about.updateFailed', '检查更新失败'));
      }
    } finally {
      setCheckingUpdate(false);
      closeMenu({ restoreFocus: true });
    }
  };

  const quickEntries: readonly QuickEntry[] = [
    {
      id: 'models',
      label: t('settings.quickMenu.models'),
      title: t('settings.quickMenu.modelsTip'),
      ariaLabel: t('settings.quickMenu.modelsTip'),
      icon: <AppIcon name="orbit" size={16} aria-hidden />,
      tab: 'models',
    },
    {
      id: 'appearance',
      label: t('settings.quickMenu.appearance'),
      title: t('settings.quickMenu.appearanceTip'),
      ariaLabel: t('settings.quickMenu.appearanceTip'),
      icon: <AppIcon name="palette" size={16} aria-hidden />,
      tab: 'appearance',
    },
    {
      id: 'all',
      label: t('settings.quickMenu.allSettings'),
      title: t('settings.quickMenu.allSettingsTip'),
      ariaLabel: t('settings.quickMenu.allSettingsTip'),
      icon: <AppIcon name="settings" size={16} aria-hidden />,
      // 无 tab：进入设置默认页
    },
  ];

  const triggerLabel = open
    ? t('settings.quickMenu.closeMenu')
    : t('settings.quickMenu.openMenu');
  const isDark = theme === 'dark';
  const themeValueLabel = isDark
    ? t('settings.quickMenu.themeDark')
    : t('settings.quickMenu.themeLight');

  const triggerProps = {
    ref: btnRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  };

  const defaultTrigger = (
    <Tooltip content={t('settings.quickMenu.title')} disabled={open}>
      <Button
        bare
        type="button"
        className={`${styles.sidebarFooterSettings}${open ? ` ${styles.isOpen}` : ''}`}
        data-testid="settings-button"
        aria-label={triggerLabel}
        {...triggerProps}
      >
        <AppIcon name="settings" size={16} aria-hidden />
        <span>{t('settings.title')}</span>
        <AppIcon
          name="chevron-up"
          size={14}
          className={styles.sbQuickChev}
          aria-hidden
        />
      </Button>
    </Tooltip>
  );

  const finalTrigger = renderTrigger
    ? renderTrigger({ open, triggerProps })
    : (trigger ?? defaultTrigger);

  const menuNode = (
    <Menu
      key={anchorTick}
      closeOnSelect={false}
      openState={{ open, onOpenChange: handleOpenChange }}
      outsideHandlers={{
        onInteractOutside: () => {
          // 外点关闭：不抢焦点
          restoreOnCloseRef.current = false;
        },
        onCloseAutoFocus: (e: Event) => {
          if (!restoreOnCloseRef.current) {
            e.preventDefault();
          }
        },
      }}
      anchor={anchorRef}
      trigger={anchorRef ? undefined : finalTrigger}
      position={{ side: 'top', align: 'start', sideOffset: 6 }}
      panel={{ contentClassName: styles.sbQuickMenu }}
    >
      <div
        id={menuId}
        ref={menuRef}
        className="sb-quick-menu"
        aria-label={t('settings.quickMenu.title')}
        aria-orientation="vertical"
        onKeyDownCapture={onMenuKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isLoggedIn ? (
          <>
            <div
              className={`${styles.sbQuickIdentityMain} sb-quick-item`}
              data-testid="quick-settings-account"
              role="menuitem"
              tabIndex={-1}
              onClick={() => go('profile')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  go('profile');
                }
              }}
            >
              <div className={styles.sbQuickIdentityContent}>
                <span className={styles.sbQuickAvatar} aria-hidden="true">
                  {showAvatarImage ? (
                    <img
                      className={styles.sbQuickAvatarImage}
                      src={avatarUrl}
                      alt=""
                      onError={() => setFailedAvatar(avatarUrl)}
                    />
                  ) : accountInitialText ? (
                    accountInitialText
                  ) : (
                    <AppIcon name="user" size={15} aria-hidden />
                  )}
                </span>
                <span className={styles.sbQuickIdentityText}>
                  <span className={styles.sbQuickIdentityName}>
                    {displayName}
                  </span>
                </span>
              </div>
              <div className={styles.sbQuickSignOutWrap}>
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  className="sb-quick-signout"
                  data-testid="quick-settings-signout"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSignOutClick();
                  }}
                >
                  {t('settings.quickMenu.signOut')}
                </Button>
              </div>
            </div>
            <Menu.Separator className={styles.sbQuickDivider} />
          </>
        ) : (
          <>
            <Tooltip content={accountTip}>
              <Menu.Item
                className={`${styles.sbQuickItem} sb-quick-item`}
                data-testid="quick-settings-account"
                onClick={() => go('profile')}
              >
                <AppIcon name="user" size={16} aria-hidden />
                <span>{accountLabel}</span>
              </Menu.Item>
            </Tooltip>
            <Menu.Separator className={styles.sbQuickDivider} />
          </>
        )}

        <Menu.SubmenuRoot>
          <Menu.SubmenuTrigger
            className={`${styles.sbQuickItem} sb-quick-item`}
            data-testid="quick-settings-theme"
            tabIndex={-1}
          >
            <AppIcon name="dark-mode" size={16} aria-hidden />
            <span>{t('settings.quickMenu.theme')}</span>
            <span className={styles.sbQuickRowRight}>
              <span className={styles.sbQuickRowValue}>{themeValueLabel}</span>
              <AppIcon
                name="chevron-right"
                size={14}
                className={styles.sbQuickChevRight}
                aria-hidden
              />
            </span>
          </Menu.SubmenuTrigger>
          <Menu.Portal>
            <Menu.Positioner
              side="right"
              align="start"
              sideOffset={-5}
              alignOffset={-6}
              className={`${styles.sbQuickSubPositioner} sb-quick-sub-positioner`}
            >
              <Menu.Popup
                className={`${styles.sbQuickSubmenu} sb-quick-submenu`}
                data-menu-inside="true"
              >
                <Menu.RadioGroup
                  value={theme}
                  onValueChange={(value) =>
                    handleSelectTheme(value === 'dark' ? 'dark' : 'default')
                  }
                >
                  <Menu.RadioItem
                    value="default"
                    className={`${styles.sbQuickSubItem}${!isDark ? ` ${styles.isOn}` : ''}`}
                    data-testid="quick-settings-theme-light"
                    aria-label={t('settings.quickMenu.themeLightAria')}
                    onClick={() => handleSelectTheme('default')}
                  >
                    <span>{t('settings.quickMenu.themeLight')}</span>
                    {!isDark ? (
                      <AppIcon
                        name="check"
                        size={14}
                        className={styles.sbQuickSubCheck}
                        aria-hidden
                      />
                    ) : null}
                  </Menu.RadioItem>
                  <Menu.RadioItem
                    value="dark"
                    className={`${styles.sbQuickSubItem}${isDark ? ` ${styles.isOn}` : ''}`}
                    data-testid="quick-settings-theme-dark"
                    aria-label={t('settings.quickMenu.themeDarkAria')}
                    onClick={() => handleSelectTheme('dark')}
                  >
                    <span>{t('settings.quickMenu.themeDark')}</span>
                    {isDark ? (
                      <AppIcon
                        name="check"
                        size={14}
                        className={styles.sbQuickSubCheck}
                        aria-hidden
                      />
                    ) : null}
                  </Menu.RadioItem>
                </Menu.RadioGroup>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.SubmenuRoot>

        {quickEntries.map((entry) => (
          <Tooltip key={entry.id} content={entry.title}>
            <Menu.Item
              className={`${styles.sbQuickItem} sb-quick-item`}
              data-testid={`quick-settings-${entry.id}`}
              aria-label={entry.ariaLabel}
              onClick={() => go(entry.tab)}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </Menu.Item>
          </Tooltip>
        ))}

        <Tooltip content={t('about.checkUpdates')}>
          <Menu.Item
            className={`${styles.sbQuickItem} sb-quick-item`}
            data-testid="quick-settings-updates"
            disabled={checkingUpdate}
            aria-label={
              checkingUpdate
                ? t('about.checkingUpdates')
                : t('about.checkUpdates')
            }
            onClick={() => void handleCheckUpdate()}
          >
            <AppIcon name="refresh" size={16} aria-hidden />
            <span>
              {checkingUpdate
                ? t('about.checkingUpdates')
                : t('about.checkUpdates')}
            </span>
          </Menu.Item>
        </Tooltip>
      </div>
    </Menu>
  );

  return (
    <>
      {anchorRef ? (
        menuNode
      ) : (
        <div className={styles.sbQuickWrap} ref={rootRef}>
          {menuNode}
        </div>
      )}
      {/* 退出确认弹窗常驻挂载（Menu 兄弟位）：菜单关闭/登录态翻转都不被带走 */}
      <SignOutConfirmDialog
        open={signOutOpen}
        onClose={() => setSignOutOpen(false)}
      />
    </>
  );
};
