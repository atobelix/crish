/**
 * apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx
 * Radix Popover Menu for Slash / Mention Suggestions (CRM-01, DIM-06, T8 aria 全链)。
 * - 键盘漫游与聚焦盾（onOpenAutoFocus/onCloseAutoFocus preventDefault）；
 * - aria-activedescendant 同步至编辑器 combobox；
 * - 纯净化 AI 指令图标与四级几何防漂移；
 * - 终极熔断防线：全零 (0,0) 或无效坐标绝对不挂载 Portal。
 *
 * CI Guardrail: Max 500 lines of effective code, UTF-8 无 BOM.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
} from 'react';
import * as Popover from '@radix-ui/react-popover';

import type { SlashMenuProps, SlashCommandItem } from './composerTypes';
import { goalCommandDisplayLabel, isGoalCommand } from './goalChipLabel';
import styles from './TiptapSlashMenu.module.css';
import {
  isPhysicallyVisibleNonZeroRect,
  isAnchorInsideVisibleField,
  calculateSafeCursorAnchor,
  type SafeAnchorRect,
} from './safeCursorAnchor';
import { Button } from '@/components/ui';
import { AppIcon, ICON_NAMES, type IconName } from '@/components/ui/icons';

export { isValidClientRect } from './safeCursorAnchor';

/** 斜杠命令 iconName → AppIcon IconName（兼容小写、kebab-case 与历史 PascalCase 语义名） */
const ICON_MAP: Record<string, IconName> = {
  target: 'target',
  Target: 'target',
  bookopen: 'book-open',
  'book-open': 'book-open',
  BookOpen: 'book-open',
  calendar: 'calendar',
  Calendar: 'calendar',
  users: 'users',
  Users: 'users',
  globe: 'globe',
  Globe: 'globe',
  play: 'play',
  Play: 'play',
  playcircle: 'play-circle',
  'play-circle': 'play-circle',
  PlayCircle: 'play-circle',
  sparkles: 'sparkles',
  Sparkles: 'sparkles',
  compress: 'shrink',
  Compress: 'shrink',
  shrink: 'shrink',
  Shrink: 'shrink',
  minimize: 'minimize',
  minimize2: 'minimize',
  Minimize2: 'minimize',
  atsign: 'at-sign',
  'at-sign': 'at-sign',
  AtSign: 'at-sign',
  filetext: 'file-text',
  'file-text': 'file-text',
  FileText: 'file-text',
  bot: 'bot',
  Bot: 'bot',
  search: 'search',
  Search: 'search',
  eraser: 'eraser',
  Eraser: 'eraser',
  terminal: 'terminal',
  Terminal: 'terminal',
  helpcircle: 'help-circle',
  'help-circle': 'help-circle',
  HelpCircle: 'help-circle',
  square: 'square',
  Square: 'square',
  sliders: 'sliders',
  Sliders: 'sliders',
  filecode: 'file-code',
  'file-code': 'file-code',
  FileCode: 'file-code',
  shield: 'shield',
  Shield: 'shield',
  clock: 'clock',
  Clock: 'clock',
  flame: 'zap',
  Flame: 'zap',
  zap: 'zap',
  Zap: 'zap',
  compass: 'globe',
  Compass: 'globe',
  settings: 'settings',
  Settings: 'settings',
  'cancel-circle': 'x-circle',
  cancelcircle: 'x-circle',
  CancelCircle: 'x-circle',
  'x-circle': 'x-circle',
  blocks: 'blocks',
  Blocks: 'blocks',
};

/**
 * 语义化图标匹配：优先 item.iconName，次查 command ID/Title 专属特征名，终极按技能统一符号兜底。
 * 每一个功能均对应一种符号，绝不无故退避为 help-circle 问号。
 */
export function resolveSlashCommandIcon(
  item: SlashCommandItem,
  isSkill: boolean
): IconName {
  if (isSkill) return 'blocks';

  const raw = item.iconName;
  if (raw) {
    if (ICON_MAP[raw]) return ICON_MAP[raw];
    const lower = raw.toLowerCase();
    if (ICON_MAP[lower]) return ICON_MAP[lower];
    if ((ICON_NAMES as readonly string[]).includes(raw)) {
      return raw as IconName;
    }
  }

  // 专属特征名 / ID 匹配（保证每一个功能均有专属符号）
  const key = (item.id || item.title || '').toLowerCase().replace(/^[/#]/, '');
  if (key.includes('goal')) return 'target';
  if (key.includes('compact')) return 'shrink';
  if (key.includes('schedule') || key.includes('cron')) return 'clock';
  if (key.includes('browser') || key.includes('web')) return 'globe';
  if (key.includes('teamwork') || key.includes('team')) return 'users';
  if (key.includes('learn')) return 'book-open';
  if (key.includes('grill')) return 'zap';
  if (key.includes('clear')) return 'eraser';
  if (key.includes('stop')) return 'x-circle';
  if (key.includes('settings')) return 'settings';
  if (key.includes('simulate')) return 'play';
  if (key.includes('skill')) return 'blocks';

  return 'sparkles';
}

export interface SlashMenuRefHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * 判定光标是否处于编辑器可见滚动视口内部（向后兼容别名）
 */
export function isCursorVisibleInField(
  cursorRect: DOMRect | SafeAnchorRect,
  fieldElement: HTMLElement | null | undefined
): boolean {
  return isAnchorInsideVisibleField(cursorRect, fieldElement);
}

export const TiptapSlashMenu = forwardRef<SlashMenuRefHandle, SlashMenuProps>(
  (props, ref) => {
    const {
      items,
      command,
      isOpen = true,
      onClose,
      clientRect,
      label = 'AI 会话系统指令',
      emptyMessage: _emptyMessage = '无匹配指令',
      listboxId,
    } = props;
    const [selectedIndex, setSelectedIndex] = useState(0);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      if (itemRefs.current[selectedIndex]) {
        itemRefs.current[selectedIndex]?.scrollIntoView({
          block: 'nearest',
        });
      }
    }, [selectedIndex]);

    // aria-activedescendant 全链：编辑器 combobox → 当前高亮 option
    useEffect(() => {
      const editorAny = props.editor as any;
      const dom = editorAny?.view?.dom as HTMLElement | undefined;
      if (!dom) return;
      const optionId = `${listboxId ?? 'tiptap-suggestion'}-opt-${selectedIndex}`;
      if (items && items.length > 0) {
        dom.setAttribute('aria-activedescendant', optionId);
      }
      return () => {
        if (!editorAny?.isDestroyed) {
          dom.removeAttribute('aria-activedescendant');
        }
      };
    }, [selectedIndex, items, listboxId, props.editor]);

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) {
        command(item);
      }
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        // CJK IME 组合态绝对放行守卫
        if (
          event.isComposing ||
          (event as any).nativeEvent?.isComposing ||
          event.keyCode === 229 ||
          event.key === 'Process'
        ) {
          return false;
        }

        if (!items || items.length === 0) {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (onClose) onClose();
            return true;
          }
          return false;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
          return true;
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          selectItem(selectedIndex);
          return true;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          if (onClose) onClose();
          return true;
        }

        return false;
      },
    }));

    const editorDom = (props.editor as any)?.view?.dom as
      HTMLElement | undefined;
    const rawRect =
      typeof clientRect === 'function' ? clientRect() : clientRect;

    // 四级备援回退与几何有效性探测
    let anchor: SafeAnchorRect | DOMRect | null = null;
    if (rawRect && isPhysicallyVisibleNonZeroRect(rawRect)) {
      anchor = rawRect;
    } else {
      anchor = calculateSafeCursorAnchor({
        rawCursorRect: rawRect,
        editorViewDom: editorDom,
      });
    }

    // 终极熔断防线：无有效几何包围盒或空指令集时拒绝挂载 Portal（自动隐藏）
    if (
      !isOpen ||
      !items ||
      items.length === 0 ||
      !anchor ||
      !isPhysicallyVisibleNonZeroRect(anchor)
    ) {
      return null;
    }

    // 可视滚动视口检查
    const isVisible = isAnchorInsideVisibleField(anchor, editorDom);
    if (!isVisible) {
      return null;
    }

    const side: 'top' | 'bottom' =
      'suggestedSide' in anchor &&
      (anchor.suggestedSide === 'bottom' || anchor.suggestedSide === 'top')
        ? anchor.suggestedSide
        : 'top';

    const triggerStyle: React.CSSProperties = {
      position: 'fixed',
      top: `${anchor.top}px`,
      left: `${anchor.left}px`,
      width: `${Math.max(1, anchor.width)}px`,
      height: `${Math.max(1, anchor.height)}px`,
      pointerEvents: 'none',
      visibility: 'hidden',
      zIndex: 'var(--z-popover)',
    };

    const skillEntries: { item: SlashCommandItem; index: number }[] = [];
    const systemEntries: { item: SlashCommandItem; index: number }[] = [];

    items.forEach((item: SlashCommandItem, index: number) => {
      const isSkill =
        item.category === 'skill' ||
        item.id.includes('skill') ||
        item.title.startsWith('/skill:') ||
        item.iconName === 'blocks';
      if (isSkill) {
        skillEntries.push({ item, index });
      } else {
        systemEntries.push({ item, index });
      }
    });

    const renderItemButton = ({
      item,
      index,
    }: {
      item: SlashCommandItem;
      index: number;
    }) => {
      const isSkill =
        item.category === 'skill' ||
        item.id.includes('skill') ||
        item.title.startsWith('/skill:') ||
        item.iconName === 'blocks';
      const iconName: IconName = resolveSlashCommandIcon(item, isSkill);
      const isActive = index === selectedIndex;

      return (
        <Button
          key={item.id || item.title}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          bare
          type="button"
          role="option"
          id={`${listboxId ?? 'tiptap-suggestion'}-opt-${index}`}
          aria-selected={isActive}
          className={`${styles.menuItem} ${isActive ? styles.menuItemActive : ''}`}
          onClick={(e) => {
            e.preventDefault();
            selectItem(index);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className={styles.iconWrapper}>
            <AppIcon name={iconName} size={15} aria-hidden />
          </div>
          <div className={styles.itemText}>
            <span className={styles.itemTitle}>
              {isGoalCommand(item.id) || isGoalCommand(item.title)
                ? goalCommandDisplayLabel()
                : item.title.replace(/^\/+/, '')}
            </span>
            {item.description && (
              <span className={styles.itemDescription}>{item.description}</span>
            )}
          </div>
          {isSkill && <span className={styles.itemTag}>个人</span>}
        </Button>
      );
    };

    return (
      <Popover.Root open={isOpen}>
        <Popover.Anchor asChild>
          <div style={triggerStyle} />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            className={styles.popoverContent}
            style={{
              width:
                anchor && anchor.width >= 48
                  ? `${Math.round(anchor.width)}px`
                  : undefined,
              maxWidth:
                anchor && anchor.width >= 48
                  ? `${Math.round(anchor.width)}px`
                  : undefined,
            }}
            side={side}
            align="start"
            sideOffset={8}
            avoidCollisions={true}
            collisionPadding={12}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <div
              className={styles.menuList}
              role="listbox"
              aria-label={label}
              id={listboxId}
            >
              {skillEntries.length > 0 && systemEntries.length > 0 ? (
                <>
                  {systemEntries.map(renderItemButton)}
                  <div className={styles.groupHeader}>技能</div>
                  {skillEntries.map(renderItemButton)}
                </>
              ) : (
                items.map((item, index) => renderItemButton({ item, index }))
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
);

TiptapSlashMenu.displayName = 'TiptapSlashMenu';
