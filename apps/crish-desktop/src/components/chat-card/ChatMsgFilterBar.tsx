/**
 * 本会话消息客户端过滤条（钉在列表上方，紧凑单行）。
 * 显示条件由 ChatCard 控制：mainSurface === 'chat' && showMsgFilter。
 * 子 agent 只在侧栏，不再占用主列 surface。
 *
 * 键盘：Esc 有内容→清词；无内容→关条（stopPropagation，避免全局双击 Esc 分叉）。
 * 过滤即时生效，Enter 不提交。
 */
import React, { useId } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ChatMsgFilterBar.module.css';
import { Button, Tooltip } from '../ui';

export type ChatMsgFilterBarProps = {
  localMsgFilter: string;
  setLocalMsgFilter: (v: string) => void;
  setShowMsgFilter: React.Dispatch<React.SetStateAction<boolean>>;
  /** 过滤后条数 */
  displayCount: number;
  /** 会话总消息数 */
  totalCount: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

export const ChatMsgFilterBar: React.FC<ChatMsgFilterBarProps> = ({
  localMsgFilter,
  setLocalMsgFilter,
  setShowMsgFilter,
  displayCount,
  totalCount,
  inputRef,
}) => {
  const countId = useId();
  const q = localMsgFilter.trim();
  /** 有效关键词（trim 后）；空白不算筛选中 */
  const hasQuery = Boolean(q);
  /** 输入框有任何草稿（含仅空白），用于清词 / 显示清除钮 */
  const hasDraft = localMsgFilter.length > 0;
  const noMatch = hasQuery && displayCount === 0 && totalCount > 0;

  const closeBar = () => {
    setLocalMsgFilter('');
    setShowMsgFilter(false);
  };

  /** 清词后焦点留在输入，便于改关键词（密度：不关条） */
  const clearQuery = () => {
    setLocalMsgFilter('');
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  // 可见紧凑计数：无命中也带总分母，避免只显示「0」丢上下文
  const countText = noMatch
    ? `0/${totalCount}`
    : hasQuery
      ? `${displayCount}/${totalCount}`
      : String(totalCount);

  // 悬停 / 读屏完整中文句（与 ChatEmptyState filter-empty 语感对齐）
  const countTitle = noMatch
    ? `无匹配 · 共 ${totalCount} 条`
    : hasQuery
      ? `匹配 ${displayCount} / 共 ${totalCount}`
      : `共 ${totalCount} 条`;

  const countA11y = noMatch
    ? `无匹配消息，共 ${totalCount} 条`
    : hasQuery
      ? `匹配 ${displayCount} 条，共 ${totalCount} 条`
      : `共 ${totalCount} 条消息`;

  return (
    <div className={styles.bar} role="search" aria-label="本会话消息筛选">
      <Lucide.Search
        size={13}
        className={styles.icon}
        strokeWidth={1.75}
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        value={localMsgFilter}
        placeholder="筛选本会话消息…"
        aria-label="筛选本会话消息"
        aria-describedby={countId}
        aria-invalid={noMatch ? true : undefined}
        aria-keyshortcuts="Escape"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => setLocalMsgFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            // 阻止冒泡：App 层双击 Esc 会分叉会话
            e.stopPropagation();
            if (hasDraft) {
              setLocalMsgFilter('');
            } else {
              closeBar();
            }
          } else if (e.key === 'Enter') {
            // 客户端即时过滤，无提交；阻止表单/默认行为
            e.preventDefault();
          }
        }}
      />
      <Tooltip content={countTitle}>
        <span
          id={countId}
          className={`${styles.count}${noMatch ? ` ${styles.isEmpty}` : ''}${!hasQuery ? ` ${styles.isMuted}` : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={countA11y}
        >
          {countText}
        </span>
      </Tooltip>
      {hasDraft ? (
        <Tooltip content="清除筛选（Esc）">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.clear}
            aria-label="清除筛选"
            aria-keyshortcuts="Escape"
            tabIndex={-1}
            onClick={clearQuery}
            icon={<Lucide.X size={13} strokeWidth={1.75} aria-hidden />}
          />
        </Tooltip>
      ) : null}
      <Tooltip content={hasDraft ? '关闭并清除筛选' : '关闭筛选（Esc）'}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.clear} ${styles.close}`}
          aria-label="关闭筛选"
          onClick={closeBar}
          icon={<Lucide.ChevronUp size={13} strokeWidth={1.75} aria-hidden />}
        />
      </Tooltip>
    </div>
  );
};
