import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AgentRuntime,
  OpenAICompatibleProvider,
  createLocalWorkspaceTools,
  createPermissionPolicy,
  createWriteFileTool,
  loadOpenAICompatibleProviderConfig,
  runRuntimeStageSuite
} from "../src/index";
import type { OpenAICompatibleToolChoice, RuntimeStage } from "../src/index";
import { evaluateSystemUiQuality, type UiQualityGate } from "./ui-quality-gate";

const providerConfigPath = process.env.FLOWBIT_PROVIDER_CONFIG ?? ".tmp/agent-runtime-flowbit-provider-mimo-v25-stream.json";
const providerConfig = await loadOpenAICompatibleProviderConfig(providerConfigPath);
const repoRoot = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = join(".tmp", `mimo-v25-ui-smoke-${stamp}`);
const reportDir = join(outputRoot, "reports");
const progressPath = join(outputRoot, "runtime-report.partial.json");
const spec = readFileSync("docs/mimo-agent-ui-longrun-spec.md", "utf8");
const iterationCount = readNonNegativeIntegerEnv("MIMO_SMOKE_ITERATIONS", 0);

mkdirSync(reportDir, { recursive: true });

function toWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function makeProvider(toolChoice?: OpenAICompatibleToolChoice): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: providerConfig.baseUrl,
    apiKey: providerConfig.apiKey,
    apiKeyEnv: providerConfig.apiKeyEnv,
    apiKeyFile: providerConfig.apiKeyFile,
    model: providerConfig.model ?? "mimo-v2.5",
    endpoint: providerConfig.endpoint ?? "responses",
    authHeader: providerConfig.authHeader,
    maxTokens: 4096,
    topP: 0.95,
    reasoningContent: "require",
    toolChoice,
    stream: true,
    requestTimeoutMs: 180_000,
    firstByteTimeoutMs: 90_000,
    streamIdleTimeoutMs: 120_000,
    diagnostics: true,
    retry: { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 8000, totalBudgetMs: 180_000, jitterRatio: 0.2 }
  });
}

function stagePrompt(title: string, body: string, options: { includeFullSpec?: boolean } = {}): string {
  const context = options.includeFullSpec === false ? compactUiRules() : spec;
  return [
    context,
    "",
    "# Runtime instruction",
    "",
    "If this stage says the first tool call must be write_file, do not produce prose or planning first.",
    "Call write_file immediately with the required complete file content.",
    "",
    "# Current stage",
    "",
    title,
    "",
    `Output directory: ${toWorkspacePath(outputRoot)}`,
    "",
    body,
    "",
    "Mandatory rules:",
    "- You must use tools, not only reply with prose.",
    "- If the stage requires files, call write_file before the final answer.",
    "- All generated UI text and report prose must be Chinese.",
    "- When reporting encoding status, do not include raw mojibake example strings; describe them generically as suspicious encoding artifacts.",
    "- Do not overwrite replicate_ui."
  ].join("\n");
}

function compactUiRules(): string {
  return [
    "# Compact UI rules",
    "",
    "- Build a white-first, minimal, high-end Chinese desktop agent UI demo.",
    "- Do not build a landing page, a single-column report page, or a pile of cards. It must look like a real desktop system application.",
    "- The HTML must use real header, aside, main, nav, section, and button elements, not only class names that pretend to be a system layout.",
    "- Required shell: top status bar, left navigation, central work area, right inspector, and event stream or timeline.",
    "- Minimum density: 6 sections, 12 buttons, 1 input control, 2 tool batches, 2 diff blocks, and 3 sub-agent rows.",
    "- The UI must preserve mixed ordering of assistant text and tool calls.",
    "- Consecutive tool calls must render as summary row, tool rows, then details.",
    "- Tool summary click logic must use toolSummary.closest('.msg--tools') and data-tools-expanded; do not replace .msg--tools with .tool-container.",
    "- Edited files must render a git-like red/green diff with side color markers.",
    `- Preserve these exact Chinese anchor texts in every iteration: ${"\u5df2\u8fd0\u884c"}, ${"\u5de5\u5177\u8c03\u7528"}, ${"\u5b50\u667a\u80fd\u4f53"}, ${"\u5df2\u7f16\u8f91"}, ${"\u65b0\u589e"}, ${"\u5220\u9664"}.`,
    "- Never remove required selector contracts or anchor texts when patching generated files.",
    `- Visible product names must be Chinese-only, for example ${"\u667a\u80fd\u4f53\u5de5\u4f5c\u53f0"}; do not write MiMo Agent or Agent in titles, headings, buttons, labels, or demo text.`,
    "- Use no English UI labels in generated HTML, CSS-visible text, or JS-rendered strings.",
    "- Demo diff snippets must avoid English visible labels such as Add, Delete, Run, Tool, Agent, Command, or Edited; use Chinese text in examples.",
    "- Avoid dark backgrounds, heavy borders, decorative outlines, and large background blocks; use whitespace, typography, and light gray active states for hierarchy."
  ].join("\n");
}

function hardWritePrompt(title: string, targetFile: string, body: string): string {
  return [
    compactUiRules(),
    "",
    "# Hard write stage",
    "",
    `Stage: ${title}`,
    `Output directory: ${toWorkspacePath(outputRoot)}`,
    `Target file: ${targetFile}`,
    "",
    "Your first and immediate action must be one write_file tool call.",
    "Do not read files, do not list directories, do not run shell commands, and do not write analysis before the tool call.",
    "Write a complete, valid file in that first write_file call.",
    "",
    body,
    "",
    "When reporting encoding status, do not include raw mojibake example strings; describe them generically as suspicious encoding artifacts.",
    "",
    "After write_file succeeds, stop with one short Chinese sentence."
  ].join("\n");
}

function deterministicFallback(targetFile: string, content: () => string): NonNullable<RuntimeStage["fallback"]> {
  return () => {
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, content(), "utf8");
  };
}

function fallbackMarkdown(title: string, lines: string[]): string {
  return [
    `# ${title}`,
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    "说明：模型多次尝试后未稳定生成该报告，系统已创建兜底记录，保证长程任务可以继续推进。",
    "",
    ...lines.map((line) => `- ${line}`),
    ""
  ].join("\n");
}

const stageReview = "\u5ba1\u67e5\u4e0e\u8ba1\u5212";
const stageReport = "\u9636\u6bb5\u62a5\u544a";
const stageHtml = "HTML \u7ed3\u6784";
const stageCss = "CSS \u6837\u5f0f";
const stageJs = "JS \u4ea4\u4e92";
const stageEncoding = "\u7f16\u7801\u68c0\u67e5";
const stageFinalReview = "\u6700\u7ec8\u8bc4\u5ba1";

function createIterationStages(count: number): RuntimeStage[] {
  const stages: RuntimeStage[] = [];
  for (let index = 1; index <= count; index++) {
    const iterationLabel = `${"\u7b2c"} ${index} ${"\u8f6e"}`;
    const selfCheckName = `${"\u8fed\u4ee3\u81ea\u67e5"} ${index}`;
    const patchName = `${"\u8fed\u4ee3\u4fee\u6b63"} ${index}`;
    const selfCheckReport = toWorkspacePath(join(outputRoot, "reports", `iteration-${index}-self-check.md`));
    const patchReport = toWorkspacePath(join(outputRoot, "reports", `iteration-${index}-patch.md`));

    stages.push({
      name: selfCheckName,
      resetContextOnRetry: true,
      fallback: deterministicFallback(selfCheckReport, () =>
        fallbackMarkdown(`${selfCheckName}报告`, [
          "工具调用展开、差异颜色、子智能体状态和中文文本仍需以后续本地验证为准。",
          "本轮没有可靠的模型自查报告，因此建议下一轮优先保持选择器合同和中文可见文本。",
          "如果后续仍触发兜底，应降低单轮任务复杂度或增加结构化自查模板。"
        ])
      ),
      prompt: stagePrompt(
        selfCheckName,
        [
          `${iterationLabel}: inspect the generated UI as a self-review agent.`,
          `Read ${toWorkspacePath(join(outputRoot, "index.html"))}.`,
          `Read ${toWorkspacePath(join(outputRoot, "styles.css"))}.`,
          `Read ${toWorkspacePath(join(outputRoot, "app.js"))}.`,
          "Run at least one shell_command to inspect selector consistency, duplicated event bindings, or Chinese UI text.",
          `Create ${selfCheckReport}.`,
          "The report must be Chinese and include tool-flow observations, selector risks, encoding risks, and one concrete next patch."
        ].join("\n"),
        { includeFullSpec: false }
      ),
      retryPrompt: hardWritePrompt(
        selfCheckName,
        selfCheckReport,
        [
          `Create ${selfCheckReport}.`,
          "Write a concise Chinese self-check report for the generated UI.",
          "Mention whether tool-call expansion, diff colors, sub-agent state, Chinese text, and event binding need another patch."
        ].join("\n")
      ),
      maxAttempts: 3,
      requiredFiles: [selfCheckReport],
      stopWhenRequirementsMet: true
    });

    stages.push({
      name: patchName,
      maxAttempts: 2,
      resetContextOnRetry: true,
      fallback: deterministicFallback(patchReport, () =>
        fallbackMarkdown(`${patchName}报告`, [
          "模型未稳定生成修正报告，本轮未由系统修改 UI 文件。",
          "后续应继续检查工具调用展开、差异块、子智能体状态和中文可见文本。",
          "系统兜底只记录状态，不替代真实 UI 修正。"
        ])
      ),
      retryPrompt: hardWritePrompt(
        patchName,
        patchReport,
        [
          `Create ${patchReport}.`,
          "Write a concise Chinese patch report.",
          "Mention the inspected files, whether a UI file still needs changes, and the exact next improvement."
        ].join("\n")
      ),
      prompt: stagePrompt(
        patchName,
        [
          `${iterationLabel}: apply a small, safe improvement based on the self-check report.`,
          `Read ${selfCheckReport}.`,
          `Read ${toWorkspacePath(join(outputRoot, "index.html"))}.`,
          `Read ${toWorkspacePath(join(outputRoot, "styles.css"))}.`,
          `Read ${toWorkspacePath(join(outputRoot, "app.js"))}.`,
          "If a clear issue is found, update exactly one generated UI file with write_file.",
          "If updating a UI file, preserve all required selector contracts and exact Chinese anchor texts from the HTML stage.",
          `Always create ${patchReport} in Chinese, summarizing what was changed or why no UI file change was needed.`,
          "Do not touch replicate_ui."
        ].join("\n"),
        { includeFullSpec: false }
      ),
      requiredFiles: [patchReport],
      stopWhenRequirementsMet: true
    });
  }
  return stages;
}

const stages = [
  {
    name: stageReview,
    maxAttempts: 2,
    resetContextOnRetry: true,
    fallback: deterministicFallback(toWorkspacePath(join(outputRoot, "README.md")), () =>
      fallbackMarkdown("界面结构计划", [
        "目标是生成白底、简约、高级的中文桌面智能体界面样例。",
        "必须保留正文与工具调用混合顺序、连续工具摘要、三级展开、红绿差异块和子智能体状态。",
        "后续阶段需要继续通过本地验证和编码探针确认质量。"
      ])
    ),
    retryPrompt: hardWritePrompt(
      stageReview,
      toWorkspacePath(join(outputRoot, "README.md")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "README.md"))}.`,
        "Write a concise Chinese plan for the generated UI structure.",
        "Mention message stream, tool-call expansion, diff display, sub-agent panel, and encoding checks."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageReview,
      [
        "Read these files first:",
        "- docs/mimo-agent-ui-longrun-spec.md",
        "- replicate_ui/css/base.css",
        "- replicate_ui/css/chat.css",
        "- replicate_ui/css/subagents.css",
        "",
        `Then create ${toWorkspacePath(join(outputRoot, "README.md"))}.`,
        "The file must be Chinese and must summarize the planned UI structure."
      ].join("\n")
    ),
    requiredFiles: [toWorkspacePath(join(outputRoot, "README.md"))],
    stopWhenRequirementsMet: true
  },
  {
    name: stageReport,
    maxAttempts: 2,
    resetContextOnRetry: true,
    fallback: deterministicFallback(toWorkspacePath(join(outputRoot, "reports", "stage-report.md")), () =>
      fallbackMarkdown("阶段报告", [
        "阶段目标：生成并验证中文智能体界面样例。",
        "主要风险：模型忘记写文件、选择器合同漂移、英文可见标签混入和编码误报。",
        "验收标准：目标文件齐全、本地验证无警告、中文编码脚本无问题。"
      ])
    ),
    retryPrompt: hardWritePrompt(
      stageReport,
      toWorkspacePath(join(outputRoot, "reports", "stage-report.md")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "reports", "stage-report.md"))}.`,
        "Write a concise Chinese stage report.",
        "Mention stage goals, risks, file plan, and acceptance criteria."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageReport,
      [
        "Read the generated README first.",
        `Read ${toWorkspacePath(join(outputRoot, "README.md"))}.`,
        `Create ${toWorkspacePath(join(outputRoot, "reports", "stage-report.md"))}.`,
        "The report must be Chinese and include stage goals, risks, file plan, and acceptance criteria.",
        "After reading README, your next tool call should be write_file for the stage report.",
        "Do not create index.html, styles.css, app.js, review.md, or encoding-check.json in this stage."
      ].join("\n")
    ),
    requiredFiles: [toWorkspacePath(join(outputRoot, "reports", "stage-report.md"))],
    stopWhenRequirementsMet: true
  },
  {
    name: stageHtml,
    maxAttempts: 3,
    resetContextOnRetry: true,
    prompt: hardWritePrompt(
      stageHtml,
      toWorkspacePath(join(outputRoot, "index.html")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "index.html"))}.`,
        "index.html must reference styles.css and app.js.",
        "The HTML must be a desktop system shell, not a simple webpage. Use real header, aside, main, nav, section, and button elements.",
        "The layout must include top status bar, left navigation, central message/task work area, right inspector, and event stream or timeline.",
        "The HTML must include at least 6 section elements, 12 button elements, 1 input or textarea, two tool-call batches, two red/green code diff blocks, and three sub-agent status rows.",
        "The HTML must include a Chinese message stream, three-level tool-call expansion, red/green code diff, task ledger, context budget, permission review, checkpoint panel, memory panel, performance probe, and sub-agent status panel.",
        "Use these exact selector contracts in the HTML: .msg--tools, .tool-summary, .tool-row, .diff__header, .diff__line--add, .diff__line--remove, .sub-agent-item, and data-tools-expanded.",
        "The visible UI text must include these exact Chinese anchors:",
        `- ${"\u5df2\u8fd0\u884c"} 3 ${"\u6761\u547d\u4ee4"}`,
        `- ${"\u5de5\u5177\u8c03\u7528"}`,
        `- ${"\u5b50\u667a\u80fd\u4f53"}`,
        `- ${"\u5df2\u7f16\u8f91"}`,
        `- ${"\u65b0\u589e"}`,
        `- ${"\u5220\u9664"}`,
        `- ${"\u4efb\u52a1\u8d26\u672c"}`,
        `- ${"\u4e0a\u4e0b\u6587\u9884\u7b97"}`,
        `- ${"\u6027\u80fd\u63a2\u9488"}`,
        `- ${"\u6743\u9650"}`,
        `- ${"\u68c0\u67e5\u70b9"}`,
        `- ${"\u8bb0\u5fc6"}`,
        "Do not create styles.css or app.js in this stage."
      ].join("\n")
    ),
    requiredToolCalls: ["write_file"],
    requiredToolCallCounts: { write_file: 1 },
    forbiddenToolCalls: ["list_directory", "shell_command"],
    requiredFiles: [toWorkspacePath(join(outputRoot, "index.html"))],
    requiredFileIncludes: [
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "styles.css" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "app.js" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "msg--tools" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "tool-summary" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "tool-row" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "diff__header" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "diff__line--add" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "diff__line--remove" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "sub-agent-item" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "data-tools-expanded" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u5df2\u8fd0\u884c" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u5de5\u5177\u8c03\u7528" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u5b50\u667a\u80fd\u4f53" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u5df2\u7f16\u8f91" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u65b0\u589e" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u5220\u9664" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "<aside" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "<main" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "<section" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "<button" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u4efb\u52a1\u8d26\u672c" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u4e0a\u4e0b\u6587\u9884\u7b97" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u6027\u80fd\u63a2\u9488" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u6743\u9650" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u68c0\u67e5\u70b9" },
      { file: toWorkspacePath(join(outputRoot, "index.html")), text: "\u8bb0\u5fc6" }
    ],
    stopWhenRequirementsMet: true
  },
  {
    name: stageCss,
    maxAttempts: 3,
    resetContextOnRetry: true,
    retryPrompt: hardWritePrompt(
      stageCss,
      toWorkspacePath(join(outputRoot, "styles.css")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "styles.css"))}.`,
        "Write a complete stylesheet for the existing HTML without reading files first.",
        "It must include :root variables, white-first layout, hover states, tool-call rows, and red/green diff rows.",
        "It must include selectors for .msg--tools, .tool-summary, .tool-row, .diff__header, .diff__line--add, .diff__line--remove, and .sub-agent-item."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageCss,
      [
        "Create only the stylesheet in this stage.",
        `Read ${toWorkspacePath(join(outputRoot, "index.html"))} first.`,
        `Create ${toWorkspacePath(join(outputRoot, "styles.css"))}.`,
        "The CSS must be white-first, minimal, high-end, Chinese-product friendly, and include hover/active states, tool-call blocks, diff red/green rows, and responsive layout.",
        "Use the same selector contracts as HTML: .msg--tools, .tool-summary, .tool-row, .diff__header, .diff__line--add, .diff__line--remove, and .sub-agent-item.",
        "Do not call list_directory or shell_command in this stage.",
        "Do not create or rewrite app.js in this stage."
      ].join("\n")
    ),
    requiredToolCalls: ["write_file"],
    requiredToolCallCounts: { write_file: 1 },
    forbiddenToolCalls: ["list_directory", "shell_command"],
    requiredFiles: [toWorkspacePath(join(outputRoot, "styles.css"))],
    requiredFileIncludes: [
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: ":root" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "msg--tools" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "tool-summary" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "tool-row" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "diff__header" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "diff__line--add" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "diff__line--remove" },
      { file: toWorkspacePath(join(outputRoot, "styles.css")), text: "sub-agent-item" }
    ],
    stopWhenRequirementsMet: true
  },
  {
    name: stageJs,
    maxAttempts: 3,
    resetContextOnRetry: true,
    retryPrompt: hardWritePrompt(
      stageJs,
      toWorkspacePath(join(outputRoot, "app.js")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "app.js"))}.`,
        "Write a complete interaction script without reading files first.",
        "Use event delegation from document or the stream root.",
        "A single click on .tool-summary must toggle the closest .msg--tools data-tools-expanded value exactly once.",
        "The script must include addEventListener and event.target.closest."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageJs,
      [
        "Create only the interaction script in this stage.",
        `Read ${toWorkspacePath(join(outputRoot, "index.html"))} first.`,
        `Create ${toWorkspacePath(join(outputRoot, "app.js"))}.`,
        "The JS must support three-level tool-call expansion, diff block toggles, sub-agent state toggles, and avoid console errors.",
        "Use .msg--tools as the tool-call container and .tool-summary as the summary trigger.",
        "The tool summary click logic must include toolSummary.closest('.msg--tools') and must not replace .msg--tools with .tool-container.",
        "Use event delegation for dynamic tool rows. Do not re-bind click handlers to existing rows during refresh or demo insertion.",
        "A single click on .tool-summary must toggle the closest .msg--tools data-tools-expanded value exactly once.",
        "Do not call list_directory or shell_command in this stage.",
        "Do not rewrite index.html or styles.css unless absolutely necessary."
      ].join("\n")
    ),
    requiredToolCalls: ["write_file"],
    requiredToolCallCounts: { write_file: 1 },
    forbiddenToolCalls: ["list_directory", "shell_command"],
    requiredFiles: [toWorkspacePath(join(outputRoot, "app.js"))],
    requiredFileIncludes: [
      { file: toWorkspacePath(join(outputRoot, "app.js")), text: "addEventListener" },
      { file: toWorkspacePath(join(outputRoot, "app.js")), text: "closest(" },
      { file: toWorkspacePath(join(outputRoot, "app.js")), text: ".tool-summary" },
      { file: toWorkspacePath(join(outputRoot, "app.js")), text: ".msg--tools" },
      { file: toWorkspacePath(join(outputRoot, "app.js")), text: "data-tools-expanded" }
    ],
    stopWhenRequirementsMet: true
  },
  ...createIterationStages(iterationCount),
  {
    name: stageEncoding,
    maxAttempts: 2,
    resetContextOnRetry: true,
    fallback: deterministicFallback(toWorkspacePath(join(outputRoot, "reports", "encoding-check.json")), () =>
      JSON.stringify(
        {
          status: "fallback",
          generatedAt: new Date().toISOString(),
          checkedFiles: ["index.html", "styles.css", "app.js"],
          chineseTextStatus: "需要以后续系统编码探针为准",
          visibleEnglishLabels: "需要以后续本地验证为准",
          note: "模型未稳定生成编码检查报告，系统已创建兜底 JSON。"
        },
        null,
        2
      )
    ),
    retryPrompt: hardWritePrompt(
      stageEncoding,
      toWorkspacePath(join(outputRoot, "reports", "encoding-check.json")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "reports", "encoding-check.json"))}.`,
        "Write valid JSON for the generated file presence and encoding status.",
        "Use Chinese strings. Mention index.html, styles.css, app.js, and review readiness."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageEncoding,
      [
        "Run a read-only encoding and file-presence check for the output directory.",
        "Use shell_command for at least one verification command such as a directory listing or a text encoding check.",
        `Create ${toWorkspacePath(join(outputRoot, "reports", "encoding-check.json"))}.`,
        "The JSON must be valid and mention checked files, Chinese text status, English UI labels if any, and command results.",
        "Do not create review.md in this stage."
      ].join("\n")
    ),
    requiredFiles: [toWorkspacePath(join(outputRoot, "reports", "encoding-check.json"))],
    stopWhenRequirementsMet: true
  },
  {
    name: stageFinalReview,
    maxAttempts: 2,
    resetContextOnRetry: true,
    fallback: deterministicFallback(toWorkspacePath(join(outputRoot, "reports", "review.md")), () =>
      fallbackMarkdown("最终评审报告", [
        "模型未稳定生成最终评审，系统兜底记录当前状态。",
        "最终质量以 runtime-report、local-verification 和中文编码脚本结果为准。",
        "如果本地验证出现警告，本次 smoke runner 会返回失败状态。"
      ])
    ),
    retryPrompt: hardWritePrompt(
      stageFinalReview,
      toWorkspacePath(join(outputRoot, "reports", "review.md")),
      [
        `Create ${toWorkspacePath(join(outputRoot, "reports", "review.md"))}.`,
        "Write a concise Chinese final review.",
        "Mention quality score, selector contract status, encoding status, missing interaction details, and next improvements."
      ].join("\n")
    ),
    prompt: stagePrompt(
      stageFinalReview,
      [
        "Read the generated UI files and encoding report.",
        `Read ${toWorkspacePath(join(outputRoot, "index.html"))}.`,
        `Read ${toWorkspacePath(join(outputRoot, "styles.css"))}.`,
        `Read ${toWorkspacePath(join(outputRoot, "app.js"))}.`,
        `Read ${toWorkspacePath(join(outputRoot, "reports", "encoding-check.json"))}.`,
        `Create ${toWorkspacePath(join(outputRoot, "reports", "review.md"))}.`,
        "The review must be Chinese and include quality score, missing interaction details, encoding status, and next improvements."
      ].join("\n")
    ),
    requiredFiles: [toWorkspacePath(join(outputRoot, "reports", "review.md"))],
    stopWhenRequirementsMet: true
  }
];

let currentStage = "";
let currentStageIndex = -1;

const suite = await runRuntimeStageSuite({
  workspaceRoot: repoRoot,
  stages,
  maxContextMessages: 8,
  stopOnRequirementFailure: true,
  probe: {
    maxStoredEvents: 100,
    onEvent(event, report) {
      writeFileSync(progressPath, JSON.stringify({ outputRoot, currentStage, currentStageIndex, currentEvent: event.type, report }, null, 2), "utf8");
    }
  },
  createRuntime({ stage, attempt, initialMessages }) {
    const toolChoice: OpenAICompatibleToolChoice | undefined =
      stage.name === stageHtml || (attempt > 1 && (stage.name === stageCss || stage.name === stageJs))
        ? { type: "function", name: "write_file" }
        : undefined;
    return new AgentRuntime({
      cwd: repoRoot,
      provider: makeProvider(toolChoice),
      tools: createUiGenerationTools(),
      permissionPolicy: createPermissionPolicy({ mode: "project" }),
      initialMessages,
      maxTurns: 10,
      toolOutputBudget: {
        inlineChars: 12_000,
        artifactChars: 100_000,
        artifactDir: join(outputRoot, "artifacts")
      },
      recovery: {
        enabled: true,
        maxConsecutiveToolErrors: 2,
        maxRepeatedToolCalls: 3,
        maxSteeringMessages: 1
      }
    });
  },
  onStageStart(stage, index) {
    currentStage = stage.name;
    currentStageIndex = index;
    writeFileSync(progressPath, JSON.stringify({ outputRoot, stage: stage.name, index, status: "started" }, null, 2), "utf8");
  },
  onStageComplete(result, suiteResult) {
    writeFileSync(progressPath, JSON.stringify({ outputRoot, stage: result.name, status: "completed", result, suite: suiteResult }, null, 2), "utf8");
  }
});

function createUiGenerationTools() {
  const options = {
    workspaceRoot: repoRoot,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 12_000
  };
  return [
    ...createLocalWorkspaceTools(options),
    createWriteFileTool(options)
  ].filter((tool) => tool.name !== "restore_file_snapshot" && tool.name !== "restore_workspace_checkpoint");
}

const finalPath = join(outputRoot, "runtime-report.json");
const verificationPath = join(outputRoot, "reports", "local-verification.json");
const localVerification = buildLocalVerification();
writeFileSync(verificationPath, JSON.stringify(localVerification, null, 2), "utf8");
const localVerificationErrors = localVerification.warnings.map((warning) => `local verification: ${warning}`);
const errors = [...suite.errors, ...localVerificationErrors];
writeFileSync(finalPath, JSON.stringify({ outputRoot, suite, localVerification, errors }, null, 2), "utf8");

console.log(
  JSON.stringify(
    {
      outputRoot,
      finalPath,
      verificationPath,
      iterationCount,
      completedStageCount: suite.completedStageCount,
      stoppedAtStage: suite.stoppedAtStage,
      errors,
      localWarnings: localVerification.warnings,
      aggregateToolCallsByName: suite.aggregateToolCallsByName
    },
    null,
    2
  )
);
if (errors.length > 0) {
  process.exitCode = 1;
}

function buildLocalVerification(): {
  outputRoot: string;
  generatedFiles: Record<string, boolean>;
  stageMetrics: Array<{
    name: string;
    attemptCount: number;
    durationMs: number;
    firstEventMs: Record<string, number>;
    toolCallsByName: Record<string, number>;
    attemptErrors: string[];
  }>;
  anchors: Record<string, boolean>;
  interactionContract: Record<string, boolean | number>;
  systemQuality: UiQualityGate;
  warnings: string[];
} {
  const htmlPath = join(outputRoot, "index.html");
  const cssPath = join(outputRoot, "styles.css");
  const jsPath = join(outputRoot, "app.js");
  const html = readOptionalText(htmlPath);
  const css = readOptionalText(cssPath);
  const js = readOptionalText(jsPath);
  const warnings: string[] = [];
  const systemQuality = evaluateSystemUiQuality({ html, css, js });
  const anchors = {
    ranCommands: html.includes("\u5df2\u8fd0\u884c"),
    toolCall: html.includes("\u5de5\u5177\u8c03\u7528"),
    subAgent: html.includes("\u5b50\u667a\u80fd\u4f53"),
    edited: html.includes("\u5df2\u7f16\u8f91"),
    added: html.includes("\u65b0\u589e"),
    deleted: html.includes("\u5220\u9664")
  };
  for (const [name, passed] of Object.entries(anchors)) {
    if (!passed) warnings.push(`missing html anchor: ${name}`);
  }
  const forbiddenEnglishLabels = html.match(/\b(Add|Delete|Run|Tool|Agent|Command|Edited)\b/g) ?? [];
  if (forbiddenEnglishLabels.length > 0) {
    warnings.push(`visible English UI labels found: ${Array.from(new Set(forbiddenEnglishLabels)).join(", ")}`);
  }

  const interactionContract = {
    hasToolSummary: html.includes("tool-summary"),
    hasToolContainer: html.includes("msg--tools"),
    hasToolRows: html.includes("tool-row"),
    hasDiffHeader: html.includes("diff__header"),
    hasSubAgentItems: html.includes("sub-agent-item"),
    jsMentionsToolSummary: js.includes(".tool-summary"),
    jsMentionsToolContainer: js.includes(".msg--tools"),
    jsUsesExpandedState: js.includes("data-tools-expanded"),
    jsUsesEventDelegation: /addEventListener\(['"]click['"]/.test(js) && /(?:event\.target|target)\.closest\(/.test(js),
    toolSummaryInitCalls: countOccurrences(js, "initToolSummaryToggle();")
  };
  if (!interactionContract.jsUsesEventDelegation) {
    warnings.push("tool summary handlers should use event delegation for dynamic tool rows");
  } else if (Number(interactionContract.toolSummaryInitCalls) > 1) {
    warnings.push("tool summary handlers may be rebound; avoid repeated initializer calls");
  }
  if (!interactionContract.hasToolSummary || !interactionContract.jsMentionsToolSummary) {
    warnings.push("tool summary selector contract is incomplete");
  }
  if (!interactionContract.hasToolContainer || !interactionContract.jsMentionsToolContainer) {
    warnings.push("tool container selector contract is incomplete");
  }
  warnings.push(...systemQuality.warnings.map((warning) => `system quality failed: ${warning}`));

  return {
    outputRoot,
    generatedFiles: {
      indexHtml: existsSync(htmlPath),
      stylesCss: existsSync(cssPath),
      appJs: existsSync(jsPath),
      encodingCheck: existsSync(join(outputRoot, "reports", "encoding-check.json")),
      review: existsSync(join(outputRoot, "reports", "review.md"))
    },
    stageMetrics: suite.stages.map((stage) => ({
      name: stage.name,
      attemptCount: stage.attemptCount ?? 1,
      durationMs: stage.durationMs,
      firstEventMs: stage.report.firstEventMs as Record<string, number>,
      toolCallsByName: stage.report.toolCallsByName,
      attemptErrors: stage.attemptErrors ?? []
    })),
    anchors,
    interactionContract,
    systemQuality,
    warnings
  };
}

function readOptionalText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function countOccurrences(input: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = input.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = input.indexOf(needle, index + needle.length);
  }
  return count;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
