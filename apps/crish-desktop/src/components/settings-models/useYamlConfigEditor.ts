/**
 * useYamlConfigEditor.ts
 * 模型配置文件 (models.yaml) 编辑器状态与业务逻辑 Hook
 *
 * 遵循分层治理规范，解耦业务逻辑与 UI 渲染，保障组件行数预算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useYamlDocumentTransaction } from './useYamlDocumentTransaction';
export { parseLineColumnFromMessage } from './useYamlDocumentTransaction';
export type { YamlSyntaxError } from './useYamlDocumentTransaction';
import { readCodeBlockIndent } from '../../api/codeBlockIndent';
import { highlightCode } from '../../api/codeHighlight';

/** 编辑器严格等高单行刻度 (px)，与 CSS var(--editor-line-height) 刚性对齐 */
export const EDITOR_LINE_HEIGHT = 22;

export interface UseYamlConfigEditorOptions {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function useYamlConfigEditor({
  open,
  onClose,
  onSaved,
}: UseYamlConfigEditorOptions) {
  const {
    code,
    setCode,
    originalCode,
    template,
    filePath,
    loading,
    saving,
    saveSuccess,
    syntaxError,
    serviceError,
    loadConfigFile,
    handleSave,
  } = useYamlDocumentTransaction({ open, onSaved });
  const [showDiscardConfirm, setShowDiscardConfirm] = useState<boolean>(false);
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false);

  // 用户交互开关：代码行数默认不打开，由按钮控制；自动换行开关；复制反馈
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(false);
  const [wordWrap, setWordWrap] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // 快捷搜索状态
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchIndex, setSearchIndex] = useState<number>(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const isDirty = useMemo(() => code !== originalCode, [code, originalCode]);

  const lineCount = useMemo(() => {
    return Math.max(1, code.split('\n').length);
  }, [code]);

  // 搜索匹配位置计算（客户端极速定位）
  const matchIndices = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    const lowerCode = code.toLowerCase();
    const indices: number[] = [];
    let pos = 0;
    while ((pos = lowerCode.indexOf(query, pos)) !== -1) {
      indices.push(pos);
      pos += query.length;
    }
    return indices;
  }, [searchQuery, code]);

  const matchCount = matchIndices.length;

  const highlightedHtml = useMemo(() => {
    const safeCode = code.endsWith('\n') ? code + ' ' : code;
    return highlightCode(safeCode, 'yaml');
  }, [code]);

  // 3. 滚动单向同步处理
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop;
    }
  };

  // 4. Tab 键缩进与快捷键处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const userIndent = readCodeBlockIndent();
      const indentStr = userIndent === '\t' ? '  ' : userIndent;
      const indentLen = indentStr.length;

      const { selectionStart, selectionEnd, value } = textarea;

      if (selectionStart === selectionEnd) {
        const next =
          value.slice(0, selectionStart) +
          indentStr +
          value.slice(selectionEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd =
            selectionStart + indentLen;
        });
      } else {
        const startLineIdx = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const endLineIdx = value.indexOf('\n', selectionEnd);
        const sliceEnd = endLineIdx === -1 ? value.length : endLineIdx;
        const targetBlock = value.slice(startLineIdx, sliceEnd);
        const blockLines = targetBlock.split('\n');

        let nextBlock = '';
        let diff = 0;

        if (e.shiftKey) {
          const processed = blockLines.map((l) => {
            if (l.startsWith(indentStr)) {
              diff -= indentLen;
              return l.slice(indentLen);
            }
            if (l.startsWith(' ')) {
              diff -= 1;
              return l.slice(1);
            }
            return l;
          });
          nextBlock = processed.join('\n');
        } else {
          const processed = blockLines.map((l) => {
            diff += indentLen;
            return indentStr + l;
          });
          nextBlock = processed.join('\n');
        }

        const next =
          value.slice(0, startLineIdx) + nextBlock + value.slice(sliceEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = startLineIdx;
          textarea.selectionEnd = Math.max(startLineIdx, selectionEnd + diff);
        });
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void handleSave();
    }
  };

  // 快捷搜索跳转
  const jumpToMatch = useCallback(
    (targetIdx: number) => {
      if (matchIndices.length === 0 || !textareaRef.current) return;
      const safeIndex = (targetIdx + matchIndices.length) % matchIndices.length;
      setSearchIndex(safeIndex);
      const matchPos = matchIndices[safeIndex];
      if (matchPos === undefined) return;
      const textarea = textareaRef.current;
      textarea.focus();
      textarea.setSelectionRange(matchPos, matchPos + searchQuery.length);

      const linesBefore = code.slice(0, matchPos).split('\n').length - 1;
      const targetScrollTop = Math.max(
        0,
        linesBefore * EDITOR_LINE_HEIGHT - 80
      );
      textarea.scrollTop = targetScrollTop;
    },
    [matchIndices, searchQuery, code]
  );

  useEffect(() => {
    if (matchIndices.length > 0) {
      jumpToMatch(0);
    } else {
      setSearchIndex(0);
    }
  }, [searchQuery, jumpToMatch, matchIndices.length]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (e.shiftKey) {
        jumpToMatch(searchIndex - 1);
      } else {
        jumpToMatch(searchIndex + 1);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (searchQuery) {
        setSearchQuery('');
      }
      textareaRef.current?.focus();
    }
  };

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy YAML:', err);
    }
  };

  // 6. 一键跳转至错误行
  const handleJumpToError = () => {
    if (!syntaxError || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const targetLine = syntaxError.line;
    const targetCol = syntaxError.column || 1;

    const lines = code.split('\n');
    let charOffset = 0;
    for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
      charOffset += (lines[i]?.length ?? 0) + 1;
    }

    const pos = Math.min(code.length, charOffset + Math.max(0, targetCol - 1));
    textarea.focus();
    textarea.setSelectionRange(pos, pos);

    const targetScrollTop = Math.max(
      0,
      (targetLine - 1) * EDITOR_LINE_HEIGHT - 100
    );
    textarea.scrollTop = targetScrollTop;
  };

  // 7. 关闭请求
  const handleRequestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  // 8. 恢复内置模板
  const handleRequestResetTemplate = () => {
    if (!template || code === template) return;
    setShowResetConfirm(true);
  };

  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
  const saveShortcutText = isMac ? '⌘S' : 'Ctrl+S';

  const canSave =
    !syntaxError && !serviceError && isDirty && !loading && !saving;

  const dynamicStatus = loading
    ? 'loading'
    : saving
      ? 'saving'
      : serviceError || syntaxError
        ? 'error'
        : isDirty
          ? 'dirty'
          : 'synced';

  const dynamicStatusLabel = loading
    ? '正在读取配置'
    : saving
      ? '保存中…'
      : serviceError
        ? '配置尚未同步'
        : syntaxError
          ? `第 ${syntaxError.line} 行语法错误`
          : isDirty
            ? '有未保存修改'
            : '已与磁盘同步';

  const dynamicStatusTooltip = loading
    ? '正在读取磁盘配置'
    : saving
      ? '正在校验并写入磁盘...'
      : serviceError
        ? serviceError
        : syntaxError
          ? `${syntaxError.message}（点击跳转到第 ${syntaxError.line} 行）`
          : isDirty
            ? `当前内容已修改，可按 ${saveShortcutText} 保存`
            : '当前内容已与磁盘 models.yaml 保持一致';

  return {
    code,
    setCode,
    originalCode,
    template,
    filePath,
    loading,
    saving,
    saveSuccess,
    syntaxError,
    serviceError,
    showDiscardConfirm,
    setShowDiscardConfirm,
    showResetConfirm,
    setShowResetConfirm,
    showLineNumbers,
    setShowLineNumbers,
    wordWrap,
    setWordWrap,
    copied,
    searchQuery,
    setSearchQuery,
    searchIndex,
    matchCount,
    lineCount,
    highlightedHtml,
    isDirty,
    canSave,
    dynamicStatus,
    dynamicStatusLabel,
    dynamicStatusTooltip,
    searchInputRef,
    textareaRef,
    preRef,
    gutterRef,
    loadConfigFile,
    handleScroll,
    handleKeyDown,
    handleSearchKeyDown,
    jumpToMatch,
    handleCopyAll,
    handleSave,
    handleJumpToError,
    handleRequestClose,
    handleRequestResetTemplate,
  };
}
