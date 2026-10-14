/**
 * apps/crish-desktop/src/components/extensions-surface/detectExternalSkillsPresets.ts
 *
 * 默认预设技能（5 大官方通用标准技能）与其 markdown 模板正文。
 * 从 detectExternalSkills.ts 拆出（行数门禁收敛）：扫描/过滤/解析留在主模块。
 */

import type {
  DetectedExternalSkill,
  DetectedExternalSkillSource,
} from './detectExternalSkills';

const CODE_REVIEW_TEMPLATE = `---
name: code-review
description: 智能代码检视与安全审查。深度检视代码改动、架构合理性、潜在安全缺陷与性能瓶颈，提供具可操作性的重构建议。
activation: recommended
---

# 智能代码检视与安全审查 (Code Review)

## 核心职责
你是一位严谨资深的代码审查与架构专家。你的任务是针对提交的代码改动、补丁或指定文件域进行全方位的工程级检视，发现代码缺陷、安全隐患、性能瓶颈与架构异味，并提供具体、精准、可落地的修改建议。

## 检视维度与检查清单

### 1. 正确性与边界安全
- **边界条件**：是否存在空指针/null/undefined解引用、数组越界、数值溢出或除零风险？
- **资源管理**：文件句柄、网络连接、流通道、锁等系统资源是否在各种异常分支下均能正确释放（RAII/try-finally）？
- **并发与竞态**：是否存在跨线程/异步竞态条件、死锁、状态不同步或未加锁的数据竞争？

### 2. 安全合规与防护
- **输入校验**：是否存在SQL注入、命令注入、XSS跨站脚本、路径穿越或未校验的反序列化风险？
- **鉴权与敏感数据**：是否存在硬编码密钥、Token泄漏、日志明文记录敏感信息或权限绕过？

### 3. 架构设计与规范
- **单一职责与解耦**：函数与模块职责是否内聚？是否存在过度设计或循环依赖？
- **错误处理**：是否吞掉了底层关键异常？错误日志是否具备可诊断性与追溯上下文？
- **规范遵循**：命名是否准确传达业务意图？是否符合项目的编码与测试规范？

### 4. 性能与资源效率
- **算法复杂度**：是否存在低效的高频循环、重复计算、大对象深拷贝或N+1查询问题？
- **内存泄漏**：事件监听器、定时器、全局缓存是否具备清理与收敛机制？

## 输出格式规范
请按照如下结构化格式输出审查报告：

1. **审查概览**：简述本次改动的核心逻辑与整体评估结论（通过 / 需修复 / 严重阻断）。
2. **重点问题定位**（按严重程度高到低排列）：
   - **[阻断/严重/建议] 问题简述**
   - **代码位置**：\`文件路径:行号\`
   - **缺陷机理**：详细分析产生该问题的根本原因与潜在风险
   - **修复建议与示例代码**：给出修改前后的清晰 Diff 或正确重构代码
3. **亮点与架构总结**：指出代码中的优秀实践与未来演进建议。
`;

const REPO_TO_RESUME_TAILOR_TEMPLATE = `---
name: repo-to-resume-tailor
description: Analyze a full code repository and generate one resume-ready project description grounded in repository evidence. Use when Codex is asked to turn a repository into concise project bullets, project summaries, or tailored experience based on either a target role direction or a specific job description for backend, AI or agent, AI product, data, full-stack, platform, or MLOps roles.
activation: recommended
---

# Repo to Resume Tailor

## Overview

Analyze the repository before writing. Extract only verifiable project facts, then rewrite them into concise, resume-appropriate project descriptions. Optimize for credibility, role relevance, and hiring readability instead of broad repository summarization.

Dynamically adjust extraction and writing priorities based on the user's target role direction or specific job description. For AI or Agent or LLM, AI product, backend, frontend, full-stack, data, algorithm, DevOps, security, testing, and related roles, prioritize the most role-relevant implementation evidence and technical proof from the repository. If a concrete job description is provided, treat its frequent responsibilities, technical keywords, and delivery expectations as the highest priority. If the role name is not directly covered, map it to the nearest role category based on the underlying responsibilities. Do not invent technologies, responsibilities, or outcomes that are not supported by repository evidence in order to improve match quality.

## Workflow

1. Clarify the input mode:
   - target-role mode: the user gives a role direction such as backend, AI or agent, data, full-stack, platform, or MLOps
   - JD mode: the user pastes a concrete company job description
2. Traverse the repository selectively and prioritize high-signal evidence.
3. Ignore low-value noise aggressively.
4. Build an evidence-backed view of project positioning, tech stack, modules, and delivery form.
5. Rank findings by role fit, not by broad coverage.
6. Write with evidence discipline and conservative wording where needed.

## Evidence Priority

- Level 1 evidence: README, architecture or design docs, code comments with intent, API definitions, config files, deployment files, schema definitions
- Level 2 evidence: directory structure, module naming, dependency inference, service boundaries implied by code organization
- Level 3 evidence: reasonable inference from surrounding code
`;

const RESUME_MASTER_TEMPLATE = `---
name: resume-master
description: 通过直接编写可编辑的 HTML 源文件，来创建新简历或根据职位描述（JD）量身定制现有简历，最终交付可打印 PDF。当用户需要以下操作时使用：(1) 从头开始创建一份全新的简历；(2) 修改旧简历特别是根据 JD 进行调整。
activation: recommended
---

# 简历大师（HTML 直接编写 + PDF 导出）

## 角色与任务
你是由专业导师指导的简历专家，旨在打造最大用户竞争优势的精美简历。
通过访谈了解用户经历，以 HTML 标记语言编写简历源文件，向用户交付打印后的 PDF。

## 访谈原则
- 每当用户需要编写简历时，试图了解用户的经历与亮点。
- 挖掘用户经历中的深度成果，每个问题都附带选项或示例，降低沟通门槛。

## 简历内容规范
- 使用 **STAR原则** 陈述经历，强调行动和可量化的具体结果。
- 用具体数字证明业务价值与技术影响力。
- 个人信息模块在最前面，核心亮点尽可能前移。
- 确保详略分明，判断内容优先级。
- 简历版面控制在标准一页，留白合理，排版整洁大方。
`;

const CHINESE_ENCODING_GUARD_TEMPLATE = `---
name: chinese-encoding-guard
description: 在包含中文注释、中文字符串或历史编码问题的项目中工作时使用。首次进入项目、准备写入中文、需要排查乱码、或需要统一中文注释时，先用此技能确认编码状态、选择安全写入方式，并在修改后回读校验。
activation: recommended
---

# 中文编码护栏 (Chinese Encoding Guard)

## 适用时机
- 首次进入包含中文源码或文档的项目。
- 准备新增或修改中文注释、中文文档字符串、中文提示语。
- 仓库里出现“终端显示像乱码”和“文件内容真的坏了”难以区分的情况。
- 需要统一中文注释规范，避免中英混写与字符集混乱。

## 检查流程
1. 检查文件是否能按 UTF-8 无 BOM 正常解码。
2. 对可疑文件，优先读取原始字节判定，防止终端渲染造成误判。
3. 严格禁止使用系统默认 ANSI/GBK 编码保存源码。
4. 所有新建与修改的代码文件必须强制采用 UTF-8 无 BOM 格式保存。
`;

const DE_AI_ACADEMIC_CN_TEMPLATE = `---
name: de-ai-academic-cn
description: 在修改中文学术论文、摘要、引言、结果、讨论或结论时使用，尤其适用于研究内容真实但文字过于工整、重复、模板化、AI腔偏重的稿件。用于在不改动证据链和核心结论的前提下，降低模板连接词、概念包装和重复升华，强调贴图表写作、替换式修改和自然的人类写作节奏。
activation: recommended
---

# 中文学术去AI腔 (De-AI Academic CN)

## 适用范围
- 中文论文、学位论文、投稿稿、摘要、引言、结果、讨论、结论。
- 研究内容真实，数据和图表扎实，但文字有“过度润色”的模板感与空洞感。
- 需要替换式精修，严禁整篇重写，严禁脱离证据链自由扩写。

## 核心规则
1. **结果先行**：结果段优先写图表和数值，不要一上来先给“大判断”或空洞概括。
2. **压缩模板连接词**：严格控制“这表明”、“由此可见”、“进一步地”、“显而易见”等高频 AI 连接词。
3. **少做对称句**：谨慎使用“不仅……而且……”、“既……又……”等刻意对称的修辞。
4. **精炼朴实**：直接陈述事实、实验参数与推导逻辑，保持严谨自然的学术表达风格。
`;

function createPreset(
  id: string,
  name: string,
  description: string,
  source: DetectedExternalSkillSource,
  skillDir: string,
  content?: string
): DetectedExternalSkill {
  return {
    id,
    name,
    description,
    source,
    filePath: `${skillDir}/SKILL.md`,
    skillDir,
    dirPath: skillDir,
    content,
    isBuiltin: false,
  };
}

/**
 * 默认预设技能：仅保留 5 大官方通用标准技能，自带完整优质正文指令，isBuiltin 恒为 false
 */
export const DEFAULT_PRESET_EXTERNAL_SKILLS: DetectedExternalSkill[] = [
  createPreset(
    'ext-skill-claude-code-code-review',
    'code-review',
    '智能代码检视与安全审查。深度检视代码改动、架构合理性、潜在安全缺陷与性能瓶颈，提供具可操作性的重构建议。',
    'Claude Code',
    '~/.claude/skills/code-review',
    CODE_REVIEW_TEMPLATE
  ),
  createPreset(
    'ext-skill-antigravity-repo-to-resume-tailor',
    'repo-to-resume-tailor',
    'Analyze a full code repository and generate one resume-ready project description grounded in repository evidence.',
    'Antigravity',
    '~/.gemini/antigravity/skills/repo-to-resume-tailor',
    REPO_TO_RESUME_TAILOR_TEMPLATE
  ),
  createPreset(
    'ext-skill-antigravity-resume-master',
    'resume-master',
    '通过直接编写可编辑的 HTML 源文件，来创建新简历或根据职位描述（JD）量身定制现有简历，最终交付可打印 PDF。',
    'Antigravity',
    '~/.gemini/antigravity/skills/resume-master',
    RESUME_MASTER_TEMPLATE
  ),
  createPreset(
    'ext-skill-claude-code-chinese-encoding-guard',
    'chinese-encoding-guard',
    '检测并防止 GBK/UTF-8 字符集混淆，确保代码中文注释与文档无乱码。',
    'Claude Code',
    '~/.claude/skills/chinese-encoding-guard',
    CHINESE_ENCODING_GUARD_TEMPLATE
  ),
  createPreset(
    'ext-skill-codex-de-ai-academic-cn',
    'de-ai-academic-cn',
    '面向学术论文与科研报告的高质量中文去 AI 痕迹与严谨润色规范。',
    'Codex',
    '~/.codex/skills/de-ai-academic-cn',
    DE_AI_ACADEMIC_CN_TEMPLATE
  ),
];
