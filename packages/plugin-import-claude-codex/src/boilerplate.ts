/**
 * 外部会话文本清理与样板过滤工具函数。
 * 用于彻底剔除环境探测、项目指令、系统提示词及本地控制命令标签等注入文本，提取用户真实的提问。
 */

import { stripAnsiEscape } from './stripAnsi';

/**
 * 判断文本是否纯属于系统提示词或 Agent 设定文件（例如 "You are Codex...", "You are Claude Code...", "AGENTS.md"）。
 */
export function isSystemPromptOrAgentInstructions(text: string): boolean {
  if (!text || !text.trim()) return false;
  const trimmed = text.trim();

  // 1. 系统角色声明："You are Codex...", "You are Claude Code...", "You are an AI assistant..."
  if (
    /^\s*You are (?:Codex|Claude|an? (?:AI|agent|assistant|helpful))/i.test(
      trimmed
    ) ||
    /^\s*You and the user share one workspace/i.test(trimmed)
  ) {
    return true;
  }

  // 2. 外部指令/项目规范纯样板头
  if (/^\s*#\s*(?:AGENTS|CLAUDE)\.md\b/i.test(trimmed)) {
    return true;
  }

  // 3. 包含系统专有提示词特征且无明确用户意图
  if (
    trimmed.includes('You are Codex, an agent based on') ||
    trimmed.includes("You are Claude Code, Anthropic's official CLI") ||
    trimmed.includes('You are a helpful and harmless assistant')
  ) {
    return true;
  }

  // 4. 纯本地 CLI 控制指令（例如只有 `/model`, `/clear`, `/init`）
  if (
    /^\s*\/(?:model|clear|init|compact|cost|help|doctor|login|logout|bug|review)\b[^\n]*$/im.test(
      trimmed
    )
  ) {
    const nonCmdLines = trimmed
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^\/(?:model|clear|init|compact|cost|help|doctor|login|logout|bug|review)\b/i.test(
            l
          )
      );
    if (nonCmdLines.length === 0) return true;
  }

  return false;
}

/**
 * 剥离外部会话中注入的系统样板、环境上下文、预设指令及本地命令控制标签，返回用户真实提问。
 */
export function stripBoilerplate(rawText: string): string {
  if (!rawText || !rawText.trim()) return '';

  let cleaned = rawText;

  // 1. 成对系统标签与环境上下文剥离（大小写不敏感，允许标签带属性）
  cleaned = cleaned.replace(
    /<environment_context[^>]*>[\s\S]*?<\/environment_context>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<instructions[^>]*>[\s\S]*?<\/instructions>/gi,
    ''
  );
  cleaned = cleaned.replace(/<app-context[^>]*>[\s\S]*?<\/app-context>/gi, '');
  cleaned = cleaned.replace(/<app_context[^>]*>[\s\S]*?<\/app_context>/gi, '');
  cleaned = cleaned.replace(
    /<system_information[^>]*>[\s\S]*?<\/system_information>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<context_summary[^>]*>[\s\S]*?<\/context_summary>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<agent-instructions[^>]*>[\s\S]*?<\/agent-instructions>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<agent_instructions[^>]*>[\s\S]*?<\/agent_instructions>/gi,
    ''
  );

  // 2. 本地控制命令样板与回显标签剥离（例如 Claude Code 的 <local-command-caveat> 等）
  cleaned = cleaned.replace(
    /<local-command-caveat[^>]*>[\s\S]*?<\/local-command-caveat>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-name[^>]*>[\s\S]*?<\/command-name>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-message[^>]*>[\s\S]*?<\/command-message>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-args[^>]*>[\s\S]*?<\/command-args>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<local-command-stdout[^>]*>[\s\S]*?<\/local-command-stdout>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<command-status[^>]*>[\s\S]*?<\/command-status>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<local-command[^>]*>[\s\S]*?<\/local-command>/gi,
    ''
  );

  // 3. 剥离 ANSI 颜色与终端格式控制字符（\u001b[2m, \u001b[22m, [2m, [22m 等）
  cleaned = stripAnsiEscape(cleaned);
  cleaned = cleaned.replace(/\[[0-9]{1,2}m/g, '');

  // 4. 外部工具调用与工具执行结果转储块强力剥离（彻底清洗方括号工具调用、工具结果以及 XML 标签）
  cleaned = cleaned.replace(
    /\[?(?:external[-_]agent[-_])?tool[-_]call[^\]\n]*\]?[\s\S]*?\[\/(?:external[-_]agent[-_])?tool[-_]call[^\]\n]*\]/gi,
    ''
  );
  cleaned = cleaned.replace(
    /\[?(?:external[-_]agent[-_])?tool[-_]result[^\]\n]*\]?[\s\S]*?\[\/(?:external[-_]agent[-_])?tool[-_]result[^\]\n]*\]/gi,
    ''
  );
  cleaned = cleaned.replace(
    /\[?(?:external[-_]agent[-_])?tool[-_]output[^\]\n]*\]?[\s\S]*?\[\/(?:external[-_]agent[-_])?tool[-_]output[^\]\n]*\]/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<(?:tool_call|tool-call)[^>]*>[\s\S]*?<\/(?:tool_call|tool-call)[^>]*>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<(?:tool_result|tool-result)[^>]*>[\s\S]*?<\/(?:tool_result|tool-result)[^>]*>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<(?:tool_output|tool-output)[^>]*>[\s\S]*?<\/(?:tool_output|tool-output)[^>]*>/gi,
    ''
  );

  // 未闭合直接残留到末尾的工具调用/结果块剥离
  cleaned = cleaned.replace(
    /(?:\[|(?:\n|^)\s*\[?)(?:external[-_]agent[-_])?tool[-_]call[^\]\n]*\]?[\s\S]*$/gi,
    ''
  );
  cleaned = cleaned.replace(
    /(?:\[|(?:\n|^)\s*\[?)(?:external[-_]agent[-_])?tool[-_]result[^\]\n]*\]?[\s\S]*$/gi,
    ''
  );
  cleaned = cleaned.replace(
    /(?:\[|(?:\n|^)\s*\[?)(?:external[-_]agent[-_])?tool[-_]output[^\]\n]*\]?[\s\S]*$/gi,
    ''
  );
  cleaned = cleaned.replace(/<(?:tool_call|tool-call)[^>]*>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<(?:tool_result|tool-result)[^>]*>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<(?:tool_output|tool-output)[^>]*>[\s\S]*$/gi, '');

  // 剥离因工具调用被清除而残留的空代码块与多余空行
  cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\s*```/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 5. 剥离 `# AGENTS.md instructions ...` / `# CLAUDE.md instructions ...`
  cleaned = cleaned.replace(
    /#\s*(?:AGENTS|CLAUDE)\.md instructions[\s\S]*?<\/(?:INSTRUCTIONS|instructions)>/gi,
    ''
  );
  cleaned = cleaned.replace(
    /<(?:INSTRUCTIONS|instructions)>[\s\S]*?#\s*(?:AGENTS|CLAUDE)\.md[\s\S]*?<\/(?:INSTRUCTIONS|instructions)>/gi,
    ''
  );

  // 5. 若仍残留 `# AGENTS.md` / `# CLAUDE.md` 开头
  if (/^\s*#\s*(?:AGENTS|CLAUDE)\.md/i.test(cleaned)) {
    const parts = cleaned.split(/\n\s*\n/);
    if (parts.length > 1) {
      const remaining = parts.slice(1).join('\n\n').trim();
      if (!/^\s*#\s*(?:AGENTS|CLAUDE)\.md/i.test(remaining)) {
        cleaned = remaining;
      } else {
        cleaned = '';
      }
    } else {
      cleaned = '';
    }
  }

  // 6. 检查是否以 "You are Codex...", "You are Claude...", "You are an AI..." 等系统提示词开头
  if (
    /^\s*You are (?:Codex|Claude|an? (?:AI|agent|assistant|helpful))/i.test(
      cleaned
    ) ||
    /^\s*You and the user share one workspace/i.test(cleaned)
  ) {
    const separatorIdx = cleaned.search(
      /\n\s*\n(?:User|Human|用户|提问|Question):\s*/i
    );
    if (separatorIdx >= 0) {
      cleaned = cleaned
        .slice(separatorIdx)
        .replace(/^\s*\n(?:User|Human|用户|提问|Question):\s*/i, '');
    } else {
      cleaned = '';
    }
  }

  // 7. 剥离纯内部 CLI 控制命令（如 /model, /clear 等整行）
  if (
    /^\s*\/(?:model|clear|init|compact|cost|help|doctor|login|logout|bug|review)\b/i.test(
      cleaned.trim()
    )
  ) {
    const lines = cleaned
      .split('\n')
      .filter(
        (l) =>
          !/^\s*\/(?:model|clear|init|compact|cost|help|doctor|login|logout|bug|review)\b/i.test(
            l.trim()
          )
      );
    cleaned = lines.join('\n').trim();
  }

  // 8. 去除可能残留的孤立未闭合样板标记
  if (
    /^\s*<(?:environment_context|instructions|app-context|local-command|tool_call|tool_result|tool_output|tool-call|tool-result|tool-output)[^>]*>[\s\S]*$/i.test(
      cleaned
    ) &&
    !cleaned.includes('</')
  ) {
    cleaned = '';
  }

  return cleaned.trim();
}

/**
 * 判断文本是否为无意义的单字/标点噪音（如输入中断留下的单个助词、标点等）。
 */
export function isMeaninglessNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // 单个中英文标点、空白、助词/语气词（如 '的', '了', '么', '呢', '吧', '啊', '哦', '嗯'）
  if (
    /^[的了么呢吧啊哦嗯\s，。！？、：；….,!?:;~`'"“”‘’\-_/\\]$/u.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/**
 * 判断文本是否纯为样板（无有效真实用户内容）。
 */
export function isPureBoilerplate(rawText: string): boolean {
  if (!rawText || !rawText.trim()) return true;
  if (isSystemPromptOrAgentInstructions(rawText)) return true;
  const cleaned = stripBoilerplate(rawText);
  return (
    cleaned.length === 0 ||
    isMeaninglessNoise(cleaned) ||
    isSystemPromptOrAgentInstructions(cleaned)
  );
}
