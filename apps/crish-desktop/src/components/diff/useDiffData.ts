import { useCallback, useMemo, useState } from 'react';
import { collectMessageDiffs } from '../ChangeOverviewCard';
import { assistantTurnLabel, mergeSessionDiffFiles, type DiffSourceMode } from '../../api/diffPanelHelpers';
import { readTextFile } from '../../api/workspaceFsApi';
import type { FileDiff, SessionMessage, MessageSender, SessionMessageStatus } from '../../store/types';
import type { CompareMode, ComputedChange, SplitPair, UnifiedRenderItem, SplitRenderItem } from '../diffCardTypes';

type SourceMode = DiffSourceMode;

function getComputedChanges(f: FileDiff): ComputedChange[] {
  let o = 0, n = 0;
  return f.changes.map((c, i) => {
    let ol: number | undefined, nl: number | undefined;
    const h = c.content.startsWith('@@') && c.type === 'normal';
    if (h) {
      const m = c.content.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (m && m[1] != null && m[2] != null) { o = parseInt(m[1], 10) - 1; n = parseInt(m[2], 10) - 1; }
    }
    else if (c.type === 'addition') { n++; nl = n; } else if (c.type === 'deletion') { o++; ol = o; } else { o++; n++; ol = o; nl = n; }
    return { change: c, globalIdx: i, oldLine: ol, newLine: nl, isHeader: h };
  });
}

function getSplitPairs(f: FileDiff, inputLines?: ComputedChange[]): SplitPair[] {
  const lines = inputLines ?? getComputedChanges(f);
  const pairs: SplitPair[] = [];
  for (let i = 0; i < lines.length;) {
    const item = lines[i];
    if (!item) { i++; continue; }
    if (item.isHeader) { i++; continue; }
    if (item.change.type === 'deletion') {
      const nx = lines[i + 1];
      if (nx?.change.type === 'addition') { pairs.push({ left: item, right: nx }); i += 2; }
      else { pairs.push({ left: item, right: undefined }); i++; }
    } else if (item.change.type === 'addition') { pairs.push({ left: undefined, right: item }); i++; }
    else { pairs.push({ left: item, right: item }); i++; }
  }
  return pairs;
}

function getUnifiedItems(f: FileDiff, q: string, eb: Record<string, Record<number, boolean>>, ic?: ComputedChange[]): UnifiedRenderItem[] {
  const c = ic ?? getComputedChanges(f);
  const qt = q.trim().toLowerCase();
  const cs = qt ? c.filter((item) => item.change.content.toLowerCase().includes(qt)) : c;
  if (qt) return cs.map((item, i) => ({ isCollapsedPlaceholder: false as const, index: i, item }));
  const vis = new Array(cs.length).fill(false);
  for (let i = 0; i < cs.length; i++) {
    const item = cs[i];
    if (item && (item.change.type !== 'normal' || item.isHeader)) {
      for (let j = Math.max(0, i - 3); j <= Math.min(cs.length - 1, i + 3); j++) {
        const neighbor = cs[j];
        if (neighbor && neighbor.change.type === 'normal') vis[j] = true;
      }
      vis[i] = true;
    }
  }
  const key = f.filePath, items: UnifiedRenderItem[] = [];
  let start = -1;
  for (let i = 0; i < cs.length; i++) {
    const item = cs[i];
    if (!item) continue;
    if (vis[i] || eb[key]?.[i]) {
      if (start !== -1) { items.push({ isCollapsedPlaceholder: true, startIndex: start, count: i - start }); start = -1; }
      items.push({ isCollapsedPlaceholder: false, index: i, item });
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) items.push({ isCollapsedPlaceholder: true, startIndex: start, count: cs.length - start });
  return items;
}

function getSplitItems(f: FileDiff, q: string, eb: Record<string, Record<number, boolean>>, ic?: ComputedChange[]): SplitRenderItem[] {
  const pairs = getSplitPairs(f, ic);
  const qt = q.trim().toLowerCase();
  if (qt) return pairs.map((pair, i) => ({ isCollapsedPlaceholder: false as const, index: i, pair }));
  const vis = new Array(pairs.length).fill(false);
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const hd = (pair.left?.change.type !== 'normal' && pair.left != null) || (pair.right?.change.type !== 'normal' && pair.right != null);
    const hs = (pair.left?.isHeader) || (pair.right?.isHeader);
    if (hd || hs) { for (let j = Math.max(0, i - 3); j <= Math.min(pairs.length - 1, i + 3); j++) vis[j] = true; vis[i] = true; }
  }
  const key = f.filePath, items: SplitRenderItem[] = [];
  let start = -1;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    if (vis[i] || eb[key]?.[i]) { if (start !== -1) { items.push({ isCollapsedPlaceholder: true, startIndex: start, count: i - start }); start = -1; } items.push({ isCollapsedPlaceholder: false, index: i, pair }); }
    else if (start === -1) start = i;
  }
  if (start !== -1) items.push({ isCollapsedPlaceholder: true, startIndex: start, count: pairs.length - start });
  return items;
}

export function useDiffData(opts: {
  session: { messages: Array<{ sender: string; status?: string; id: string; timestamp?: number }> } | null;
  diffFiles: FileDiff[]; activeDiffSource: FileDiff | null;
  diffSearchQuery: string; diffViewMode: 'unified' | 'split'; sourceMode: SourceMode;
}) {
  const { session, diffFiles, activeDiffSource, diffSearchQuery, diffViewMode, sourceMode } = opts;
  const [fileCompareModes, setFileCompareModes] = useState<Record<string, CompareMode>>({});
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, Record<number, boolean>>>({});
  const [plainFileContents, setPlainFileContents] = useState<Record<string, string>>({});
  const [plainLoading, setPlainLoading] = useState<Record<string, boolean>>({});

  const aiTurns = useMemo(() => {
    const msgs = (session?.messages || []).filter((m) => m.sender === 'assistant' && m.status !== 'processing');
    return msgs.map((m, i) => {
      const msg: SessionMessage = {
        id: m.id,
        sender: m.sender as MessageSender,
        status: m.status as SessionMessageStatus,
        timestamp: m.timestamp ?? 0,
      };
      return { msg, index: i, files: collectMessageDiffs(msg) };
    }).filter((t) => t.files.length > 0).reverse();
  }, [session?.messages]);

  const mergedSessionFiles = useMemo(() => mergeSessionDiffFiles(aiTurns), [aiTurns]);
  const fileList = useMemo(() => diffFiles.length > 0 ? diffFiles : (activeDiffSource ? [activeDiffSource] : []), [diffFiles, activeDiffSource]);
  const computedChangesByFile = useMemo(() => { const m = new Map<string, ComputedChange[]>(); for (const f of fileList) m.set(f.filePath, getComputedChanges(f)); return m; }, [fileList]);
  const hasAiTurns = aiTurns.length > 0;

  const turnOptions = useMemo(() => {
    const o: { value: string; label: string; hint?: string }[] = [{ value: '__all__', label: '本会话全部 AI 改动', hint: hasAiTurns ? `${aiTurns.reduce((n, t) => n + t.files.length, 0)} 文件` : undefined }];
    for (const t of aiTurns) o.push({ value: t.msg.id, label: assistantTurnLabel(t.msg, t.index, t.files.length), hint: `${t.files.length} 文件` });
    return o;
  }, [aiTurns, hasAiTurns]);

  const getFileCompareMode = useCallback((fp: string) => fileCompareModes[fp] || (sourceMode === 'git' ? 'git' : 'session-merged'), [fileCompareModes, sourceMode]);

  const changeFileCompareMode = useCallback(async (fp: string, mode: CompareMode) => {
    setFileCompareModes((p) => ({ ...p, [fp]: mode }));
    if (mode === 'plain' && plainFileContents[fp] === undefined) {
      setPlainLoading((p) => ({ ...p, [fp]: true }));
      try { const r = await readTextFile(fp, 1000000); setPlainFileContents((p) => ({ ...p, [fp]: r.content || '（空文件或读取失败）' })); } catch (err) { setPlainFileContents((p) => ({ ...p, [fp]: '读取源码失败：' + String(err) })); }
      finally { setPlainLoading((p) => ({ ...p, [fp]: false })); }
    }
  }, [plainFileContents]);

  const getFileDiffData = useCallback((f: FileDiff) => {
    const m = getFileCompareMode(f.filePath);
    if (m === 'plain') return null;
    if (m === 'git') return f;
    if (m === 'session-merged') return mergedSessionFiles.find((x) => x.filePath === f.filePath) || f;
    if (m.startsWith('turn-')) { const t = aiTurns.find((x) => x.msg.id === m.substring(5)); return t ? t.files.find((x) => x.filePath === f.filePath) || f : f; }
    return f;
  }, [getFileCompareMode, mergedSessionFiles, aiTurns]);

  const handleExpandBlock = useCallback((fileKey: string, si: number) => setExpandedBlocks((p) => ({ ...p, [fileKey]: { ...(p[fileKey] || {}), [si]: true } })), []);

  const unifiedRenderCache = useMemo(() => {
    if (diffViewMode !== 'unified') return new Map<string, UnifiedRenderItem[]>();
    const m = new Map<string, UnifiedRenderItem[]>(); for (const f of fileList) m.set(f.filePath, getUnifiedItems(f, diffSearchQuery, expandedBlocks, computedChangesByFile.get(f.filePath))); return m;
  }, [fileList, computedChangesByFile, diffSearchQuery, expandedBlocks, diffViewMode]);

  const splitRenderCache = useMemo(() => {
    if (diffViewMode !== 'split') return new Map<string, SplitRenderItem[]>();
    const m = new Map<string, SplitRenderItem[]>(); for (const f of fileList) m.set(f.filePath, getSplitItems(f, diffSearchQuery, expandedBlocks, computedChangesByFile.get(f.filePath))); return m;
  }, [fileList, computedChangesByFile, diffSearchQuery, expandedBlocks, diffViewMode]);

  const { stagedCount, unstagedCount } = useMemo(() => {
    let s = 0; for (const f of fileList) if (f.staged) s++; return { stagedCount: s, unstagedCount: fileList.length - s };
  }, [fileList]);

  return {
    aiTurns, hasAiTurns, mergedSessionFiles, fileList, computedChangesByFile, turnOptions,
    fileCompareModes, expandedBlocks, plainFileContents, plainLoading,
    changeFileCompareMode, getFileCompareMode, getFileDiffData, handleExpandBlock,
    getComputedChanges, getSplitPairs, getUnifiedItems, getSplitItems,
    unifiedRenderCache, splitRenderCache, stagedCount, unstagedCount,
  };
}
