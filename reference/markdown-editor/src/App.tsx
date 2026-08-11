import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useEditorStore } from './core/EditorStore';
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

/** 可调 token 率档位（tps = tokens per second） */
const RATE_OPTIONS = [10, 50, 200, 500] as const;

const PHASE_TEXT: Record<StreamPhase, string> = {
  idle: '空闲',
  streaming: '流式生成中',
  paused: '已暂停',
  done: '已完成',
  discarded: '已丢弃',
};

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

  // 注入计时器 ref（chunk 游标 + 会话起点 + 暂停补偿）
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<string[]>([]);
  const posRef = useRef(0);
  const sessionStartRef = useRef(0);
  const pausedAtRef = useRef(0);
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

  /** 时间戳驱动注入节拍（10ms tick；按目标 token 率校准发射量） */
  const tick = useCallback(() => {
    const now = performance.now();
    const elapsed = now - sessionStartRef.current;
    const target = Math.min(
      chunksRef.current.length,
      Math.floor((elapsed * rate) / 1000)
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
  }, [rate, stopTimer]);

  const startTimer = useCallback(() => {
    stopTimer();
    sessionStartRef.current = performance.now();
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
      {/* 驾驶舱工具栏 */}
      <div
        style={{
          width: 'min(840px, 94vw)',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          boxSizing: 'border-box',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}
      >
        <span style={{ fontWeight: 600 }}>流式驾驶舱</span>
        <button
          type="button"
          data-testid="stream-start"
          onClick={startStreaming}
          style={btnStyle}
        >
          开始流式
        </button>
        <button
          type="button"
          data-testid="stream-pause"
          onClick={pauseStreaming}
          disabled={phase !== 'streaming'}
          style={btnStyle}
        >
          暂停
        </button>
        <button
          type="button"
          data-testid="stream-resume"
          onClick={resumeStreaming}
          disabled={phase !== 'paused'}
          style={btnStyle}
        >
          继续
        </button>
        <button
          type="button"
          data-testid="stream-stop"
          onClick={stopStreaming}
          disabled={phase !== 'streaming' && phase !== 'paused'}
          style={btnStyle}
        >
          中断
        </button>
        <button
          type="button"
          data-testid="stream-discard"
          onClick={discardStreaming}
          disabled={phase !== 'streaming' && phase !== 'paused'}
          style={{ ...btnStyle, color: 'var(--danger-color)' }}
        >
          丢弃
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          速率
          <select
            data-testid="rate-select"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            style={selectStyle}
          >
            {RATE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r} tps
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          粒度
          <select
            data-testid="granularity-select"
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
            style={selectStyle}
          >
            <option value="char">字符</option>
            <option value="word">词</option>
            <option value="line">行</option>
          </select>
        </label>
        <button
          type="button"
          data-testid="export-md"
          onClick={() => exportDocument('markdown')}
          style={btnStyle}
        >
          导出 Markdown
        </button>
        <button
          type="button"
          data-testid="export-html"
          onClick={() => exportDocument('html')}
          style={btnStyle}
        >
          导出 HTML
        </button>
        <button
          type="button"
          data-testid="load-massive"
          onClick={loadMassiveDoc}
          style={btnStyle}
        >
          加载万行压力文档
        </button>
        <button
          type="button"
          data-testid="clear-doc"
          onClick={clearDocument}
          style={btnStyle}
        >
          清空
        </button>
        <span data-testid="stream-status" data-phase={phase}>
          {PHASE_TEXT[phase]}
          {progress ? ` · 已注入 ${progress}` : ''}
          {streamSummary ? ` · ${streamSummary}` : ''} · 文档 {textLength} 字符
        </span>
      </div>

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
              style={btnStyle}
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
        style={{ height: 'min(calc(100vh - 96px), 880px)' }}
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

const btnStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '2px 8px',
  cursor: 'pointer',
  borderRadius: 4,
  border: '1px solid var(--border-medium)',
  background: 'var(--white)',
  color: 'var(--text-primary)',
};

const selectStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

export default App;
