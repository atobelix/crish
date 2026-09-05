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
type Granularity = 'char' | 'word' | 'line';

const GRANULARITY_OPTIONS: Granularity[] = ['char', 'word', 'line'];
const GRANULARITY_LABELS: Record<Granularity, string> = {
  char: '字符',
  word: '词语',
  line: '整行',
};

/** 可调 token 率档位（tps = tokens per second） */
const RATE_OPTIONS = [10, 50, 200, 500] as const;

// ── 预置演示内容（S-EL-12：展示流式全能力）──
// 中文 + Markdown 混合：标题/列表/表格/代码块/公式 + 纯文本行。
// 纯文本行（无 DIRECT_STREAM_FORBIDDEN_CHARS：`*#`[$|>_~<\]&` 与行首
// 模式）走 C3 直刷路径——驾驶舱演示与 e2e 直刷断言共用。
const DEMO_LINES: readonly string[] = [
  '# 流式渲染演示（AI 模拟输出）',
  '',
  '这是一段由模拟 LLM 逐 chunk 注入的演示正文，包含中文与 Markdown 混合语法，',
  '用于展示直刷路径、帧聚合缓冲、滚动跟随与完成收口等流式能力。',
  '',
  '## 功能列表',
  '',
  '- 直刷路径：纯文本行即时写入 DOM',
  '- 帧聚合：不可直刷 chunk 按帧批量提交',
  '- 滚动跟随：贴底自动跟随，上滚暂停',
  '- 软渲染预演：未闭合语法以预览样式呈现',
  '',
  '## 数据表格',
  '',
  '| 列A | 列B | 列C |',
  '|---|---|---|',
  '| 1 | 2 | 3 |',
  '| 4 | 5 | 6 |',
  '',
  '## 代码块示例',
  '',
  '```js',
  'function demo() {',
  '  return 42;',
  '}',
  '```',
  '',
  '## 公式示例',
  '',
  '$$',
  'x^2 + y^2 = r^2',
  '$$',
  '',
  '流式会话结束，内容完整落盘。',
];

const DEMO_CONTENT = DEMO_LINES.join('\n');

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

  /** aria-live 播报（清空再写，保证同文案可重复播报） */
  const announce = useCallback((text: string) => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

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

  /** 开始流式：清空文档 → 切 chunk → 按 token 率注入 */
  const startStreaming = useCallback(() => {
    silentlyEndSession();
    setText('');
    chunksRef.current = splitChunks(DEMO_CONTENT, granularity);
    posRef.current = 0;
    setExportPanel(null);
    setPhase('streaming');
    announce('AI 正在生成…');
    startTimer();
  }, [announce, granularity, setText, silentlyEndSession, startTimer]);

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

  /** 加载万行压力文档（既有静态加载能力保留） */
  const loadMassiveDoc = useCallback(() => {
    silentlyEndSession();
    setPhase('idle');
    setProgress('');
    setExportPanel(null);
    const chunks: string[] = [];
    chunks.push(
      `# 高性能 Markdown 渲染引擎全面压力测试\n\n> 当前渲染规模: 100 个副本。本测试用例文档已全面穷举，覆盖 Markdown 所有基础语法与极端解析场景。\n\n---\n`
    );
    for (let i = 0; i < 100; i++) {
      chunks.push(testDoc);
    }
    setText(chunks.join('\n'));
  }, [setText, silentlyEndSession]);

  /** 清空文档（静默结束旧会话） */
  const clearDocument = useCallback(() => {
    silentlyEndSession();
    setPhase('idle');
    setProgress('');
    setExportPanel(null);
    setText('');
  }, [setText, silentlyEndSession]);

  /** 点击循环切换模拟流式输出速率 (10 -> 50 -> 200 -> 500 -> 10) */
  const cycleRate = useCallback(() => {
    const idx = RATE_OPTIONS.indexOf(rate as any);
    const nextIdx = (idx + 1) % RATE_OPTIONS.length;
    const nextRate = RATE_OPTIONS[nextIdx];
    setRate(nextRate);
    rateRef.current = nextRate;
    announce(`流式速率已切换为 ${nextRate} tps`);
  }, [announce, rate]);

  /** 点击循环切换流式注入粒度 (字符 -> 词语 -> 整行 -> 字符) */
  const cycleGranularity = useCallback(() => {
    const idx = GRANULARITY_OPTIONS.indexOf(granularity);
    const nextIdx = (idx + 1) % GRANULARITY_OPTIONS.length;
    const nextGran = GRANULARITY_OPTIONS[nextIdx];
    setGranularity(nextGran);
    announce(`注入粒度已切换为 ${GRANULARITY_LABELS[nextGran]}`);
  }, [announce, granularity]);

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
        {/* 左区：Conex 品牌徽标与实时文档/流式状态 */}
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

        {/* 中区：高质感流式播放控制器 */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
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

        {/* 右区：速率粒度微调、预置用例与文档导出 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* 速率与粒度控制组（真实可点击 28px 按钮组 + 同步 select 保障 e2e 契约） */}
          <div className="top-btn-group" title="流式速率与切分粒度设置">
            <button
              type="button"
              onClick={cycleRate}
              className="top-btn-group-item"
              title={`点击切换输出速率 (当前: ${rate} tps，点击循环: 10 → 50 → 200 → 500)`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>{rate} tps</span>
              <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>▾</span>
            </button>
            <button
              type="button"
              onClick={cycleGranularity}
              className="top-btn-group-item"
              title={`点击切换注入粒度 (当前: ${GRANULARITY_LABELS[granularity]}，点击循环: 字符 → 词语 → 整行)`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 7V4h16v3M9 20h6M12 4v16" />
              </svg>
              <span>{GRANULARITY_LABELS[granularity]}</span>
              <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>▾</span>
            </button>
            {/* 隐藏 select 用于与 Playwright selectOption 契约无损对齐 */}
            <select
              data-testid="rate-select"
              value={rate}
              onChange={(e) => {
                const val = Number(e.target.value);
                setRate(val);
                rateRef.current = val;
              }}
              style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
            >
              {RATE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r} tps
                </option>
              ))}
            </select>
            <select
              data-testid="granularity-select"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
            >
              <option value="char">字符</option>
              <option value="word">词</option>
              <option value="line">行</option>
            </select>
          </div>

          <div style={{ width: 1, height: 16, background: 'var(--border-medium)' }} />

          {/* 预置文档管理组 */}
          <div className="top-btn-group">
            <button
              type="button"
              data-testid="load-massive"
              onClick={loadMassiveDoc}
              className="top-btn-group-item"
              title="加载万行压力测试文档（2301个标题、45万字）"
            >
              万行压测
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

          <div style={{ width: 1, height: 16, background: 'var(--border-medium)' }} />

          {/* 导出组 */}
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
      </header>

      {/* 导出结果面板 */}
      {exportPanel && (
        <div
          data-testid="export-panel"
          style={{
            width: 'min(840px, 94vw)',
            boxSizing: 'border-box',
            padding: '4px 12px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>
              导出 {exportPanel.kind === 'markdown' ? 'Markdown' : 'HTML'}（
              {exportPanel.text.length} 字符）
            </strong>
            <button
              type="button"
              data-testid="export-close"
              onClick={() => setExportPanel(null)}
              className="top-btn"
            >
              关闭
            </button>
          </div>
          <textarea
            data-testid="export-output"
            readOnly
            value={exportPanel.text}
            rows={6}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              resize: 'vertical',
            }}
          />
        </div>
      )}

      {/* 纸张（既有 grid-paper 布局保留） */}
      <div
        className="grid-paper"
        style={{ width: 'min(880px, 94vw)', height: 'min(calc(100vh - 108px), 940px)' }}
      >
        <MarkdownEngine ref={engineRef} />
        <ContextMenu />
      </div>

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
