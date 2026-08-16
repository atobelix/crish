import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  Brain,
  Check,
  Copy,
  Download,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { Dialog, Button, Tooltip } from '../ui';
import styles from './FullThoughtModal.module.css';
import { useThoughtInspectorStore } from '../../store/thoughtInspectorStore';
import { ThoughtOutline } from './ThoughtOutline';
import { ThoughtSearchBar } from './ThoughtSearchBar';
import type {
  ThoughtHeading,
  ThoughtSearchResult,
} from '../../workers/thoughtWorker';
import { copyTextBestEffort } from './chatMessageRowUtils';

export const FullThoughtModal: React.FC = () => {
  const {
    isOpen,
    content,
    title,
    activeMessageId,
    activeTurnIndex,
    durationSec,
    closeThoughtInspector,
    searchQuery,
    setSearchQuery,
  } = useThoughtInspectorStore();

  const [headings, setHeadings] = useState<ThoughtHeading[]>([]);
  const [searchResults, setSearchResults] = useState<ThoughtSearchResult[]>([]);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const contentPaneRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 初始化 Worker (RUL-05)
  useEffect(() => {
    if (!isOpen) return;

    try {
      workerRef.current = new Worker(
        new URL('../../workers/thoughtWorker.ts', import.meta.url),
        { type: 'module' }
      );

      workerRef.current.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.type === 'TOC_RESULT') {
          setHeadings(msg.payload.headings || []);
        } else if (msg.type === 'SEARCH_RESULT') {
          const results = msg.payload.results || [];
          setSearchResults(results);
          setCurrentMatchIdx(0);
        }
      };
    } catch {
      workerRef.current = null;
    }

    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [isOpen]);

  // 触发 Worker 计算大纲
  useEffect(() => {
    if (isOpen && content && workerRef.current) {
      workerRef.current.postMessage({
        type: 'EXTRACT_TOC',
        payload: { text: content },
      });
    } else if (!content) {
      setHeadings([]);
    }
  }, [isOpen, content]);

  // 触发 Worker 全文检索
  useEffect(() => {
    if (workerRef.current && content) {
      workerRef.current.postMessage({
        type: 'SEARCH_TEXT',
        payload: { text: content, query: searchQuery },
      });
    } else if (!searchQuery) {
      setSearchResults([]);
    }
  }, [searchQuery, content]);

  const handleCopy = async () => {
    if (!content) return;
    const ok = await copyTextBestEffort(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleExport = () => {
    if (!content) return;
    const blob = new Blob([content], {
      type: 'text/markdown;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Thought-${activeMessageId || 'export'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSelectHeading = (heading: ThoughtHeading) => {
    setActiveHeadingId(heading.id);
    const lineEl = lineRefs.current.get(heading.lineIndex);
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handlePrevMatch = () => {
    if (!searchResults.length) return;
    const nextIdx =
      (currentMatchIdx - 1 + searchResults.length) % searchResults.length;
    setCurrentMatchIdx(nextIdx);
    scrollToMatch(searchResults[nextIdx]);
  };

  const handleNextMatch = () => {
    if (!searchResults.length) return;
    const nextIdx = (currentMatchIdx + 1) % searchResults.length;
    setCurrentMatchIdx(nextIdx);
    scrollToMatch(searchResults[nextIdx]);
  };

  const scrollToMatch = (match?: ThoughtSearchResult) => {
    if (!match) return;
    const lineEl = lineRefs.current.get(match.lineIndex);
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const lines = useMemo(() => {
    return (content || '').split(/\r?\n/);
  }, [content]);

  if (!isOpen) return null;

  const charCount = (content || '').length;
  const wordCountLabel = `${charCount.toLocaleString()} 字符`;
  const stageTitle =
    title ??
    (activeTurnIndex != null
      ? `第 ${activeTurnIndex + 1} 阶段思考`
      : '完整思考链与深度推导');

  return (
    <Dialog
      open={isOpen}
      onClose={closeThoughtInspector}
      size="lg"
      variant={isFullscreen ? 'fullscreen' : 'modal'}
      className={styles.thoughtModal}
      title={
        <div className={styles.modalHeaderTitle}>
          <Brain className={styles.headerBrainIcon} size={18} />
          <span className={styles.headerTitleText}>{stageTitle}</span>
          <span className={styles.metaBadge}>{wordCountLabel}</span>
          {durationSec != null && durationSec > 0 ? (
            <span className={styles.metaBadge}>
              耗时 {durationSec.toFixed(1)}s
            </span>
          ) : null}
        </div>
      }
      footer={
        <div className={styles.modalFooter}>
          <div className={styles.footerLeft}>
            <Tooltip content="一键复制完整 Markdown 思考链">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
              >
                {copied ? '已复制' : '复制全文'}
              </Button>
            </Tooltip>
            <Tooltip content="导出为独立 Markdown 文档 (.md)">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleExport}
                icon={<Download size={14} />}
              >
                导出 .md
              </Button>
            </Tooltip>
            <Tooltip content={isFullscreen ? '退出全屏' : '全屏沉浸查阅'}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsFullscreen((prev) => !prev)}
                icon={
                  isFullscreen ? (
                    <Minimize2 size={14} />
                  ) : (
                    <Maximize2 size={14} />
                  )
                }
              >
                {isFullscreen ? '窗口模式' : '全屏查阅'}
              </Button>
            </Tooltip>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={closeThoughtInspector}
          >
            关闭
          </Button>
        </div>
      }
    >
      <div className={styles.thoughtModalBody}>
        {headings.length > 0 && (
          <ThoughtOutline
            headings={headings}
            onSelectHeading={handleSelectHeading}
            activeHeadingId={activeHeadingId}
          />
        )}
        <div className={styles.thoughtContentPane} ref={contentPaneRef}>
          <ThoughtSearchBar
            query={searchQuery}
            onChange={setSearchQuery}
            onClose={() => setSearchQuery('')}
            matchesCount={searchResults.length}
            activeMatchIndex={currentMatchIdx}
            onNext={handleNextMatch}
            onPrev={handlePrevMatch}
          />
          <div className={styles.thoughtTextWrapper}>
            <div className={styles.thoughtLinesContainer}>
              {lines.map((line: string, idx: number) => {
                const isHeading = /^#{1,4}\s/.test(line);
                return (
                  <div
                    key={idx}
                    ref={(el) => {
                      if (el) lineRefs.current.set(idx, el);
                      else lineRefs.current.delete(idx);
                    }}
                    className={`${styles.thoughtLine} ${isHeading ? styles.headingLine : ''}`}
                  >
                    <span className={styles.lineNumber}>{idx + 1}</span>
                    <span className={styles.lineContent}>{line || ' '}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
