/**
 * SlashMenuOverlay — 真 React slash 浮层（catalog 最小集）
 *
 * ## 角色
 * - 呈现 `SlashMenuModel` 过滤后的 catalog（heading / list / code / paragraph 等）
 * - 皮：直接吃 `.bp-slash-host` / `.bp-slash-item` 族（`@crish/block-paper/chrome.css`）
 * - 可点：选项 → `selectItem` → `slash_insert` → `submitIntent` / sink
 *
 * ## 轨
 * - 呈现方向（W3-F 桌面 React）；**≠ EL-01**；**≠ A-BLK-02 产品 e2e 满关**
 * - 写路径不回退 collab Strict：可注入 `createCollabApplySink`；测可用 mock
 * - DomHost catalog 投影可关（`projectSlashCatalog=false`）防双浮层
 *
 * ## 诚实边界
 * - 本组件 **不** 宣称 `/` 键触发全路径 / IME WebView e2e 关闭
 * - 默认 L0：`open=false` 时不渲染可见菜单
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BP_SLASH_EMPTY,
  BP_SLASH_GROUP,
  BP_SLASH_HOST,
  BP_SLASH_ITEM,
  BP_SLASH_OPEN,
  groupSlashCatalogItems,
  selectSlashActiveAndSubmit,
  selectSlashItemAndSubmit,
  type IntentSink,
  type SlashInsertIntent,
  type SlashMenuModel,
  type SlashSelectAndSubmitResult,
  type SubmitIntentOptions,
} from '@crish/block-paper';
import '@crish/block-paper/chrome.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type SlashMenuOverlayProps = {
  /** 状态源；open/filter/active 全由 model 持有 */
  menu: SlashMenuModel;
  /**
   * Intent 接收端。提供时点击/Enter 自动 `select*AndSubmit`。
   * 未提供时仅回调 `onSelectIntent`（调用方自行 sink）。
   */
  sink?: IntentSink;
  /** 透传 submitIntent 的 IME 选项 */
  submitOptions?: SubmitIntentOptions;
  /**
   * model 变更后强制重绘（open / setQuery / moveActive 后由父级 bump）。
   * model 本身非 React 状态，须此 token 或本地 forceTick。
   */
  syncToken?: number | string;
  /**
   * 锚点样式（绝对定位于阅读列内；缺省由 CSS 顶部偏移）。
   * Portal 后置；本波 absolute 浮层即可测。
   */
  style?: React.CSSProperties;
  className?: string;
  /** 浮层 data-testid；默认 note-paper-slash-overlay */
  testId?: string;
  /** 选中产出 Intent 后（无论是否已 submit） */
  onSelectIntent?: (intent: SlashInsertIntent) => void;
  /** 完整 select+submit 结果 */
  onSubmitResult?: (result: SlashSelectAndSubmitResult) => void;
  /** 菜单关闭后（选中成功 / Escape） */
  onClose?: () => void;
  /** 空过滤文案 */
  emptyMessage?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * React slash 浮层：catalog 可点 → Intent → sink。
 * 关闭态返回 null（零噪声）。
 */
export const SlashMenuOverlay: React.FC<SlashMenuOverlayProps> = ({
  menu,
  sink,
  submitOptions,
  syncToken = 0,
  style,
  className,
  testId = 'note-paper-slash-overlay',
  onSelectIntent,
  onSubmitResult,
  onClose,
  emptyMessage = '无匹配项',
}) => {
  // model 变更 → React 重绘（open/setQuery/moveActive/close/select）
  const version = useSyncExternalStore(
    (onStoreChange) => menu.subscribe(onStoreChange),
    () => {
      // 用快照指纹作 getSnapshot（避免无限循环）
      const s = menu.getSnapshot();
      return [
        s.open ? '1' : '0',
        s.blockId ?? '',
        String(s.offset),
        s.query,
        String(s.activeIndex),
        s.items.map((i) => i.id).join(','),
        String(syncToken),
      ].join('|');
    },
    () => 'ssr'
  );
  void version;

  const snap = menu.getSnapshot();
  const [pending, setPending] = useState(false);

  const segments = useMemo(
    () => groupSlashCatalogItems(snap.items),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 指纹驱动
    [version]
  );

  const finishClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const runSelectItem = useCallback(
    async (catalogItemId: string) => {
      if (pending) return;
      setPending(true);
      try {
        if (sink) {
          const result = await selectSlashItemAndSubmit(
            menu,
            catalogItemId,
            sink,
            submitOptions
          );
          onSubmitResult?.(result);
          if (result.ok) {
            onSelectIntent?.(result.intent);
            finishClose();
          } else if (result.stage === 'submit') {
            // select 已关菜单；submit 拒也通知 Intent
            onSelectIntent?.(result.intent);
            finishClose();
          }
          // stage=select 失败：composing 等，菜单可能仍开
        } else {
          const sel = menu.selectItem(catalogItemId);
          if (sel.ok) {
            onSelectIntent?.(sel.intent);
            finishClose();
          }
        }
      } finally {
        setPending(false);
      }
    },
    [
      pending,
      sink,
      menu,
      submitOptions,
      onSubmitResult,
      onSelectIntent,
      finishClose,
    ]
  );

  const runSelectActive = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      if (sink) {
        const result = await selectSlashActiveAndSubmit(
          menu,
          sink,
          submitOptions
        );
        onSubmitResult?.(result);
        if (result.ok) {
          onSelectIntent?.(result.intent);
          finishClose();
        } else if (result.stage === 'submit') {
          onSelectIntent?.(result.intent);
          finishClose();
        }
      } else {
        const sel = menu.selectActive();
        if (sel.ok) {
          onSelectIntent?.(sel.intent);
          finishClose();
        }
      }
    } finally {
      setPending(false);
    }
  }, [
    pending,
    sink,
    menu,
    submitOptions,
    onSubmitResult,
    onSelectIntent,
    finishClose,
  ]);

  // 键盘漫游：↑↓ Enter Escape（仅 open 时）
  useEffect(() => {
    if (!snap.open) return;

    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.key === 'Process') return;
      switch (ev.key) {
        case 'ArrowDown': {
          ev.preventDefault();
          menu.moveActive(1);
          break;
        }
        case 'ArrowUp': {
          ev.preventDefault();
          menu.moveActive(-1);
          break;
        }
        case 'Enter': {
          ev.preventDefault();
          void runSelectActive();
          break;
        }
        case 'Escape': {
          ev.preventDefault();
          menu.close();
          finishClose();
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snap.open, menu, runSelectActive, finishClose]);

  if (!snap.open) {
    return null;
  }

  const rootClass = ['bp-slash-host', 'np-slash-overlay', className]
    .filter(Boolean)
    .join(' ');

  let flatIndex = 0;
  const activeOptionId =
    snap.items[snap.activeIndex] != null
      ? `np-slash-opt-${snap.items[snap.activeIndex]!.id}`
      : undefined;

  return (
    <div
      className={rootClass}
      style={style}
      data-testid={testId}
      {...{ [BP_SLASH_HOST]: '1' }}
      {...{ [BP_SLASH_OPEN]: '1' }}
      data-slash-ui="react"
      data-block-id={snap.blockId ?? undefined}
      data-slash-query={snap.query}
      role="listbox"
      aria-label="斜杠命令"
      aria-activedescendant={activeOptionId}
      aria-busy={pending ? true : undefined}
    >
      {snap.items.length === 0 ? (
        <div
          className="bp-slash-empty"
          {...{ [BP_SLASH_EMPTY]: '1' }}
          role="status"
        >
          {emptyMessage}
        </div>
      ) : (
        segments.map((seg, segIdx) => (
          <React.Fragment key={`seg-${seg.group ?? 'ungrouped'}-${segIdx}`}>
            {seg.group ? (
              <div
                className="bp-slash-group-label"
                {...{ [BP_SLASH_GROUP]: seg.group }}
                role="presentation"
              >
                {seg.group}
              </div>
            ) : null}
            {seg.items.map((it) => {
              const idx = flatIndex;
              flatIndex += 1;
              const isActive = idx === snap.activeIndex;
              const optionId = `np-slash-opt-${it.id}`;
              return (
                <button
                  key={it.id}
                  type="button"
                  id={optionId}
                  className="bp-slash-item"
                  {...{ [BP_SLASH_ITEM]: '1' }}
                  data-item-id={it.id}
                  data-active={isActive ? '1' : '0'}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  disabled={pending}
                  onMouseEnter={() => {
                    // 对齐键盘 active：把高亮移到悬停项（moveActive 会 emit）
                    const delta = idx - menu.getSnapshot().activeIndex;
                    if (delta !== 0) {
                      menu.moveActive(delta);
                    }
                  }}
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    void runSelectItem(it.id);
                  }}
                >
                  <span className="bp-slash-item-icon" aria-hidden>
                    {(it.title.trim().charAt(0) || '?').toUpperCase()}
                  </span>
                  <span className="bp-slash-item-body">
                    <span className="bp-slash-item-title">{it.title}</span>
                    {it.description ? (
                      <span className="bp-slash-item-desc">
                        {it.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </React.Fragment>
        ))
      )}
    </div>
  );
};

export default SlashMenuOverlay;
