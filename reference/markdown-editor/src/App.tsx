import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useEditorStore } from './core/EditorStore';
import { useTableStore } from './core/TableStore';
import {
  MarkdownEngine,
  type MarkdownEngineHandle,
  type StreamState,
} from './components/MarkdownEngine';
import { ContextMenu } from './components/ContextMenu';
import testDoc from './assets/test-document.md?raw';
import {
  SAMPLE_DOCS,
  SAMPLE_DOCS_MAP,
  MULTI_STREAM_PRESETS,
  buildStressTestContent,
  buildStreamingContent,
} from './assets/docs/docManifest';
import './index.css';

// W3-2 演示宿主（docs/streaming-render/00-流式渲染极致化总方案.md：
// S-EL-12 / R-8 / S-T-3-02）：把引擎「装车」——engineRef 暴露（含
// window.__CRISH_ENGINE__，perf 直刷压测入口）、模拟流驾驶舱（开始/
// 暂停/继续/中断/丢弃/导出）、aria-live 流式三态播报（开始/完成/丢弃，
// 保留防逐字轰炸：不逐 chunk 播报）。
//
// 设计要点：
// - MarkdownEngine 恒挂载（不再按 textLength > 0 条件渲染）——engineRef
//   全程有效，流式从空文档开始也直接可用；既有静态文档加载能力保留为
//   「加载万行压力文档」按钮 + 挂载自动加载（演示模式共存，主仓保护
//   spec 依赖挂载即加载的文档内容）。
// - 模拟流 = 预置演示内容（中文 + Markdown 混合：标题/列表/表格/代码块/
//   公式 + 纯文本行）按粒度（字符/词/行）切成 chunk，setInterval 时间
//   戳驱动按 token 率注入（streamAppend）；暂停 = 停止注入 + flushStream
//   收敛（Handle 无暂停 API，任务书约定用「停止注入」模拟）；中断 =
//   streamEnd 收口；丢弃 = discardStream 回滚。
// - 光标钉在文档首（R5 宿主侧协议：AI 输出期间用户光标不参与流式区域，
//   shouldDirectStream 的「光标在末行行中 → 降级」门禁放行直刷——与
//   unit 测试同款语义）。
// - aria-live（R-8）：role="status" aria-live="polite" 隐藏元素承载
//   三态播报文案；完成/丢弃播报以引擎 onStreamEnd 信号为唯一来源。

declare global {
  interface Window {
    __CRISH_ENGINE__: MarkdownEngineHandle | null;
    __CRISH_DEMO_CONTENT__: string;
  }
}

/** 流式会话阶段（驾驶舱状态机） */
type StreamPhase = 'idle' | 'streaming' | 'paused' | 'done' | 'discarded';

/** 注入粒度（chunk 切分方式） */
export type Granularity = 'char' | 'word' | 'line';

export const GRANULARITY_OPTIONS: Granularity[] = ['char', 'word', 'line'];
export const GRANULARITY_LABELS: Record<Granularity, string> = {
  char: '字符',
  word: '词语',
  line: '整行',
};

/** 可调 token 率档位（tps = tokens per second） */
export const RATE_OPTIONS = [10, 50, 200, 500] as const;

// ── 预置演示内容（S-EL-12：展示流式全能力）──
// 默认采用 05 号工业级高并发推送引擎方案（178行），完美兼顾 e2e 测试契约与全能力压测
const DEFAULT_DEMO = buildStreamingContent('05-streaming');
export const DEMO_LINES: readonly string[] = DEFAULT_DEMO.lines;
const DEMO_CONTENT = DEFAULT_DEMO.content;

/** 演示内容暴露到 window（e2e 终态一致性断言数据源） */
window.__CRISH_DEMO_CONTENT__ = DEMO_CONTENT;

/** 按粒度把演示内容切成 chunk（任意粒度 chunk 拼接 === 原文，无损） */
function splitChunks(content: string, granularity: Granularity): string[] {
  if (granularity === 'char') {
    return Array.from(content);
  }
  if (granularity === 'line') {
    const lines = content.split('\n');
    return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
  }
  // word：CJK 单字 / ASCII 词 / 空白段 / 其他单字符（含标点），
  // 覆盖全部字符类别且无重叠，拼接恒还原原文
  const tokens: string[] = [];
  const re = /[\u4e00-\u9fff]|[a-zA-Z0-9]+|\s+|[^\u4e00-\u9fff\s]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function App() {
  const engineRef = useRef<MarkdownEngineHandle | null>(null);
  const setText = useEditorStore((state) => state.setText);
  const textLength = useEditorStore((state) => state.textLength);

  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [rate, setRate] = useState<number>(50);
  const [granularity, setGranularity] = useState<Granularity>('char');
  const [progress, setProgress] = useState('');
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [exportPanel, setExportPanel] = useState<{
    kind: 'markdown' | 'html';
    text: string;
  } | null>(null);
  const [selectedStreamTarget, setSelectedStreamTarget] = useState<string>('05-streaming');
  const [selectedStressDoc, setSelectedStressDoc] = useState<string>('00-baseline');
  const [toast, setToast] = useState<{ message: string; type?: 'info' | 'success' | 'warn' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'warn' = 'info') => {
    setToast({ message, type });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 2500);
  }, []);

  // 既有静态文档能力保留（共存设计）：挂载即加载万行压力文档（100 ×
  // test-document ≈ 1.5 万行）。流式驾驶舱的「开始流式」会先 setText('')
  // 清空（代际计数取消在途分块加载），静态/流式两种演示模式互不干扰；
  // 「加载万行压力文档」按钮可随时重新加载。主仓 wysiwyg-interaction
  // 等保护 spec 依赖挂载即加载的文档内容，此行为不可移除。
  useEffect(() => {
    const chunks: string[] = [];
    chunks.push(
      `# 高性能 Markdown 渲染引擎全面压力测试\n\n> 当前渲染规模: 100 个副本。本测试用例文档已全面穷举，覆盖 Markdown 所有基础语法与极端解析场景。\n\n---\n`
    );
    for (let i = 0; i < 100; i++) {
      chunks.push(testDoc);
    }
    setText(chunks.join('\n'));
  }, [setText]);

  // 注入计时器 ref（chunk 游标 + 会话起点 + 动态平滑调速）
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<string[]>([]);
  const posRef = useRef(0);
  const sessionStartRef = useRef(0);
  const pausedAtRef = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const targetTokensRef = useRef(0);
  const lastTickTimeRef = useRef(0);
  // 编程式收口（开始流式前强制结束旧会话）的播报抑制开关
  const suppressEndAnnounceRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** aria-live 播报与视觉 Toast 同步联动 */
  const announce = useCallback((text: string, type: 'info' | 'success' | 'warn' = 'info') => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
    showToast(text, type);
  }, [showToast]);

  // ── 引擎完成/丢弃信号 → aria-live 播报（R-8 三态之二/三）──
  // 注册一次（引擎恒挂载）；编程式收口经 suppressEndAnnounceRef 抑制。
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    return engine.onStreamEnd((info) => {
      if (suppressEndAnnounceRef.current) {
        suppressEndAnnounceRef.current = false;
        return;
      }
      announce(info.discarded ? '已丢弃生成内容' : '生成完成');
    });
  }, [announce]);

  // 卸载清理注入计时器
  useEffect(() => stopTimer, [stopTimer]);

  // engineRef 暴露（perf 直刷压测入口，05-宿主接口与场景.md P2）
  useEffect(() => {
    window.__CRISH_ENGINE__ = engineRef.current;
    (window as any).__tableStore = useTableStore;
    (window as any).__editorStore = useEditorStore;
  }, []);

  // 驾驶舱状态摘要轮询（流式/暂停期间展示 getStreamState）
  useEffect(() => {
    if (phase !== 'streaming' && phase !== 'paused') {
      setStreamState(null);
      return;
    }
    const t = window.setInterval(() => {
      setStreamState(engineRef.current?.getStreamState() ?? null);
    }, 200);
    return () => window.clearInterval(t);
  }, [phase]);

  /** 时间戳驱动注入节拍（10ms tick；动态 rateRef 实时平滑调速） */
  const tick = useCallback(() => {
    const now = performance.now();
    const dt = now - lastTickTimeRef.current;
    lastTickTimeRef.current = now;
    targetTokensRef.current += (dt * rateRef.current) / 1000;
    const target = Math.min(
      chunksRef.current.length,
      Math.floor(targetTokensRef.current)
    );
    while (posRef.current < target) {
      engineRef.current?.streamAppend(chunksRef.current[posRef.current]);
      posRef.current++;
    }
    // 光标钉在文档首（R5 宿主侧协议：AI 输出期间用户光标不参与流式
    // 区域——shouldDirectStream 的「光标在末行行中 → 降级」门禁放行
    // 直刷，与 unit 测试同款语义；光标 0 < 追加锚点 → append 平移
    // 不再推动光标，一次性收敛后恒保持）
    const st = useEditorStore.getState();
    if (st.cursorPos !== 0) st.setCursorPos(0);
    // 值不变时跳过 setState（React 引用相等 bailout，避免 10ms 节拍
    // 空转重渲染——注入期间 App 不因进度文本反复重渲染）
    setProgress((prev) => {
      const next = `${posRef.current}/${chunksRef.current.length}`;
      return prev === next ? prev : next;
    });
    if (posRef.current >= chunksRef.current.length) {
      stopTimer();
      engineRef.current?.streamEnd();
      setPhase('done');
    }
  }, [stopTimer]);

  const startTimer = useCallback(() => {
    stopTimer();
    sessionStartRef.current = performance.now();
    lastTickTimeRef.current = performance.now();
    targetTokensRef.current = posRef.current;
    timerRef.current = window.setInterval(tick, 10);
  }, [stopTimer, tick]);

  /** 编程式收口（结束旧会话，不播报） */
  const silentlyEndSession = useCallback(() => {
    stopTimer();
    suppressEndAnnounceRef.current = true;
    engineRef.current?.discardStream();
    suppressEndAnnounceRef.current = false;
  }, [stopTimer]);

  /** 开始流式：清空文档 → 切 chunk → 按 token 率注入（支持单篇与多篇全流程连跑） */
  const startStreaming = useCallback(() => {
    silentlyEndSession();
    setText('');
    const { content, title } = buildStreamingContent(selectedStreamTarget);
    window.__CRISH_DEMO_CONTENT__ = content;
    chunksRef.current = splitChunks(content, granularity);
    posRef.current = 0;
    setExportPanel(null);
    setPhase('streaming');
    announce(`AI 正在生成：${title}…`);
    startTimer();
  }, [announce, granularity, selectedStreamTarget, setText, silentlyEndSession, startTimer]);

  /** 暂停：停止注入 + flushStream 收敛（DOM 与 store 一致） */
  const pauseStreaming = useCallback(() => {
    if (phase !== 'streaming') return;
    stopTimer();
    pausedAtRef.current = performance.now();
    engineRef.current?.flushStream();
    setPhase('paused');
  }, [phase, stopTimer]);

  /** 继续：从暂停点恢复注入（会话时钟扣除暂停时长） */
  const resumeStreaming = useCallback(() => {
    if (phase !== 'paused') return;
    sessionStartRef.current += performance.now() - pausedAtRef.current;
    setPhase('streaming');
    startTimer();
  }, [phase, startTimer]);

  /** 中断（streamEnd）：收下已生成内容，播报完成 */
  const stopStreaming = useCallback(() => {
    if (phase !== 'streaming' && phase !== 'paused') return;
    stopTimer();
    engineRef.current?.streamEnd();
    setPhase('done');
  }, [phase, stopTimer]);

  /** 丢弃（discardStream）：回滚到会话前，播报丢弃 */
  const discardStreaming = useCallback(() => {
    if (phase !== 'streaming' && phase !== 'paused') return;
    stopTimer();
    engineRef.current?.discardStream();
    setPhase('discarded');
  }, [phase, stopTimer]);

  /** 导出当前文档（getContent / exportHtml 聚合，先 flush） */
  const exportDocument = useCallback((kind: 'markdown' | 'html') => {
    const engine = engineRef.current;
    if (!engine) return;
    const text =
      kind === 'markdown' ? engine.getContent() : engine.exportHtml();
    setExportPanel({ kind, text });
  }, []);

  /** 加载万行压力文档（支持所有 md 界面扩展为 10,000+ 行压测） */
  const loadMassiveDoc = useCallback(
    (targetDocId?: string) => {
      silentlyEndSession();
      setPhase('idle');
      setProgress('');
      setExportPanel(null);
      const docId = targetDocId || selectedStressDoc;
      const content = buildStressTestContent(docId);
      setText(content);
      const doc = SAMPLE_DOCS_MAP.get(docId);
      announce(
        `已加载【${doc?.shortTitle || '基础综合'}】万行压测文档（约 ${(
          (doc?.linesCount || 188) * (doc?.repeatCountFor10k || 100)
        ).toLocaleString()} 行）`
      );
    },
    [selectedStressDoc, setText, silentlyEndSession, announce]
  );

  /** 加载单篇文档（1× 原始规模，完整排版阅读与就地编辑） */
  const loadSingleDoc = useCallback(
    (docId: string) => {
      silentlyEndSession();
      setPhase('idle');
      setProgress('');
      setExportPanel(null);
      const doc = SAMPLE_DOCS_MAP.get(docId);
      if (doc) {
        setText(doc.content);
        announce(`已加载单篇文档：${doc.shortTitle}`);
      }
    },
    [setText, silentlyEndSession, announce]
  );

  /** 清空文档（静默结束旧会话） */
  const clearDocument = useCallback(() => {
    silentlyEndSession();
    setPhase('idle');
    setProgress('');
    setExportPanel(null);
    setText('');
  }, [setText, silentlyEndSession]);



  const streamSummary = streamState
    ? `active=${streamState.active} buffered=${streamState.bufferedChars} direct=${streamState.directPendingChars} follow=${streamState.followState}`
    : '';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* 结构化现代化顶部控制栏（极简紧凑、分区明确、微微质感） */}
      {/* 结构化现代化顶部控制栏（统一 28px 网格基线、3% 纯灰交互、分区清晰） */}
      <header className="top-bar-header">
        {/* 第一行：流式 AI 输出控制台 */}
        <div className="top-bar-row">
          {/* 左区：品牌徽标与流式状态 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div className="top-brand-badge" title="Conex Markdown Editor">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>Conex</span>
            </div>

            <span
              data-testid="stream-status"
              data-phase={phase}
              title={streamSummary || '文档统计与生成状态'}
              className="top-status-badge"
            >
              <span
                className="top-status-dot"
                style={{
                  backgroundColor:
                    phase === 'streaming'
                      ? 'hsl(142 60% 40%)'
                      : phase === 'paused'
                      ? 'hsl(38 92% 50%)'
                      : 'var(--brand)',
                }}
              />
              {phase === 'streaming' ? (
                <span>AI 生成中 {progress ? `(${progress})` : ''}</span>
              ) : phase === 'paused' ? (
                <span>已暂停</span>
              ) : (
                <span>{Number(textLength).toLocaleString()} 字符</span>
              )}
            </span>
          </div>

          {/* 中区：剧本选择 + 播放控制 */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div className="top-btn-group" title="选择流式剧本（支持单篇独立流式与多篇连续连跑）">
              <span className="top-control-label">流式剧本</span>
              <div className="top-select-wrapper">
                <select
                  data-testid="stream-target-select"
                  value={selectedStreamTarget}
                  onChange={(e) => setSelectedStreamTarget(e.target.value)}
                  disabled={phase === 'streaming' || phase === 'paused'}
                  className="top-select"
                  style={{ maxWidth: 210 }}
                  title="选择流式输出剧本：单篇专业领域或多篇全流程连续流式"
                >
                  <optgroup label="单篇独立流式输出">
                    {SAMPLE_DOCS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.shortTitle} ({d.linesCount}行)
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="多篇全流程连续渲染（多篇连跑）">
                    {MULTI_STREAM_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <svg className="top-select-arrow" width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </div>
            </div>

            <button
              type="button"
              data-testid="stream-start"
              onClick={startStreaming}
              title="开始流式输出"
              className="top-btn top-btn-primary"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>开始流式</span>
            </button>

            <div className="top-btn-group">
              <button
                type="button"
                data-testid="stream-pause"
                onClick={pauseStreaming}
                disabled={phase !== 'streaming'}
                title="暂停流式"
                className="top-btn-group-item"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
                <span>暂停</span>
              </button>
              <button
                type="button"
                data-testid="stream-resume"
                onClick={resumeStreaming}
                disabled={phase !== 'paused'}
                title="继续流式"
                className="top-btn-group-item"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>继续</span>
              </button>
              <button
                type="button"
                data-testid="stream-stop"
                onClick={stopStreaming}
                disabled={phase !== 'streaming' && phase !== 'paused'}
                title="中断并完成"
                className="top-btn-group-item"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                <span>中断</span>
              </button>
              <button
                type="button"
                data-testid="stream-discard"
                onClick={discardStreaming}
                disabled={phase !== 'streaming' && phase !== 'paused'}
                title="丢弃本次流式内容"
                className="top-btn-group-item top-btn-group-danger"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <span>丢弃</span>
              </button>
            </div>
          </div>

          {/* 右区：速率与粒度下拉选择 */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div className="top-btn-group" title="流式速率设置 (tps = tokens per second)">
              <span className="top-control-label">速率</span>
              <div className="top-select-wrapper">
                <select
                  data-testid="rate-select"
                  value={rate}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setRate(val);
                    rateRef.current = val;
                    announce(`流式速率已切换为 ${val} tps`);
                  }}
                  className="top-select"
                  style={{ width: 88 }}
                  title="选择流式输出速率 (tps)"
                >
                  {RATE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r} tps
                    </option>
                  ))}
                </select>
                <svg className="top-select-arrow" width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </div>
            </div>

            <div className="top-btn-group" title="流式注入切分粒度设置">
              <span className="top-control-label">粒度</span>
              <div className="top-select-wrapper">
                <select
                  data-testid="granularity-select"
                  value={granularity}
                  onChange={(e) => {
                    const g = e.target.value as Granularity;
                    setGranularity(g);
                    announce(`注入粒度已切换为 ${GRANULARITY_LABELS[g]}`);
                  }}
                  className="top-select"
                  style={{ width: 84 }}
                  title="选择流式注入切分粒度"
                >
                  <option value="char">字符 (char)</option>
                  <option value="word">词语 (word)</option>
                  <option value="line">整行 (line)</option>
                </select>
                <svg className="top-select-arrow" width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* 细分割线 */}
        <div className="top-bar-divider" />

        {/* 第二行：全量万行压测与多模态文档中心 */}
        <div className="top-bar-row">
          {/* 文档库选择与万行压测启动 */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div className="top-btn-group" title="选择文档载入或启动万行压测">
              <span className="top-control-label">文档库</span>
              <div className="top-select-wrapper">
                <select
                  data-testid="stress-target-select"
                  value={selectedStressDoc}
                  onChange={(e) => {
                    const docId = e.target.value;
                    setSelectedStressDoc(docId);
                    loadSingleDoc(docId);
                  }}
                  className="top-select"
                  style={{ maxWidth: 260 }}
                  title="选择进行万行压测或载入的文档界面"
                >
                  {SAMPLE_DOCS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
                <svg className="top-select-arrow" width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </div>
              <button
                type="button"
                data-testid="load-massive"
                onClick={() => loadMassiveDoc(selectedStressDoc)}
                className="top-btn-group-item"
                style={{ color: 'var(--brand)', fontWeight: 600 }}
                title="将所选文档按副本扩展至 10,000+ 行，深度检验 HeightMap 与虚拟滚动稳定性"
              >
                万行压测 ({((SAMPLE_DOCS_MAP.get(selectedStressDoc)?.linesCount || 188) * (SAMPLE_DOCS_MAP.get(selectedStressDoc)?.repeatCountFor10k || 100)).toLocaleString()}行)
              </button>
              <button
                type="button"
                data-testid="load-single"
                onClick={() => loadSingleDoc(selectedStressDoc)}
                className="top-btn-group-item"
                title="加载单篇文档原文（1×），进行完整排版阅读与就地编辑"
              >
                单篇全览
              </button>
              <button
                type="button"
                data-testid="clear-doc"
                onClick={clearDocument}
                className="top-btn-group-item"
                title="清空编辑器内容"
              >
                清空
              </button>
            </div>
          </div>

          {/* 右区：导出组 */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>导出:</span>
            <div className="top-btn-group">
              <button
                type="button"
                data-testid="export-md"
                onClick={() => exportDocument('markdown')}
                className="top-btn-group-item"
                title="导出 Markdown 原文"
              >
                MD
              </button>
              <button
                type="button"
                data-testid="export-html"
                onClick={() => exportDocument('html')}
                className="top-btn-group-item"
                title="导出 HTML 格式"
              >
                HTML
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 导出结果卡片 */}
      {exportPanel && (
        <div data-testid="export-panel" className="export-panel-card">
          <div className="export-panel-header">
            <div className="export-panel-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>
                导出 {exportPanel.kind === 'markdown' ? 'Markdown 原文' : 'HTML 静态富文本'}
              </span>
              <span className="status-bar-badge">
                {exportPanel.text.length.toLocaleString()} 字符
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(exportPanel.text).then(() => {
                    announce('已复制导出内容到剪贴板！', 'success');
                  }).catch(() => {
                    announce('剪贴板写入失败，请手动全选复制', 'warn');
                  });
                }}
                className="top-btn"
                style={{ color: 'var(--brand)', fontWeight: 600 }}
                title="复制导出文本到系统剪贴板"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>一键复制</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const ext = exportPanel.kind === 'markdown' ? 'md' : 'html';
                  const mime = exportPanel.kind === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8';
                  const blob = new Blob([exportPanel.text], { type: mime });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `conex-export-${Date.now()}.${ext}`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  announce(`已下载导出文件：${a.download}`, 'success');
                }}
                className="top-btn"
                title="下载为本地文件"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>下载文件</span>
              </button>
              <button
                type="button"
                data-testid="export-close"
                onClick={() => setExportPanel(null)}
                className="top-btn"
                title="关闭导出面板"
              >
                关闭
              </button>
            </div>
          </div>
          <textarea
            data-testid="export-output"
            readOnly
            value={exportPanel.text}
            rows={7}
            className="export-panel-textarea"
          />
        </div>
      )}

      {/* 全幅纯白画布（Alcove 口径：无纸张卡片，编辑器铺满内容区） */}
      <div
        className="grid-paper"
        style={{ width: '100%', flex: 1, minHeight: 0 }}
      >
        <MarkdownEngine ref={engineRef} />
        <ContextMenu />
      </div>

      {/* 悬浮轻量 Toast 提示 */}
      {toast && (
        <div className="conex-toast" role="status" aria-live="polite">
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor:
                toast.type === 'success'
                  ? 'hsl(142 60% 45%)'
                  : toast.type === 'warn'
                  ? 'hsl(38 92% 50%)'
                  : 'var(--brand)',
            }}
          />
          <span>{toast.message}</span>
        </div>
      )}

      {/* aria-live 播报（R-8：开始/完成/丢弃三态，视觉隐藏但可读） */}
      <div
        data-testid="stream-announce"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {announcement}
      </div>
    </div>
  );
}

export default App;
