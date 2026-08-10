// ============================================================
// 查找替换面板：FindReplacePanel.tsx（B2 查找替换，05 高频项 N6）
// ============================================================
// 职责（薄 UI 壳，业务全在引擎既有设施上接线）：
// - 搜索输入：防抖（SEARCH_DEBOUNCE_MS）触发行级分批搜索
//   （src/core/search.ts searchAll——主线程分批不卡帧 + AbortSignal
//   取消），进度经 onProgress 回调显示「已扫描 X/Y 行」；
// - 高亮：命中区间批量注入引擎 handle（onSetHighlights →
//   MarkdownEngine.setSearchRanges → DecorationSet search 装饰 →
//   行级 is-search-line + 行内背景，既有 R5-D 链路）；
// - 跳转：上一处/下一处循环（onGoToMatch → 引擎 scrollToMatch：
//   virtualizer.scrollToIndex 定位行 + 编辑模式 setSelection 选中命中）；
// - 替换：替换当前命中 / 全部替换走 store.applyChange 事务
//   （R4 位置级事务统一入口，单步 undo）；全部替换合并为单事务
//   ——与「逐命中 applyChange 的偏移平移」结果等价，但一次提交
//   = 单步撤销 + 单次解析（大命中数场景的性能差异数量级）；
// - 计数：命中数 / 当前第几处（搜索进行中显示扫描进度）；
// - 快捷键：Ctrl+F 打开查找、Ctrl+H 打开替换、Esc 关闭（全局
//   capture 监听；多实例场景多个面板同时响应为已知限制，demo
//   单实例下无影响）。
// 只读模式（readOnly）：替换区禁用，搜索/高亮/跳转/计数全保留。
//
// 面板为引擎自带交互组件：默认挂载（MarkdownEngine 根容器内、
// 滚动容器外），宿主可用 findReplace prop 关闭。

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { searchAll } from '../core/search';
import type { EditorStore } from '../core/EditorStore';

/** 搜索输入防抖窗口（ms）：输入停顿后才启动扫描（大文档扫描
 *  开销高，逐键触发不可接受；250ms 与主流编辑器持平） */
const SEARCH_DEBOUNCE_MS = 250;

/** 面板 props */
export interface FindReplacePanelProps {
  /** 引擎绑定的编辑器 store 实例（行序列读取 + applyChange 事务） */
  store: EditorStore;
  /** 跳转命中（引擎接线：scrollToMatch——滚动到命中行 + 选中命中） */
  onGoToMatch: (from: number, to: number) => void;
  /** 批量高亮命中（引擎接线：setSearchRanges——全量替换搜索装饰） */
  onSetHighlights: (ranges: readonly { from: number; to: number }[]) => void;
  /** P3 B3 替换动作前置回调（plan-A3 §3 顺带修复）：替换当前/全部替换
   *  在 applyChange 之前调用——面板挂载于引擎根容器内、滚动容器外
   *  （MarkdownEngine 渲染处），容器 capture flush 监听不触达面板
   *  keydown：直刷 pending 存在时替换会作用在滞后 store 上（吞掉直刷
   *  文本）。引擎接线为 flushStreamInternal（提交 pending 后再替换）。
   *  命中在末行时 B 判定（shouldDirectStream）已保证无 pending，本
   *  回调空转零开销——末行分支的竞态由 B 覆盖，非末行分支由本回调
   *  一并闭环。 */
  onBeforeReplace?: () => void;
  /** 只读模式：禁用替换（搜索/高亮/跳转/计数保留） */
  readOnly?: boolean;
}

/** 命中数组二分下界（找第一个 ≥ target 的命中；未找到返回 length） */
function lowerBound(matches: number[], target: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 空高亮共享引用（关闭/清空时整体替换，不就地修改）
const EMPTY_HIGHLIGHTS: readonly { from: number; to: number }[] = [];

/** 面板容器内联样式（不依赖外部 CSS 文件——引擎样式域外不允许
 *  改动，面板自包含：主题色走既有 CSS 变量，随主题联动） */
const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 500,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px',
  background: 'var(--bg-theme)',
  border: '1px solid var(--border-medium)',
  borderRadius: 8,
  boxShadow: '0 4px 16px hsl(80 10% 16% / 0.12)',
  fontSize: 12,
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
};

/** 输入框/按钮行内样式 */
const INPUT_STYLE: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '3px 6px',
  fontSize: 12,
  background: 'var(--white)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
};

const BUTTON_STYLE: React.CSSProperties = {
  border: '1px solid var(--border-medium)',
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 12,
  background: 'var(--white)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
};

export const FindReplacePanel: React.FC<FindReplacePanelProps> = ({
  store,
  onGoToMatch,
  onSetHighlights,
  onBeforeReplace,
  readOnly,
}) => {
  // —— 面板可见态与模式（Ctrl+F = 查找 / Ctrl+H = 替换）——
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'find' | 'replace'>('find');
  // —— 搜索参数与结果 ——
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  /** 全部命中起点偏移（升序；搜索完成后的快照） */
  const [matches, setMatches] = useState<number[]>([]);
  /** 当前命中下标（-1 = 无当前命中） */
  const [currentIdx, setCurrentIdx] = useState(-1);
  /** 分批搜索进行中（UI 显示扫描进度，跳转/替换禁用） */
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });

  // —— 引擎内容信号（文档变化 → 命中失效 → 防抖重搜）——
  // 与 MarkdownEngine/HiddenInput 同款订阅：双段引用 + 行数，
  // 任何内容变更（编辑/append/undo/替换）必然触发其一。
  const lineSig = store((s) => s.mainLines);
  const tailSig = store((s) => s.streamTail);
  const countSig = store((s) => s.getLineCount());

  // —— 异步控制（防抖定时器 + 取消信号）——
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** open 的 ref 镜像（全局 keydown 闭包需要读最新值） */
  const openRef = useRef(open);
  openRef.current = open;

  // 防抖调度：同一窗口内多次触发合并为一次（输入变化 + 文档
  // 变化信号共用；替换后的手动重搜与信号重搜自然去重）
  const scheduleSearch = useCallback(
    (anchorPos?: number) => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        runSearchImpl(anchorPos);
      }, SEARCH_DEBOUNCE_MS);
    },
    // 见 runSearchImpl 注释：查询参数经 ref 读取，依赖仅为空
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // 实际搜索执行（防抖到期后调用）：
  // 1. 取消进行中的旧搜索（AbortSignal——大文档扫描可随时放弃）；
  // 2. 清空旧高亮/旧命中（防扫描期间残留显示旧结果）；
  // 3. 行序列快照（getLineCount + getLine 访问器——双段统一读取，
  //    不读物化视图）→ searchAll 分批扫描（默认 2000 行/批分帧）；
  // 4. 完成：批量注入高亮 + 定位（anchorPos 之后的第一个命中；
  //    无 anchor 时定位第一处——与主流编辑器输入即跳转一致）。
  // 查询参数经 ref 读取（scheduleSearch 空依赖回调在防抖窗口内
  // 拿到的必须是最新值，闭包捕获会过期）。
  const queryRef = useRef(query);
  queryRef.current = query;
  const caseRef = useRef(caseSensitive);
  caseRef.current = caseSensitive;
  const wordRef = useRef(wholeWord);
  wordRef.current = wholeWord;
  const replaceRef = useRef(replaceText);
  replaceRef.current = replaceText;

  const runSearchImpl = useCallback(
    (anchorPos?: number) => {
      abortRef.current?.abort();
      const q = queryRef.current;
      const cs = caseRef.current;
      const ww = wordRef.current;
      const qlen = q.length;
      if (!q) {
        // 空查询：清空高亮与命中（无扫描）
        onSetHighlights(EMPTY_HIGHLIGHTS);
        setMatches([]);
        setCurrentIdx(-1);
        setSearching(false);
        return;
      }
      // 清旧高亮（扫描期间不残留旧命中显示）
      onSetHighlights(EMPTY_HIGHLIGHTS);
      setMatches([]);
      setCurrentIdx(-1);
      // 行序列快照：经访问器逐行取（双段统一；O(n) 行访问 vs
      // 扫描本身的 O(全文)，开销可忽略）
      const s = store.getState();
      const count = s.getLineCount();
      const lines = new Array<string>(count);
      for (let i = 0; i < count; i++) lines[i] = s.getLine(i) ?? '';

      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      searchAll(lines, q, {
        caseSensitive: cs,
        wholeWord: ww,
        signal: controller.signal,
        onProgress: (p) =>
          setProgress({ processed: p.processedLines, total: p.totalLines }),
      })
        .then((hits) => {
          setSearching(false);
          setMatches(hits);
          onSetHighlights(
            hits.map((m) => ({ from: m, to: m + qlen }))
          );
          if (hits.length === 0) {
            setCurrentIdx(-1);
            return;
          }
          // 定位：anchorPos 之后的第一个命中（替换后的自然续位），
          // 无 anchor 或全部在前方 → 第一处
          const anchor = anchorPos ?? -1;
          const idx = lowerBound(hits, anchor);
          const finalIdx = idx < hits.length ? idx : 0;
          setCurrentIdx(finalIdx);
          onGoToMatch(hits[finalIdx], hits[finalIdx] + qlen);
        })
        .catch(() => {
          // 取消（AbortError）/异常：静默——输入变化/关闭面板的
          // 正常中断路径，不做 UI 提示
          setSearching(false);
        });
    },
    [store, onSetHighlights, onGoToMatch]
  );

  // 用户输入/参数变化 → 防抖重搜（光标定位第一处）
  useEffect(() => {
    if (!open) return;
    scheduleSearch();
    // 关闭面板时不做搜索（open 分支返回）
  }, [query, caseSensitive, wholeWord, open, scheduleSearch]);

  // 文档内容变化 → 命中偏移失效 → 防抖重搜（面板打开且有词时）
  useEffect(() => {
    if (!open || !queryRef.current) return;
    scheduleSearch();
  }, [lineSig, tailSig, countSig, open, scheduleSearch]);

  // —— 快捷键（Ctrl+F / Ctrl+H / Esc）：全局 capture 监听——
  // capture 相位先于 React 合成事件与编辑器内 keydown，阻止冒泡
  // 防止 Ctrl+F 触达浏览器查找/textarea 默认行为。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setMode('find');
        setOpen(true);
      } else if (mod && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        e.stopPropagation();
        setMode('replace');
        setOpen(true);
      } else if (e.key === 'Escape' && openRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // closePanel 为稳定引用（见下方 useCallback）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开后聚焦输入框并全选已有词（便于重新输入）
  useEffect(() => {
    if (open) {
      // 等渲染完成后聚焦（模式切换/首次打开均生效）
      window.setTimeout(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      }, 0);
    }
  }, [open]);

  // 关闭面板：取消扫描 + 清空高亮与命中（搜索态复位）
  const closePanel = useCallback(() => {
    abortRef.current?.abort();
    onSetHighlights(EMPTY_HIGHLIGHTS);
    setOpen(false);
    setMatches([]);
    setCurrentIdx(-1);
    setSearching(false);
  }, [onSetHighlights]);

  // —— 跳转：上一处/下一处循环（命中区间 [0, n) 环形）——
  const goToMatch = useCallback(
    (delta: 1 | -1) => {
      if (searching || matches.length === 0) return;
      const n = matches.length;
      const next = (currentIdx + delta + n) % n;
      setCurrentIdx(next);
      const from = matches[next];
      onGoToMatch(from, from + queryRef.current.length);
    },
    [searching, matches, currentIdx, onGoToMatch]
  );

  // —— 替换当前命中：applyChange 事务（单步 undo）——
  // 替换后命中列表全部失效（偏移平移）→ 防抖重搜，并定位到
  // 「替换位置之后」的第一个命中（anchor = 原命中起点 + 替换文
  // 长度——applyChange 默认光标落点同值，续位语义自然）
  const replaceCurrent = useCallback(() => {
    if (readOnly || searching || currentIdx < 0) return;
    // P3 B3（plan-A3 §3）：替换动作前置提交直刷 pending（引擎接线 =
    // flushStreamInternal）——直刷会话中 store 滞后于 DOM，applyChange
    // 基于 matches 快照（搜索时位置）作用在滞后 store 上会吞掉直刷
    // 文本；先 flush 保证替换落在最新 store。命中在末行时 B 判定已
    // 降级（无 pending），空转零开销。
    onBeforeReplace?.();
    const qlen = queryRef.current.length;
    const from = matches[currentIdx];
    const to = from + qlen;
    store.getState().applyChange(from, to, replaceRef.current, {
      merge: 'none',
    });
    scheduleSearch(from + replaceRef.current.length);
  }, [readOnly, searching, currentIdx, matches, store, scheduleSearch, onBeforeReplace]);

  // —— 全部替换：单事务合并（等价逐命中 applyChange 的偏移平移）——
  // 拼接 [首命中, 末命中尾) 区间：命中段替换为替换文本、命中间
  // 原文保留，一次 applyChange = 单步撤销 + 单次解析/渲染
  const replaceAll = useCallback(() => {
    if (readOnly || searching || matches.length === 0) return;
    // P3 B3（plan-A3 §3）：同 replaceCurrent——全部替换同样前置提交
    // 直刷 pending，防拼接区间作用在滞后 store 上。
    onBeforeReplace?.();
    const qlen = queryRef.current.length;
    const repl = replaceRef.current;
    const s = store.getState();
    const text = s.getText();
    const first = matches[0];
    const last = matches[matches.length - 1];
    const spanEnd = last + qlen;
    let out = '';
    let prev = first;
    for (const m of matches) {
      out += text.substring(prev, m) + repl;
      prev = m + qlen;
    }
    out += text.substring(prev, spanEnd);
    s.applyChange(first, spanEnd, out, { merge: 'none' });
    // 替换后重搜：定位替换区间之后的第一命中（replacement 含
    // query 时可能续命；否则回绕第一处/无命中）
    scheduleSearch(first + repl.length);
  }, [readOnly, searching, matches, store, scheduleSearch, onBeforeReplace]);

  // 输入框 Enter：查找模式 = 下一处；替换模式 = 替换当前
  const handleQueryKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goToMatch(-1);
      else if (mode === 'replace') replaceCurrent();
      else goToMatch(1);
    }
  };

  const handleReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) replaceAll();
      else replaceCurrent();
    }
  };

  // 计数文案：进行中显示扫描进度；完成显示「第 x/n 处」
  const countText = useMemo(() => {
    if (searching) return `已扫描 ${progress.processed}/${progress.total} 行`;
    if (!query) return '';
    if (matches.length === 0) return '无结果';
    return `${currentIdx + 1}/${matches.length}`;
  }, [searching, progress, query, matches, currentIdx]);

  if (!open) return null;

  return (
    <div style={PANEL_STYLE}>
      {/* 查找行：输入 + 上一处/下一处 + 计数 + 关闭 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleQueryKeyDown}
          placeholder="查找…"
          aria-label="查找"
          spellCheck={false}
          style={{ ...INPUT_STYLE, width: 160 }}
        />
        <button
          onClick={() => goToMatch(-1)}
          disabled={searching || matches.length === 0}
          style={BUTTON_STYLE}
          title="上一处（Shift+Enter）"
        >
          上一处
        </button>
        <button
          onClick={() => goToMatch(1)}
          disabled={searching || matches.length === 0}
          style={BUTTON_STYLE}
          title="下一处（Enter）"
        >
          下一处
        </button>
        <span
          data-find-count="true"
          style={{ minWidth: 70, textAlign: 'right', color: 'var(--text-secondary)' }}
        >
          {countText}
        </span>
        <button
          onClick={closePanel}
          style={{ ...BUTTON_STYLE, padding: '3px 6px' }}
          title="关闭（Esc）"
          aria-label="关闭查找面板"
        >
          ×
        </button>
      </div>
      {/* 替换行（Ctrl+H 切换）：替换输入 + 替换当前 + 全部替换 */}
      {mode === 'replace' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="替换为…"
            aria-label="替换为"
            spellCheck={false}
            style={{ ...INPUT_STYLE, width: 160 }}
          />
          <button
            onClick={replaceCurrent}
            disabled={readOnly || searching || currentIdx < 0}
            style={BUTTON_STYLE}
            title="替换当前命中（Enter）"
          >
            替换
          </button>
          <button
            onClick={replaceAll}
            disabled={readOnly || searching || matches.length === 0}
            style={BUTTON_STYLE}
            title="替换全部命中（Shift+Enter）"
          >
            全部替换
          </button>
        </div>
      )}
      {/* 选项行：大小写 / 全词 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-secondary)' }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          区分大小写
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          全词匹配
        </label>
      </div>
    </div>
  );
};
