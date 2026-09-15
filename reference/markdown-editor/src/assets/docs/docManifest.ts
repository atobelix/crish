// reference/markdown-editor/src/assets/docs/docManifest.ts
// 样本素材库与全量万行压测/多篇流式调度中心
// 统一管理 7 大领域生产级 Markdown 文档，支持：
// 1. 任意文档独立查看 / 原文编辑
// 2. 任意文档扩展为 10,000+ 行深度万行压测
// 3. 流式 AI 模拟输出：支持单篇独立流式，以及多篇连续无缝流式输出

import doc00Raw from '../test-document.md?raw';
import doc01Raw from './01-architecture-engineering.md?raw';
import doc02Raw from './02-math-academic.md?raw';
import doc03Raw from './03-complex-tables.md?raw';
import doc04Raw from './04-pkm-interactive.md?raw';
import doc05Raw from './05-ai-streaming-consult.md?raw';
import doc06Raw from './06-edge-cases.md?raw';
import doc07Raw from './07-all-in-one-mega.md?raw';

export interface MarkdownSampleDoc {
  id: string;
  title: string;
  shortTitle: string;
  category: 'baseline' | 'engineering' | 'math' | 'tables' | 'pkm' | 'streaming' | 'edge' | 'all';
  badge: string;
  description: string;
  content: string;
  linesCount: number;
  /** 计算达到 10,000+ 行压测所需的默认重复副本数 */
  repeatCountFor10k: number;
}

export interface MultiStreamPreset {
  id: string;
  title: string;
  shortTitle: string;
  description: string;
  docIds: string[];
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

export const SAMPLE_DOCS: readonly MarkdownSampleDoc[] = [
  {
    id: '05-streaming',
    title: '05 · AI 架构咨询流式剧本（高并发推送引擎方案）',
    shortTitle: 'AI 咨询剧本',
    category: 'streaming',
    badge: '流式首选',
    description: '工业级高并发推送引擎架构咨询；覆盖 C3 直刷、帧聚合、KaTeX 动态公式、表格锁宽、Rust/JSON 专用高亮与交互清单。',
    content: doc05Raw,
    linesCount: countLines(doc05Raw),
    repeatCountFor10k: 60, // 178 × 60 ≈ 10,680 行
  },
  {
    id: '01-engineering',
    title: '01 · 计算机工程与系统架构（分布式共识与异步内核）',
    shortTitle: '系统工程架构',
    category: 'engineering',
    badge: '硬核系统',
    description: 'Multi-Raft 状态机复制、Rust Tokio 工作窃取运行时、WebGPU WGSL 着色器、LSM-Tree 存储引擎与 io_uring。',
    content: doc01Raw,
    linesCount: countLines(doc01Raw),
    repeatCountFor10k: 20, // 579 × 20 ≈ 11,580 行
  },
  {
    id: '02-math',
    title: '02 · 高等数理与学术论文（量子力学与流体力学）',
    shortTitle: '数理学术论文',
    category: 'math',
    badge: '高密数学',
    description: '薛定谔方程狄拉克符号、爱因斯坦场方程、Navier-Stokes 方程、Transformer 多头注意力对齐矩阵与多段学术脚注。',
    content: doc02Raw,
    linesCount: countLines(doc02Raw),
    repeatCountFor10k: 15, // 724 × 15 ≈ 10,860 行
  },
  {
    id: '03-tables',
    title: '03 · 企业级复杂报表与矩阵（超宽多行与转义管道）',
    shortTitle: '企业复杂报表',
    category: 'tables',
    badge: '复杂表格',
    description: '10 列超宽微服务 API 字典、跨地域数据库延迟矩阵、IFRS 财报损益表；含 <br> 换行单元格与转义管道符 \\|。',
    content: doc03Raw,
    linesCount: countLines(doc03Raw),
    repeatCountFor10k: 40, // 288 × 40 ≈ 11,520 行
  },
  {
    id: '04-pkm',
    title: '04 · 知识管理与交互看板（敏捷任务与发丝导线）',
    shortTitle: '知识交互看板',
    category: 'pkm',
    badge: '敏捷看板',
    description: 'Sprint 迭代看板、PRD 规格路线图、P0 故障复盘、双链卡片；1~4 级嵌套任务、||剧透黑条||与 ==高亮文本==。',
    content: doc04Raw,
    linesCount: countLines(doc04Raw),
    repeatCountFor10k: 35, // 328 × 35 ≈ 11,480 行
  },
  {
    id: '06-edge',
    title: '06 · CommonMark 边缘语法与极限防御（深水区测试）',
    shortTitle: '边缘安全防御',
    category: 'edge',
    badge: '极端边界',
    description: '闭合 ATX 标题、缩进代码剥离（CM §4.5）、行内交错未闭合预演、1024 字符无空格长行折行与稀疏分隔线。',
    content: doc06Raw,
    linesCount: countLines(doc06Raw),
    repeatCountFor10k: 15, // 885 × 15 ≈ 13,275 行
  },
  {
    id: '00-baseline',
    title: '00 · 综合语法与物理测量基础基线（原厂标准集）',
    shortTitle: '基础综合基线',
    category: 'baseline',
    badge: '标准基线',
    description: '11 个核心测试章节，覆盖标题、列表、富文本、表格、代码围栏、公式、按键与 21 个物理测量断言用例。',
    content: doc00Raw,
    linesCount: countLines(doc00Raw),
    repeatCountFor10k: 100, // 188 × 100 ≈ 18,800 行
  },
  {
    id: '07-mega',
    title: '07 · 全模态超级全集融合（3200行大满贯全场景）',
    shortTitle: '全模态超级全集',
    category: 'all',
    badge: '全场景融合',
    description: '全面融合上述全部 7 大篇章构成的超大规模基准文档（3,210 行），展现引擎全场景极限渲染性能。',
    content: doc07Raw,
    linesCount: countLines(doc07Raw),
    repeatCountFor10k: 5, // 3,210 × 5 ≈ 16,050 行
  },
];

export const SAMPLE_DOCS_MAP = new Map<string, MarkdownSampleDoc>(
  SAMPLE_DOCS.map((d) => [d.id, d])
);

export const MULTI_STREAM_PRESETS: readonly MultiStreamPreset[] = [
  {
    id: 'multi-triad',
    title: '核心技术三部曲：系统架构 + 数理学术 + 企业报表',
    shortTitle: '三部曲连跑',
    description: '连续流式渲染系统架构（01）、数理学术（02）与复杂报表（03），验证高负载多组件流式演进稳定度。',
    docIds: ['01-engineering', '02-math', '03-tables'],
  },
  {
    id: 'multi-interactive',
    title: '交互与极限防御组：敏捷看板 + 边缘语法 + AI 剧本',
    shortTitle: '交互极限连跑',
    description: '连续流式渲染知识看板（04）、边缘用例（06）与 AI 推送剧本（05），验证动态任务项与边界语法稳定性。',
    docIds: ['04-pkm', '06-edge', '05-streaming'],
  },
  {
    id: 'multi-all',
    title: '全模态大满贯：全部 6 大专业篇章连续流式输出',
    shortTitle: '全篇大满贯连跑',
    description: '从 AI 剧本、系统工程、数理论文、企业报表、敏捷看板到边缘防御，一气呵成全量连续流式渲染！',
    docIds: ['05-streaming', '01-engineering', '02-math', '03-tables', '04-pkm', '06-edge'],
  },
];

/** 生成指定文档的万行压测内容（达到 10,000+ 行） */
export function buildStressTestContent(docId: string): string {
  const doc = SAMPLE_DOCS_MAP.get(docId) ?? SAMPLE_DOCS[0];
  const repeat = doc.repeatCountFor10k;
  const totalEstimatedLines = doc.linesCount * repeat;

  const chunks: string[] = [];
  chunks.push(
    `# 高性能 Markdown 渲染引擎全面压力测试：${doc.title}\n\n` +
    `> **压测规模**：${repeat} 个副本，约 ${totalEstimatedLines.toLocaleString()} 行，` +
    `预计字符数约 ${(doc.content.length * repeat / 10000).toFixed(1)} 万字。\n` +
    `> **核心压测特性**：${doc.description}\n` +
    `> **测试目的**：验证虚拟滚动行高映射树（HeightMap）、视口滚动锚定（Scroll Anchoring）与 28px 垂直网格几何守恒。\n\n` +
    `---\n`
  );

  for (let i = 0; i < repeat; i++) {
    chunks.push(`\n<!-- 压测副本批次 ${i + 1}/${repeat} -->\n`);
    chunks.push(doc.content);
  }

  return chunks.join('\n');
}

/** 获取流式渲染文本（单篇或多篇预设组合） */
export function buildStreamingContent(targetId: string): {
  content: string;
  title: string;
  lines: string[];
} {
  // 检查是否为多篇连跑预设
  const preset = MULTI_STREAM_PRESETS.find((p) => p.id === targetId);
  if (preset) {
    const parts: string[] = [];
    parts.push(
      `# 流式渲染演示（AI 模拟输出）：多篇全流程渲染测试 —— ${preset.shortTitle}\n\n` +
      `> 本次流式测试由多个核心领域专业篇章连续无缝注入，全面压测引擎连续状态机平稳度与内存收敛。\n` +
      `> 包含篇章：${preset.docIds.map((id) => SAMPLE_DOCS_MAP.get(id)?.shortTitle).filter(Boolean).join(' → ')}。\n`
    );

    for (const docId of preset.docIds) {
      const doc = SAMPLE_DOCS_MAP.get(docId);
      if (!doc) continue;
      parts.push(`\n---\n\n<!-- 篇章开始: ${doc.title} -->\n\n`);
      parts.push(doc.content);
    }

    const fullContent = parts.join('\n');
    return {
      content: fullContent,
      title: preset.title,
      lines: fullContent.split('\n'),
    };
  }

  // 单篇文档
  const doc = SAMPLE_DOCS_MAP.get(targetId) ?? SAMPLE_DOCS[0];
  let content = doc.content;
  // 确保首行以 # 开头并保留兼容性
  if (!content.startsWith('#')) {
    content = `# 流式渲染演示（AI 模拟输出）：${doc.shortTitle}\n\n` + content;
  }

  return {
    content,
    title: doc.title,
    lines: content.split('\n'),
  };
}
