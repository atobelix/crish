/**
 * FindReplace — 搜索替换浮动面板
 *
 * Ctrl+F 搜索、Ctrl+H 替换。
 * 使用 SearchPlugin 的 DecorationSet 做高亮，不修改文档结构。
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import {
  Search, X, ChevronUp, ChevronDown,
  CaseSensitive, Regex, Replace, ReplaceAll,
} from 'lucide-react';
import { searchPluginKey, dispatchSearch, replaceCurrent, replaceAll, scrollToCurrentMatch } from '../core/extensions/SearchPlugin';
import type { SearchState } from '../core/extensions/SearchPlugin';
import { Tooltip } from './Tooltip';

interface FindReplaceProps {
  editor: Editor;
  mode: 'find' | 'replace';
  onClose: () => void;
}

export const FindReplace: React.FC<FindReplaceProps> = ({ editor, mode, onClose }) => {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(mode === 'replace');
  const searchRef = useRef<HTMLInputElement>(null);

  // 自动聚焦搜索框
  useEffect(() => {
    searchRef.current?.focus();
    // 如果有选区文本，预填到搜索框
    const { from, to } = editor.state.selection;
    if (from !== to) {
      const selectedText = editor.state.doc.textBetween(from, to);
      if (selectedText.length <= 100) {
        setQuery(selectedText);
      }
    }
  }, [editor]);

  // query / options 变更时更新搜索
  useEffect(() => {
    dispatchSearch(editor.view, {
      type: 'setQuery',
      query,
      caseSensitive,
      regex: useRegex,
    });
  }, [query, caseSensitive, useRegex, editor]);

  // 关闭时清除高亮
  const handleClose = useCallback(() => {
    dispatchSearch(editor.view, { type: 'close' });
    onClose();
  }, [editor, onClose]);

  // 获取当前搜索状态
  const getState = useCallback((): SearchState | undefined => {
    return searchPluginKey.getState(editor.state);
  }, [editor]);

  const handleNext = useCallback(() => {
    dispatchSearch(editor.view, { type: 'nextMatch' });
    // 下一拍滚动到位
    requestAnimationFrame(() => scrollToCurrentMatch(editor.view));
  }, [editor]);

  const handlePrev = useCallback(() => {
    dispatchSearch(editor.view, { type: 'prevMatch' });
    requestAnimationFrame(() => scrollToCurrentMatch(editor.view));
  }, [editor]);

  const handleReplace = useCallback(() => {
    replaceCurrent(editor.view, replacement);
    // 替换后自动跳到下一个
    requestAnimationFrame(() => {
      dispatchSearch(editor.view, { type: 'setQuery', query, caseSensitive, regex: useRegex });
      scrollToCurrentMatch(editor.view);
    });
  }, [editor, replacement, query, caseSensitive, useRegex]);

  const handleReplaceAll = useCallback(() => {
    replaceAll(editor.view, replacement);
  }, [editor, replacement]);

  // 键盘快捷键
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleNext();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handlePrev();
    }
  }, [handleClose, handleNext, handlePrev]);

  const state = getState();
  const matchCount = state?.matches.length ?? 0;
  const currentIdx = state?.currentIndex ?? -1;

  return (
    <div className="find-replace" onKeyDown={handleKeyDown}>
      {/* 搜索行 */}
      <div className="find-replace__row">
        <Search size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          ref={searchRef}
          className="find-replace__input"
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={`find-replace__count ${matchCount === 0 && query ? 'find-replace__count--zero' : ''}`}>
          {query ? `${currentIdx + 1}/${matchCount}` : ''}
        </span>

        <span className="find-replace__divider" />

        <Tooltip content="区分大小写">
          <button
            type="button"
            className={`find-replace__btn ${caseSensitive ? 'is-active' : ''}`}
            onClick={() => setCaseSensitive(!caseSensitive)}
          >
            <CaseSensitive size={14} />
          </button>
        </Tooltip>

        <Tooltip content="正则表达式">
          <button
            type="button"
            className={`find-replace__btn ${useRegex ? 'is-active' : ''}`}
            onClick={() => setUseRegex(!useRegex)}
          >
            <Regex size={14} />
          </button>
        </Tooltip>

        <span className="find-replace__divider" />

        <Tooltip content="上一个 (Shift+Enter)">
          <button type="button" className="find-replace__btn" onClick={handlePrev}>
            <ChevronUp size={14} />
          </button>
        </Tooltip>

        <Tooltip content="下一个 (Enter)">
          <button type="button" className="find-replace__btn" onClick={handleNext}>
            <ChevronDown size={14} />
          </button>
        </Tooltip>

        <Tooltip content={showReplace ? '隐藏替换' : '显示替换'}>
          <button
            type="button"
            className={`find-replace__btn ${showReplace ? 'is-active' : ''}`}
            onClick={() => setShowReplace(!showReplace)}
          >
            <Replace size={14} />
          </button>
        </Tooltip>

        <Tooltip content="关闭 (Escape)">
          <button type="button" className="find-replace__btn" onClick={handleClose}>
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      {/* 替换行 */}
      {showReplace && (
        <div className="find-replace__row">
          <ReplaceAll size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <input
            className="find-replace__input"
            placeholder="替换为…"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button type="button" className="find-replace__action" onClick={handleReplace}>
            替换
          </button>
          <button type="button" className="find-replace__action" onClick={handleReplaceAll}>
            全部替换
          </button>
        </div>
      )}
    </div>
  );
};
