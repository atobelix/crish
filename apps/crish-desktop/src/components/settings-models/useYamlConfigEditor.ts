/**
 * useYamlConfigEditor.ts
 * 模型配置文件 (models.yaml) 编辑器状态与业务逻辑 Hook
 *
 * 遵循分层治理规范，解耦业务逻辑与 UI 渲染，保障组件行数预算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeTyped } from '../../api/tauriInvoke';
import { ensureModelsCatalogLoaded, getModelsCatalogPath } from '../../api/modelsCatalogStore';
import { readCodeBlockIndent } from '../../api/codeBlockIndent';
import { highlightCode } from '../../api/codeHighlight';

/** 编辑器严格等高单行刻度 (px)，与 CSS var(--editor-line-height) 刚性对齐 */
export const EDITOR_LINE_HEIGHT = 22;

export interface YamlSyntaxError {
  line: number;
  column?: number;
  message: string;
}

export interface ReadModelsYamlWire {
  path: string;
  content: string;
  template: string;
  seeded: boolean;
  parseError?: { line?: number; column?: number; message: string } | null;
}

export interface ValidateModelsYamlWire {
  valid: boolean;
  line?: number;
  column?: number;
  message?: string;
}

/** 从 Rust InvalidInput 消息中提取「第 L 行 第 C 列」结构化位置（单一错误文本协议） */
export function parseLineColumnFromMessage(message: string): { line?: number; column?: number } {
  const m = /第\s*(\d+)\s*行(?:\s*第\s*(\d+)\s*列)?/.exec(message);
  if (!m) return {};
  return {
    line: m[1] ? Number(m[1]) : undefined,
    column: m[2] ? Number(m[2]) : undefined,
  };
}

export interface UseYamlConfigEditorOptions {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function useYamlConfigEditor({ open, onClose, onSaved }: UseYamlConfigEditorOptions) {
  const [code, setCode] = useState<string>('');
  const [originalCode, setOriginalCode] = useState<string>('');
  const [template, setTemplate] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string>(getModelsCatalogPath());
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [syntaxError, setSyntaxError] = useState<YamlSyntaxError | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
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

  // 1. 读取配置文件
  const loadConfigFile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invokeTyped<ReadModelsYamlWire>('workbench_read_models_yaml', {});

      if (res.status === 'ok') {
        setFilePath(res.data.path || getModelsCatalogPath());
        setTemplate(res.data.template ?? null);
        setCode(res.data.content);
        setOriginalCode(res.data.content);
        setServiceError(null);
        const pe = res.data.parseError;
        setSyntaxError(
          pe ? { line: pe.line ?? 1, column: pe.column ?? 1, message: pe.message } : null
        );
        return;
      }

      setServiceError(
        res.status === 'missing'
          ? '配置文件服务未接线（workbench_read_models_yaml），请重启应用'
          : res.message
      );
      setSyntaxError(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadConfigFile();
      setSaveSuccess(false);
      setSyntaxError(null);
      setServiceError(null);
    }
  }, [open, loadConfigFile]);

  // 2. 实时语法诊断
  useEffect(() => {
    if (!open || serviceError || loading) return;
    const timer = setTimeout(async () => {
      const res = await invokeTyped<ValidateModelsYamlWire>('workbench_validate_models_yaml', {
        content: code,
      });

      if (res.status === 'missing') {
        setServiceError('配置校验服务未接线（workbench_validate_models_yaml），保存已禁用');
        return;
      }
      if (res.status === 'error') {
        setServiceError(res.message);
        return;
      }

      setServiceError(null);
      setSyntaxError(
        res.data.valid
          ? null
          : {
              line: res.data.line ?? 1,
              column: res.data.column ?? 1,
              message: res.data.message || 'YAML 语法格式错误',
            }
      );
    }, 200);

    return () => clearTimeout(timer);
  }, [code, open, serviceError, loading]);

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
        const next = value.slice(0, selectionStart) + indentStr + value.slice(selectionEnd);
        setCode(next);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = selectionStart + indentLen;
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

        const next = value.slice(0, startLineIdx) + nextBlock + value.slice(sliceEnd);
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
      const targetScrollTop = Math.max(0, linesBefore * EDITOR_LINE_HEIGHT - 80);
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

  // 5. 保存
  const handleSave = async () => {
    if (syntaxError || serviceError || saving) return;
    setSaving(true);
    try {
      const res = await invokeTyped<{ path: string }>('workbench_save_models_yaml', {
        content: code,
      });

      if (res.status === 'missing') {
        setServiceError('配置保存服务未接线（workbench_save_models_yaml）');
        return;
      }
      if (res.status === 'error') {
        const pos = parseLineColumnFromMessage(res.message);
        setSyntaxError({ line: pos.line ?? 1, column: pos.column ?? 1, message: res.message });
        return;
      }

      setOriginalCode(code);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      await ensureModelsCatalogLoaded(true);
      onSaved?.();
    } finally {
      setSaving(false);
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

    const targetScrollTop = Math.max(0, (targetLine - 1) * EDITOR_LINE_HEIGHT - 100);
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

  const canSave = !syntaxError && !serviceError && isDirty && !loading && !saving;

  const dynamicStatus = saving
    ? 'saving'
    : syntaxError
      ? 'error'
      : isDirty
        ? 'dirty'
        : 'synced';

  const dynamicStatusLabel = saving
    ? '保存中…'
    : syntaxError
      ? `第 ${syntaxError.line} 行语法错误`
      : isDirty
        ? '有未保存修改'
        : '已与磁盘同步';

  const dynamicStatusTooltip = saving
    ? '正在校验并写入磁盘...'
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
