<<<<<<< Updated upstream
import {
  runStressTest,
  SeededRandom,
  type StressScenario,
  type InvariantCheck,
} from './stress-runner';
=======
import { runStressTest, SeededRandom, type StressScenario, type InvariantCheck } from "./stress-runner";
>>>>>>> Stashed changes
// 真实生产模块（PS-02 T2.3 重写：原实现仅 JSON.stringify 自嗨，零产品接触）
import {
  rankSessionsBySearch,
  matchSessionSearch,
  makeSearchSnippet,
  normalizeSearchQuery,
  type RankedSessionHit,
<<<<<<< Updated upstream
} from '../../apps/crish-desktop/src/api/sessionSearch';
=======
} from "../../apps/crish-desktop/src/api/sessionSearch";
>>>>>>> Stashed changes
import {
  deriveSessionTitle,
  sanitizeSessionTitleText,
  isDefaultSessionTitle,
  prepareSessionsForUi,
<<<<<<< Updated upstream
} from '../../apps/crish-desktop/src/api/sessionTitle';
import type { SessionState } from '../../apps/crish-desktop/src/store/types';
=======
} from "../../apps/crish-desktop/src/api/sessionTitle";
import type { SessionState } from "../../apps/crish-desktop/src/store/types";
>>>>>>> Stashed changes

// 独立基线说明（审计留痕）：不变式"索引命中集与暴力搜索一致"的暴力搜索
// 为本文件的独立 oracle（简单 NFKC+lower+空白折叠），与生产实现的
// foldSearchText 在纯 ASCII+CJK 语料域内等价（语料不注入不可见字符/全角空白，
// 避免两个规范化实现域外分叉造成假红）。

/** 语料字符集：ASCII + CJK（无不可见字符、无全角空白——保证 oracle 等价域） */
<<<<<<< Updated upstream
const CORPUS_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 中文会话搜索测试缓存优化引擎批处理任务';
const QUERY_WORDS = [
  'cache',
  'stream',
  'session',
  'search',
  'diff',
  'merge',
  'batch',
  '渲染',
  '会话',
  '搜索',
  '缓存',
  '优化',
  '引擎',
  '任务',
  '批处理',
  '测试',
  '聊天',
=======
const CORPUS_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 中文会话搜索测试缓存优化引擎批处理任务";
const QUERY_WORDS = [
  "cache", "stream", "session", "search", "diff", "merge", "batch",
  "渲染", "会话", "搜索", "缓存", "优化", "引擎", "任务", "批处理", "测试", "聊天",
>>>>>>> Stashed changes
];

interface SessionRunState {
  rng: SeededRandom;
  corpus: SessionState[];
  totalOps: number;
  totalQueries: number;
  totalSessionsScanned: number;
  failures: number;
  failSamples: string[];
}

// 语料规模 22.5k 消息（数万消息）：rank×2 + 独立 oracle 全量扫描的单 op 成本
// 约 200-400ms（机器负载下 p95 波动 <2.2x）。更大的语料会让 op 时长 ~1s+，
// 延迟阈值在共享机器上必然 flaky（F10-13 教训），30% 余量无法覆盖——折衷取
// 本规模：op 更细、op 数更多（每 op 仍全量扫描 22.5k 消息），阈值余量可控。
const SESSIONS = 150;
const MESSAGES_PER_SESSION = 150;

function makeText(rng: SeededRandom, minLen: number, maxLen: number): string {
<<<<<<< Updated upstream
  let text = '';
=======
  let text = "";
>>>>>>> Stashed changes
  const len = rng.nextIntRange(minLen, maxLen);
  for (let i = 0; i < len; i++) {
    text += CORPUS_CHARS[rng.nextInt(CORPUS_CHARS.length)];
  }
  return text;
}

/** 独立 oracle：纯 ASCII+CJK 域内与生产 foldSearchText 等价的简单规范化 */
function oracleFold(s: string | null | undefined): string {
<<<<<<< Updated upstream
  const t = s ?? '';
  return t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function oracleTokens(query: string): string[] {
  return oracleFold(query).split(' ').filter(Boolean);
=======
  const t = s ?? "";
  return t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function oracleTokens(query: string): string[] {
  return oracleFold(query).split(" ").filter(Boolean);
>>>>>>> Stashed changes
}

/** 独立暴力搜索：任一字段包含全部 token 即命中。
 *  corpus 不可变，字段折叠结果按 session 缓存一次（暴力基线仍为独立逻辑：
 *  逐查询全量扫描 token includes；折叠缓存只消除重复的 NFKC 规范化成本，
 *  防止 oracle 自身耗时主导 op 时长、掩盖生产侧回归）。 */
const oracleFoldCache = new Map<string, string[]>();

function oracleSessionMatch(session: SessionState, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  let folded = oracleFoldCache.get(session.id);
  if (!folded) {
    const fields: string[] = [session.title, session.folder];
    for (const m of session.messages || []) {
      if (!m) continue;
<<<<<<< Updated upstream
      fields.push(m.text ?? '', m.thinking ?? '');
      for (const b of m.blocks || []) {
        if (b && b.type === 'text') fields.push(String(b.content ?? ''));
      }
      for (const tc of m.toolCalls || []) {
        if (!tc) continue;
        fields.push(
          tc.name ?? '',
          tc.arguments ?? '',
          tc.output ?? '',
          tc.explanation ?? ''
        );
=======
      fields.push(m.text ?? "", m.thinking ?? "");
      for (const b of m.blocks || []) {
        if (b && b.type === "text") fields.push(String(b.content ?? ""));
      }
      for (const tc of m.toolCalls || []) {
        if (!tc) continue;
        fields.push(tc.name ?? "", tc.arguments ?? "", tc.output ?? "", tc.explanation ?? "");
>>>>>>> Stashed changes
      }
    }
    for (const ag of session.agents || []) {
      if (!ag) continue;
<<<<<<< Updated upstream
      fields.push(ag.description ?? '', ag.summary ?? '', ag.mode ?? '');
      for (const m of ag.messages || []) {
        if (!m) continue;
        fields.push(m.text ?? '', m.thinking ?? '');
=======
      fields.push(ag.description ?? "", ag.summary ?? "", ag.mode ?? "");
      for (const m of ag.messages || []) {
        if (!m) continue;
        fields.push(m.text ?? "", m.thinking ?? "");
>>>>>>> Stashed changes
      }
    }
    folded = fields.map(oracleFold);
    oracleFoldCache.set(session.id, folded);
  }
  return folded.some((h) => tokens.every((t) => h.includes(t)));
}

/** 独立排序规则校验：score ↓ → hitCount ↓ → titleMatch 优先 → id asc（契约 comparator） */
function orderViolations(ranked: RankedSessionHit[]): string[] {
  const violations: string[] = [];
  for (let i = 1; i < ranked.length; i++) {
    const a = ranked[i - 1]!;
    const b = ranked[i]!;
    const worse =
      b.match.score > a.match.score ||
<<<<<<< Updated upstream
      (b.match.score === a.match.score &&
        b.match.hitCount > a.match.hitCount) ||
=======
      (b.match.score === a.match.score && b.match.hitCount > a.match.hitCount) ||
>>>>>>> Stashed changes
      (b.match.score === a.match.score &&
        b.match.hitCount === a.match.hitCount &&
        (b.match.titleMatch ? 1 : 0) > (a.match.titleMatch ? 1 : 0)) ||
      (b.match.score === a.match.score &&
        b.match.hitCount === a.match.hitCount &&
        (b.match.titleMatch ? 1 : 0) === (a.match.titleMatch ? 1 : 0) &&
<<<<<<< Updated upstream
        (b.session.id || '').localeCompare(a.session.id || '') < 0);
=======
        (b.session.id || "").localeCompare(a.session.id || "") < 0);
>>>>>>> Stashed changes
    if (worse) {
      violations.push(`排序违反契约 comparator（位置 ${i - 1} → ${i}）`);
      return violations;
    }
  }
  return violations;
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDFFF])[\uDC00-\uDFFF]/g;

/** 摘录/标题码点安全校验 */
function snippetViolations(rng: SeededRandom, session: SessionState): string[] {
  const violations: string[] = [];
<<<<<<< Updated upstream
  const sampleTexts = [
    session.title,
    ...(session.messages || []).slice(0, 5).map((m) => m.text ?? ''),
  ];
=======
  const sampleTexts = [session.title, ...(session.messages || []).slice(0, 5).map((m) => m.text ?? "")];
>>>>>>> Stashed changes
  for (const text of sampleTexts) {
    if (!text) continue;
    const snip = makeSearchSnippet(text, rng.pick(QUERY_WORDS));
    const cpLen = Array.from(snip).length;
    if (cpLen > 72) violations.push(`摘录码点数 ${cpLen} > 72`);
<<<<<<< Updated upstream
    if (snip.includes('\uFFFD')) violations.push('摘录含 U+FFFD');
    if (LONE_SURROGATE.test(snip)) violations.push('摘录含孤立代理对');
=======
    if (snip.includes("\uFFFD")) violations.push("摘录含 U+FFFD");
    if (LONE_SURROGATE.test(snip)) violations.push("摘录含孤立代理对");
>>>>>>> Stashed changes
  }
  return violations;
}

/** 标题推导不变式（sessionTitle 面） */
function titleViolations(): string[] {
  const violations: string[] = [];
<<<<<<< Updated upstream
  if (!isDefaultSessionTitle('新会话'))
    violations.push("isDefaultSessionTitle('新会话') 应为 true");
  if (isDefaultSessionTitle('缓存优化方案'))
    violations.push('真实标题被误判为默认');
  const derived = deriveSessionTitle('  /help 缓存优化 的 详细 方案 ');
  if (Array.from(derived).length > 28)
    violations.push(`derive 截断超限: ${derived}`);
  if (derived.includes('/'))
    violations.push(`derive 未剥离 slash 命令: ${derived}`);
  const cleaned = sanitizeSessionTitleText('\u200B缓存\u200B优化\n方案');
  if (cleaned !== '缓存优化 方案')
    violations.push(`sanitize 未折叠空白/剥零宽: "${cleaned}"`);

  // prepareSessionsForUi：默认标题空壳（无实质消息）应被 prune
  const shells = [
    {
      id: 'shell-1',
      title: '新会话',
      folder: '',
      isPinned: false,
      isArchived: false,
      messages: [],
      agents: [],
    },
    {
      id: 'real-1',
      title: '真实会话',
      folder: '',
      isPinned: false,
      isArchived: false,
      messages: [
        { id: 'm1', sender: 'user' as const, text: 'hi', timestamp: 1 },
      ],
      agents: [],
    },
  ];
  const pruned = prepareSessionsForUi(
    shells as unknown as (SessionState & { id: string })[],
    'real-1'
  );
  const prunedIds = pruned.map((s) => s.id);
  if (!prunedIds.includes('real-1'))
    violations.push('prepareSessionsForUi 误剪真实会话');
  if (prunedIds.includes('shell-1'))
    violations.push('prepareSessionsForUi 未剪默认标题空壳');
=======
  if (!isDefaultSessionTitle("新会话")) violations.push("isDefaultSessionTitle('新会话') 应为 true");
  if (isDefaultSessionTitle("缓存优化方案")) violations.push("真实标题被误判为默认");
  const derived = deriveSessionTitle("  /help 缓存优化 的 详细 方案 ");
  if (Array.from(derived).length > 28) violations.push(`derive 截断超限: ${derived}`);
  if (derived.includes("/")) violations.push(`derive 未剥离 slash 命令: ${derived}`);
  const cleaned = sanitizeSessionTitleText("\u200B缓存\u200B优化\n方案");
  if (cleaned !== "缓存优化 方案") violations.push(`sanitize 未折叠空白/剥零宽: "${cleaned}"`);

  // prepareSessionsForUi：默认标题空壳（无实质消息）应被 prune
  const shells = [
    { id: "shell-1", title: "新会话", folder: "", isPinned: false, isArchived: false, messages: [], agents: [] },
    { id: "real-1", title: "真实会话", folder: "", isPinned: false, isArchived: false, messages: [{ id: "m1", sender: "user" as const, text: "hi", timestamp: 1 }], agents: [] },
  ];
  const pruned = prepareSessionsForUi(shells as unknown as (SessionState & { id: string })[], "real-1");
  const prunedIds = pruned.map((s) => s.id);
  if (!prunedIds.includes("real-1")) violations.push("prepareSessionsForUi 误剪真实会话");
  if (prunedIds.includes("shell-1")) violations.push("prepareSessionsForUi 未剪默认标题空壳");
>>>>>>> Stashed changes
  return violations;
}

function buildCorpus(rng: SeededRandom): SessionState[] {
  const corpus: SessionState[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const messages = [];
    for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
<<<<<<< Updated upstream
      const sender = m % 2 === 0 ? 'user' : 'assistant';
=======
      const sender = m % 2 === 0 ? "user" : "assistant";
>>>>>>> Stashed changes
      messages.push({
        id: `msg-${s}-${m}`,
        sender,
        text: makeText(rng, 10, 60),
        timestamp: 1_700_000_000_000 + m * 1000,
        ...(m % 7 === 0
<<<<<<< Updated upstream
          ? {
              toolCalls: [
                {
                  id: `tc-${s}-${m}`,
                  name: rng.pick(['read_file', 'write_file', 'search']),
                  arguments: makeText(rng, 8, 20),
                  status: 'success' as const,
                },
              ],
            }
=======
          ? { toolCalls: [{ id: `tc-${s}-${m}`, name: rng.pick(["read_file", "write_file", "search"]), arguments: makeText(rng, 8, 20), status: "success" as const }] }
>>>>>>> Stashed changes
          : {}),
      });
    }
    corpus.push({
      id: `session-${s}`,
      title: `${rng.pick(QUERY_WORDS)} ${rng.nextIntRange(1, 999)} 方案`,
      folder: `folder-${rng.nextIntRange(0, 10)}`,
      isPinned: s % 50 === 0,
      isArchived: false,
      messages,
<<<<<<< Updated upstream
      agents:
        s % 5 === 0
          ? [
              {
                id: `agent-${s}`,
                subagentRunId: `run-${s}`,
                parentSessionId: `session-${s}`,
                parentRunId: 'run-0',
                description: makeText(rng, 8, 24),
                mode: rng.pick(['explore', 'implement']),
                status: 'completed' as const,
                summary: s % 10 === 0 ? makeText(rng, 8, 24) : undefined,
                messages: [],
              },
            ]
          : [],
=======
      agents: s % 5 === 0
        ? [{
            id: `agent-${s}`,
            subagentRunId: `run-${s}`,
            parentSessionId: `session-${s}`,
            parentRunId: "run-0",
            description: makeText(rng, 8, 24),
            mode: rng.pick(["explore", "implement"]),
            status: "completed" as const,
            summary: s % 10 === 0 ? makeText(rng, 8, 24) : undefined,
            messages: [],
          }]
        : [],
>>>>>>> Stashed changes
    });
  }
  return corpus;
}

<<<<<<< Updated upstream
function* sessionSwitchScenario(
  state: SessionRunState
): Generator<() => Promise<unknown>> {
=======
function* sessionSwitchScenario(state: SessionRunState): Generator<() => Promise<unknown>> {
>>>>>>> Stashed changes
  const { rng, corpus } = state;
  while (true) {
    yield async () => {
      // 查询池：单 token / 多 token AND / CJK / 空查询（全命中语义）
      const nTokens = rng.nextInt(4);
<<<<<<< Updated upstream
      const query =
        nTokens === 0
          ? ''
          : Array.from({ length: nTokens }, () => rng.pick(QUERY_WORDS)).join(
              ' '
            );
=======
      const query = nTokens === 0 ? "" : Array.from({ length: nTokens }, () => rng.pick(QUERY_WORDS)).join(" ");
>>>>>>> Stashed changes
      const tokens = oracleTokens(query);

      const ranked = rankSessionsBySearch(corpus, query);
      const rankedIds = ranked.map((h) => h.session.id);

      // 不变式 1：索引命中集与暴力搜索一致
<<<<<<< Updated upstream
      const expectedIds = corpus
        .filter((s) => oracleSessionMatch(s, tokens))
        .map((s) => s.id);
      const actualSet = new Set(rankedIds);
      const expectedSet = new Set(expectedIds);
      let mismatch = false;
      for (const id of actualSet)
        if (!expectedSet.has(id)) {
          mismatch = true;
          break;
        }
      if (!mismatch)
        for (const id of expectedSet)
          if (!actualSet.has(id)) {
            mismatch = true;
            break;
          }
      if (mismatch || actualSet.size !== expectedSet.size) {
        state.failures++;
        if (state.failSamples.length < 20) {
          state.failSamples.push(
            `查询 "${query}": 命中集与暴力搜索不一致 (${actualSet.size} vs ${expectedSet.size})`
          );
=======
      const expectedIds = corpus.filter((s) => oracleSessionMatch(s, tokens)).map((s) => s.id);
      const actualSet = new Set(rankedIds);
      const expectedSet = new Set(expectedIds);
      let mismatch = false;
      for (const id of actualSet) if (!expectedSet.has(id)) { mismatch = true; break; }
      if (!mismatch) for (const id of expectedSet) if (!actualSet.has(id)) { mismatch = true; break; }
      if (mismatch || actualSet.size !== expectedSet.size) {
        state.failures++;
        if (state.failSamples.length < 20) {
          state.failSamples.push(`查询 "${query}": 命中集与暴力搜索不一致 (${actualSet.size} vs ${expectedSet.size})`);
>>>>>>> Stashed changes
        }
      }

      // 不变式 2：排序稳定且符合契约 comparator（空查询例外——契约语义为原序
<<<<<<< Updated upstream
      // 包装全命中，见 rankSessionsBySearch 文档注释，原序即断言目标）。
      // 稳定性采样 1/3 op：rankSessionsBySearch 是纯函数，确定性一次即可证明；
      // 采样是为控制共享机器上单 op 时长（第二遍 rank ≈ 全量扫描成本），
      // 1/3 采样下 15s 内仍有 30+ 次稳定性判定覆盖。
      const ranked2 =
        state.totalOps % 3 === 0 ? rankSessionsBySearch(corpus, query) : null;
      const ids2 = ranked2 ? ranked2.map((h) => h.session.id) : null;
      if (ids2 && rankedIds.join('|') !== ids2.join('|')) {
        state.failures++;
        if (state.failSamples.length < 20)
          state.failSamples.push(
            `查询 "${query}": 两次排序结果不一致（不稳定）`
          );
      }
      if (query === '') {
        const corpusIds = corpus.map((s) => s.id);
        if (rankedIds.join('|') !== corpusIds.join('|')) {
          state.failures++;
          if (state.failSamples.length < 20)
            state.failSamples.push('空查询未按语料原序返回');
=======
      // 包装全命中，见 rankSessionsBySearch 文档注释，原序即断言目标）
      const ranked2 = rankSessionsBySearch(corpus, query);
      const ids2 = ranked2.map((h) => h.session.id);
      if (rankedIds.join("|") !== ids2.join("|")) {
        state.failures++;
        if (state.failSamples.length < 20) state.failSamples.push(`查询 "${query}": 两次排序结果不一致（不稳定）`);
      }
      if (query === "") {
        const corpusIds = corpus.map((s) => s.id);
        if (rankedIds.join("|") !== corpusIds.join("|")) {
          state.failures++;
          if (state.failSamples.length < 20) state.failSamples.push("空查询未按语料原序返回");
>>>>>>> Stashed changes
        }
      } else {
        for (const v of orderViolations(ranked)) {
          state.failures++;
<<<<<<< Updated upstream
          if (state.failSamples.length < 20)
            state.failSamples.push(`查询 "${query}": ${v}`);
=======
          if (state.failSamples.length < 20) state.failSamples.push(`查询 "${query}": ${v}`);
>>>>>>> Stashed changes
        }
      }

      // 不变式 3：空查询语义（全命中、score 0）
<<<<<<< Updated upstream
      if (query === '') {
        if (
          ranked.length !== corpus.length ||
          ranked.some((h) => h.match.score !== 0)
        ) {
          state.failures++;
          if (state.failSamples.length < 20)
            state.failSamples.push('空查询未全命中或 score 非 0');
=======
      if (query === "") {
        if (ranked.length !== corpus.length || ranked.some((h) => h.match.score !== 0)) {
          state.failures++;
          if (state.failSamples.length < 20) state.failSamples.push("空查询未全命中或 score 非 0");
>>>>>>> Stashed changes
        }
      }

      // 不变式 4：top 命中摘录码点安全
      for (const hit of ranked.slice(0, 5)) {
        for (const v of snippetViolations(rng, hit.session)) {
          state.failures++;
          if (state.failSamples.length < 20) state.failSamples.push(v);
        }
      }

      // 不变式 5：matchSessionSearch 与 rank 结果自洽（rank 输出 score 源函数；
      // 仅在 rank 非空时抽查——空命中时无 probe 可验，命中集一致已由不变式 1 覆盖）
      if (ranked.length > 0) {
        const probe = rng.pick(ranked);
        const m = matchSessionSearch(probe.session, query);
        if (m.match !== true || m.score !== probe.match.score) {
          state.failures++;
<<<<<<< Updated upstream
          if (state.failSamples.length < 20)
            state.failSamples.push(
              `matchSessionSearch 与 rank 结果不一致: ${query}`
            );
=======
          if (state.failSamples.length < 20) state.failSamples.push(`matchSessionSearch 与 rank 结果不一致: ${query}`);
>>>>>>> Stashed changes
        }
      }

      // 标题不变式（每 8 个 op 抽查一次，防长尾成本）
      if (state.totalOps % 8 === 0) {
        for (const v of titleViolations()) {
          state.failures++;
          if (state.failSamples.length < 20) state.failSamples.push(v);
        }
      }

      state.totalOps++;
      state.totalQueries++;
      state.totalSessionsScanned += ranked.length;
      void normalizeSearchQuery;
    };
  }
}

function verifySessionSwitch(state: SessionRunState): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  if (state.totalOps === 0) {
<<<<<<< Updated upstream
    return [{ ok: false, message: '0 次查询被执行（空跑）' }];
=======
    return [{ ok: false, message: "0 次查询被执行（空跑）" }];
>>>>>>> Stashed changes
  }
  checks.push({
    ok: state.failures === 0,
    message: `全部查询不变式通过（${state.totalOps} ops / ${state.totalSessionsScanned} 会话扫描, 失败 ${state.failures}）`,
  });
  for (const sample of state.failSamples) {
    checks.push({ ok: false, message: `失败样例: ${sample}` });
  }
  return checks;
}

function createSessionRunState(): SessionRunState {
  const rng = new SeededRandom(11);
  return {
    rng,
    corpus: buildCorpus(rng),
    totalOps: 0,
    totalQueries: 0,
    totalSessionsScanned: 0,
    failures: 0,
    failSamples: [],
  };
}

const sessionRunState = createSessionRunState();

export const SESSION_SWITCH_STRESS: StressScenario = {
<<<<<<< Updated upstream
  name: 'rapid.session.search.and.rank',
=======
  name: "rapid.session.search.and.rank",
>>>>>>> Stashed changes
  duration: 15_000,
  concurrency: 4,
  seed: 11,
  modules: [
<<<<<<< Updated upstream
    'api/sessionSearch.rankSessionsBySearch',
    'api/sessionSearch.matchSessionSearch',
    'api/sessionSearch.makeSearchSnippet',
    'api/sessionTitle.deriveSessionTitle',
    'api/sessionTitle.prepareSessionsForUi',
=======
    "api/sessionSearch.rankSessionsBySearch",
    "api/sessionSearch.matchSessionSearch",
    "api/sessionSearch.makeSearchSnippet",
    "api/sessionTitle.deriveSessionTitle",
    "api/sessionTitle.prepareSessionsForUi",
>>>>>>> Stashed changes
  ],
  scenario: () => sessionSwitchScenario(sessionRunState),
  verify: () => verifySessionSwitch(sessionRunState),
  expectedErrorRate: 0.01,
  expected: {
    // 阈值按实测基线设定并留 ≥30% 余量（F10-13 flaky 教训）：
    //   22.5k 消息语料（150×150）+ 双 rank + 独立 oracle 全量扫描
<<<<<<< Updated upstream
    //   多轮实测最差观测（共享机器负载下）：avg ops/sec 8.0 / p95 870ms /
    //   p99 1325ms / 内存 53MB → 阈值 5 / 1200 / 1800 / 70MB（余量 ≥30%）
    //   不变式是精确门禁（注入 bug 必红，R7 已验证）；性能阈值是粗粒度回归
    //   探测器（3x+ 回归或全挂必红；F10-13 flaky 教训：共享机器余量宁大勿小）
    ops: { min: 5 },
    memory: { maxHeap: 70 * 1024 * 1024 },
    latency: { p95: 1200, p99: 1800 },
=======
    //   多轮实测最差观测：avg ops/sec 10.1 / p95 505ms / p99 661ms / 内存 32MB
    //   → 阈值 7 / 700 / 900 / 50MB（余量 ≥30%）
    //   2x 生产回归即可触发（avg < 7 或 p95 > 700）
    ops: { min: 7 },
    memory: { maxHeap: 50 * 1024 * 1024 },
    latency: { p95: 700, p99: 900 },
>>>>>>> Stashed changes
  },
};

const isMain = process.argv[1]?.endsWith('stress-session-switch.ts');
if (isMain) {
  runStressTest(SESSION_SWITCH_STRESS).then((result) =>
    process.exit(result.passed ? 0 : 1)
  );
}
