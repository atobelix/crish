export interface AIRequest {
  action: 'expand' | 'shorten' | 'rewrite' | 'translate' | 'polish' | 'summarize' | 'qa' | 'continue' | 'review';
  text: string;
  context?: string;
  targetLanguage?: string;
  tone?: string;
}

export interface AIResponse {
  success: boolean;
  result: string;
  citations?: Array<{ line: number; text: string }>;
  diffs?: Array<{ type: 'add' | 'delete' | 'equal'; text: string }>;
}

/* ────────────────────────────────────────────────────────────────
 * 流式接口
 * ──────────────────────────────────────────── */

/** 流式回调：每次拿到一小段增量文本 */
export type AIStreamHandler = (chunk: string) => void;

/** Prompt 关键词 → 合成回复模板 */
const RESPONSE_TEMPLATES: Array<{ match: RegExp; reply: string }> = [
  {
    match: /续写|接着写|continue/i,
    reply:
      '顺着上文的思路往下推，还有三个层面值得展开。\n\n首先是可验证性——任何设计主张都应该能被一个具体的用例证伪，否则它只是偏好。其次是可逆性，好的机制允许用户随时退回上一步，而不是把人锁进某条单行道。最后是一致性，同一个动作在不同位置应该产生同一种结果。',
  },
  {
    match: /总结|概括|要点|summar/i,
    reply:
      '要点如下：\n\n1. 核心主张是「源码即真相」，格式只是文本的投影\n2. 由此带来的直接收益是序列化无损与撤销一致\n3. 代价是需要一个增量重解析器，且必须处理输入法组合态',
  },
  {
    match: /润色|改写|polish|rewrite/i,
    reply:
      '润色后的版本：\n\n这套机制把语法字符留在文档里，因此用户看到的、编辑的、导出的始终是同一份文本。没有隐藏状态，也就没有需要同步的第二份真相。',
  },
  {
    match: /翻译|translate|英文|english/i,
    reply:
      'Translated:\n\nThe syntax characters live in the document itself, so what you see, what you edit, and what you export are always the same text. No hidden state means no second source of truth to keep in sync.',
  },
  {
    match: /待办|todo|任务|清单/i,
    reply:
      '- [ ] 补齐列表与引用的块级前缀解析\n- [ ] 接入表格的悬浮加行加列交互\n- [ ] 为斜杠菜单补全分组与键盘导航\n- [ ] 建立往返 fixture 门禁',
  },
];

const DEFAULT_REPLY =
  '这是一段合成的演示回复。当前项目运行在纯前端模式，没有接入真实模型，输出内容由本地模板按 Prompt 关键词匹配生成，用于验证流式渲染、交互状态与插入链路。';

/**
 * 合成的流式 AI 调用。
 *
 * 按「词」而不是按「字符」切分推送，节奏更接近真实模型的 token 流；
 * 每段之间的间隔带随机抖动，避免匀速造成的机械感。
 *
 * @param prompt  用户输入
 * @param onChunk 每拿到一段增量文本时回调
 */
export async function requestMockAI(prompt: string, onChunk: AIStreamHandler): Promise<string> {
  const template = RESPONSE_TEMPLATES.find((t) => t.match.test(prompt));
  const reply = template ? template.reply : DEFAULT_REPLY;

  // 首个 token 前的思考停顿
  await delay(180 + Math.random() * 220);

  const chunks = reply.match(/[\s\S]{1,3}/g) ?? [];
  for (const chunk of chunks) {
    onChunk(chunk);
    await delay(12 + Math.random() * 22);
  }
  return reply;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processAIRequest(req: AIRequest): Promise<AIResponse> {
  const inputLength = req.text.trim().length;

  switch (req.action) {
    case 'expand':
      return {
        success: true,
        result: `${req.text}\n\n[AI Expanded Details]: Furthermore, when analyzing this topic in detail, several key principles emerge that warrant additional consideration and structured breakdown.`,
      };

    case 'shorten':
      return {
        success: true,
        result: req.text.length > 50 ? `${req.text.slice(0, 45)}...` : req.text,
      };

    case 'rewrite':
    case 'polish':
      return {
        success: true,
        result: `[Polished Tone (${req.tone || 'professional'})]: ${req.text}`,
      };

    case 'translate':
      return {
        success: true,
        result: `[Translated to ${req.targetLanguage || 'English'}]: ${req.text}`,
      };

    case 'summarize':
      return {
        success: true,
        result: `Executive Summary: This document contains ${inputLength} characters covering core engineering requirements, task breakdowns, and architecture patterns.`,
        citations: [
          { line: 1, text: 'Title Heading' },
          { line: 5, text: 'Core Requirements' },
        ],
      };

    case 'qa':
      return {
        success: true,
        result: `Based on document context: The requested feature relies on Tiptap AST serialization and modular service contracts.`,
        citations: [{ line: 12, text: 'Interface Contracts Section' }],
      };

    case 'continue':
      return {
        success: true,
        result: ` In conclusion, continuing this stream of thought ensures continuous delivery and high test reliability across all modules.`,
      };

    case 'review':
      return {
        success: true,
        result: 'Grammar and style review complete. No critical errors detected.',
        diffs: [
          { type: 'equal', text: req.text },
          { type: 'add', text: ' (Verified by AI Reviewer)' },
        ],
      };

    default:
      return {
        success: false,
        result: 'Unknown AI action requested',
      };
  }
}
