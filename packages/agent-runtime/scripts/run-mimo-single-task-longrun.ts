import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentRuntime,
  createTextMessage,
  OpenAICompatibleProvider,
  createLocalWorkspaceTools,
  createPermissionPolicy,
  loadOpenAICompatibleProviderConfig,
  runRuntimeWithProbe,
  type AgentMessage,
  type ContextSummarizer,
  type ContextSummaryRequest,
  type RuntimeProbeReport
} from "../src/index";
import { evaluateSystemUiQuality, type UiQualityGate } from "./ui-quality-gate";

interface GoalPassReport {
  pass: number;
  promptKind: "initial" | "goal-continue";
  report: RuntimeProbeReport;
  verification: GoalVerification;
}

interface GoalVerification {
  generatedFiles: Record<string, boolean>;
  anchors: Record<string, boolean>;
  interactionContract: Record<string, boolean | number>;
  systemDepth: Record<string, boolean | number>;
  systemQuality: UiQualityGate;
  systemArtifacts: Record<string, boolean>;
  artifactValidation: Record<string, boolean | number | string>;
  iterationReports: { expected: number; actual: number };
  goalStatus: { exists: boolean; completed: boolean; todoCount: number; parseError?: string };
  warnings: string[];
}

const providerConfigPath = process.env.FLOWBIT_PROVIDER_CONFIG ?? ".tmp/agent-runtime-flowbit-provider-mimo-v25-stream.json";
const providerConfig = await loadOpenAICompatibleProviderConfig(providerConfigPath);
const repoRoot = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const configuredOutputRoot = process.env.MIMO_SINGLE_TASK_OUTPUT_ROOT?.trim();
const outputRoot = configuredOutputRoot || join(".tmp", `mimo-v25-single-task-${stamp}`);
const reportDir = join(outputRoot, "reports");
const partialPath = join(outputRoot, "single-task-report.partial.json");
const finalPath = join(outputRoot, "single-task-report.json");
const artifactDir = join(outputRoot, "artifacts");
const hasExistingOutput = existsSync(join(outputRoot, "index.html")) || existsSync(partialPath);
const resumeElapsedMs = readResumeElapsedMs(partialPath);
const minWorkDurationMs = readNonNegativeIntegerEnv("MIMO_SINGLE_TASK_MIN_MS", 15 * 60_000);
const iterationCount = readNonNegativeIntegerEnv("MIMO_SINGLE_TASK_ITERATIONS", 10);
const maxGoalPasses = readNonNegativeIntegerEnv("MIMO_GOAL_MAX_PASSES", 8);
const mimoContextWindowTokens = readNonNegativeIntegerEnv("MIMO_CONTEXT_WINDOW_TOKENS", 1_000_000);
const mimoCompressionThresholdTokens = readNonNegativeIntegerEnv("MIMO_COMPRESSION_THRESHOLD_TOKENS", 200_000);
const mimoCompressionRecentTokens = readNonNegativeIntegerEnv("MIMO_COMPRESSION_RECENT_TOKENS", 80_000);

mkdirSync(reportDir, { recursive: true });

function toWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: providerConfig.baseUrl,
    apiKey: providerConfig.apiKey,
    apiKeyEnv: providerConfig.apiKeyEnv,
    apiKeyFile: providerConfig.apiKeyFile,
    model: providerConfig.model ?? "mimo-v2.5",
    endpoint: providerConfig.endpoint ?? "responses",
    authHeader: providerConfig.authHeader,
    maxTokens: 8192,
    topP: 0.95,
    reasoningContent: "require",
    stream: true,
    requestTimeoutMs: 240_000,
    firstByteTimeoutMs: 120_000,
    streamIdleTimeoutMs: 180_000,
    diagnostics: true,
    retry: { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 8000, totalBudgetMs: 240_000, jitterRatio: 0.2 }
  });
}

function createMimoContextSummarizer(): ContextSummarizer {
  return {
    async summarize(request: ContextSummaryRequest): Promise<string> {
      const provider = makeProvider();
      const prompt = buildContextSummaryPrompt(request);
      let output = "";
      let error: string | undefined;

      for await (const event of provider.stream({
        sessionId: `context-summary-${Date.now()}`,
        cwd: repoRoot,
        systemPrompt: [
          "你是长程 Agent 的上下文整理器。",
          "你只输出可继续工作的中文结构化摘要，不回答历史消息中的请求。",
          "必须保留当前目标、未完成任务、关键决定、失败诊断、文件证据、最近命令和下一步。"
        ].join("\n"),
        messages: [createTextMessage("user", prompt)],
        tools: [],
        signal: new AbortController().signal
      })) {
        if (event.type === "text-delta") output += event.text;
        if (event.type === "stop" && event.reason === "error") error = event.error ?? "context summary failed";
      }

      const summary = output.trim();
      if (summary) return summary;
      return fallbackContextSummary(request, error);
    }
  };
}

function buildContextSummaryPrompt(request: ContextSummaryRequest): string {
  return [
    "# 压缩目标",
    "",
    `触发方式：${request.trigger}`,
    `最大摘要 token：${request.maxSummaryTokens}`,
    "",
    "# 必须遵守",
    "",
    "- 这是 reference-only 的上下文交接，不要把旧请求当成新请求继续执行。",
    "- 最新用户消息和最近尾部原文会由系统保留，你只整理被压缩的较早内容。",
    "- 不传递思考过程，只保留用户可见正文、工具调用事实、失败诊断和证据。",
    "- 已完成任务必须写成已完成，避免后续模型重复做。",
    "- 未完成任务必须结构化列出，方便 /goal continue 精细拆解。",
    "",
    "# 输出格式",
    "",
    "## 当前目标",
    "## 用户约束",
    "## 已完成",
    "## 进行中",
    "## 未完成",
    "## 关键决定",
    "## 文件与证据",
    "## 最近成功命令",
    "## 最近失败诊断",
    "## 下一步",
    "",
    "# 系统状态",
    "",
    `上一轮摘要：\n${request.previousSummary || "无"}`,
    "",
    `已完成任务摘要：\n${request.completedTaskSummaries.join("\n") || "无"}`,
    "",
    `待办任务：\n${request.pendingTasks.join("\n") || "无"}`,
    "",
    `最近会话事件：\n${request.sessionEvents.join("\n") || "无"}`,
    "",
    `文件快照提示：\n${request.fileSnapshotHints.join("\n") || "无"}`,
    "",
    `最近成功命令：\n${request.recentSuccessfulCommands.join("\n") || "无"}`,
    "",
    `最近失败诊断：\n${request.recentFailedDiagnostics.join("\n") || "无"}`,
    "",
    "# 被压缩的历史",
    "",
    request.serializedConversation
  ].join("\n");
}

function fallbackContextSummary(request: ContextSummaryRequest, error?: string): string {
  return [
    "## 当前目标",
    "系统尝试压缩较早上下文，但摘要模型没有返回有效正文。",
    "",
    "## 未完成",
    ...request.pendingTasks.map((task) => `- ${task}`),
    "",
    "## 最近成功命令",
    ...request.recentSuccessfulCommands.map((command) => `- ${command}`),
    "",
    "## 最近失败诊断",
    ...request.recentFailedDiagnostics.map((diagnostic) => `- ${diagnostic}`),
    "",
    "## 文件与证据",
    ...request.fileSnapshotHints.map((hint) => `- ${hint}`),
    "",
    "## 压缩异常",
    error ? `- ${error}` : "- 摘要为空，系统保留最近上下文尾部继续执行。"
  ].join("\n");
}

function createRuntime(initialMessages: AgentMessage[]): AgentRuntime {
  return new AgentRuntime({
    cwd: repoRoot,
    provider: makeProvider(),
    initialMessages,
    tools: createUiGenerationTools(),
    permissionPolicy: createPermissionPolicy({ mode: "project" }),
    maxTurns: 80,
    toolOutputBudget: {
      inlineChars: 12_000,
      artifactChars: 100_000,
      artifactDir
    },
    contextCompression: {
      enabled: true,
      contextWindowTokens: mimoContextWindowTokens,
      thresholdTokens: mimoCompressionThresholdTokens,
      targetRecentTokens: mimoCompressionRecentTokens,
      minRecentMessages: 8,
      minMessagesToCompress: 8,
      maxSummaryTokens: 8_000,
      summarizer: createMimoContextSummarizer(),
      toolOutputBudget: {
        inlineChars: 4_000,
        artifactChars: 100_000,
        artifactDir
      }
    },
    recovery: {
      enabled: true,
      maxConsecutiveToolErrors: 2,
      maxRepeatedToolCalls: 3,
      maxSteeringMessages: 2
    }
  });
}

function createUiGenerationTools() {
  return createLocalWorkspaceTools({
    workspaceRoot: repoRoot,
    defaultTimeoutMs: 45_000,
    maxOutputBytes: 20_000
  }).filter((tool) => tool.name !== "restore_file_snapshot" && tool.name !== "restore_workspace_checkpoint");
}

function buildInitialPrompt(): string {
  const output = toWorkspacePath(outputRoot);
  const reports = toWorkspacePath(reportDir);
  const iterationReports = Array.from({ length: iterationCount }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return `${reports}/iteration-${n}.md`;
  });

  return [
    "# 单次目标任务",
    "",
    "你现在执行一个完整目标，而不是一次普通问答。目标没有完成前，不要主动停下。",
    "如果你阶段性停下，系统会继续发送 /goal continue，要求你根据已做/待做继续拆解。",
    "",
    "# 最终目标",
    "",
    "生成一个像系统软件而不是简单网页的中文智能体工作台演示项目。",
    `输出目录：${output}`,
    "",
    "# 必须读取的参考",
    "",
    "- docs/mimo-agent-ui-longrun-spec.md",
    "- docs/agent-longrun-self-iteration-ui-protocol.md",
    "- replicate_ui/css/base.css",
    "- replicate_ui/css/chat.css",
    "- replicate_ui/css/subagents.css",
    "",
    "# 必须生成的文件",
    "",
    `- ${output}/README.md`,
    `- ${output}/index.html`,
    `- ${output}/styles.css`,
    `- ${output}/app.js`,
    `- ${reports}/product-blueprint.md`,
    `- ${reports}/data-contract.json`,
    `- ${reports}/task-ledger.json`,
    `- ${reports}/iteration-ledger.json`,
    `- ${reports}/evidence-ledger.json`,
    `- ${reports}/event-binding-audit.md`,
    `- ${reports}/ui-self-review.md`,
    ...iterationReports.map((file) => `- ${file}`),
    `- ${reports}/encoding-check.json`,
    `- ${reports}/final-review.md`,
    `- ${reports}/goal-status.json`,
    "",
    "# 先规划再实现",
    "",
    "禁止直接从 index.html 开始。第一步必须先生成 product-blueprint.md、data-contract.json、task-ledger.json、evidence-ledger.json。",
    "product-blueprint.md 必须说明产品目标、信息架构、数据对象、事件模型、验收清单。",
    "data-contract.json 必须包含 dataObjects、renderTargets、eventBindings、runtimeStates、recoveryActions 五个数组。",
    "task-ledger.json 必须包含 tasks 数组，每项包含 id、title、status、owner、evidenceIds、remaining。",
    "iteration-ledger.json 必须包含 iterations 数组，每项包含 iteration、focus、checked、findings、changes、next。",
    "evidence-ledger.json 必须包含 evidence 数组，每项包含 id、type、source、summary、supports。",
    "event-binding-audit.md 必须逐项说明哪些按钮、摘要行、工具行、任务项、证据项已经绑定事件，以及对应选择器。",
    "ui-self-review.md 必须从产品完整度、数据逻辑、事件绑定、编码、验收证据五个维度自评。",
    "index.html、styles.css、app.js 必须体现这些账本和数据结构，不能只是静态展示几块卡片。",
    "",
    "# 系统软件深度要求",
    "",
    "界面不能是一个简陋落地页，必须像一个真实桌面端系统软件。至少包含：",
    "- 明确禁止：单栏介绍页、纯卡片堆叠页、只有标题和几块演示内容的页面、没有真实侧栏/工作区/检查器的页面。",
    "- 必须采用桌面软件骨架：顶部状态栏 + 左侧纵向导航 + 中央消息/任务工作区 + 右侧检查器 + 底部或侧边事件流。",
    "- HTML 必须真实使用 header、aside、main、nav、section、button，不能只靠 class 名字伪装系统结构。",
    "- 至少 6 个 section、12 个 button、1 个输入控件、2 组连续工具调用样例、2 个 diff 块、3 个子智能体状态项。",
    "- 顶部状态栏：显示模型、会话、运行状态、资源探针。",
    "- 左侧导航：任务账本、对话流、工具调用、子智能体、记忆、检查点、设置。",
    "- 主工作区：正文与工具调用混排，连续工具调用摘要行，三级展开。",
    "- 右侧检查器：当前任务、待办、性能、权限、上下文预算、最近文件。",
    "- 底部或侧边事件流：显示运行中、已完成、已修复、需复核。",
    "- 自我迭代区：必须可见展示迭代账本、证据账本、数据契约、事件绑定、质量门槛、继续执行、暂停、回退。",
    "- 数据逻辑：app.js 必须声明或加载 taskLedger、iterationLedger、evidenceLedger、messageStream、toolBatches、subagents、fileChanges、runtimeProbe，并用这些数据渲染界面。",
    "- 红绿差异块：新增绿色、删除红色，并有行前色块。",
    "- 不要用大面积背景、厚描边、重阴影或炫技渐变来假装层级；层级主要靠留白、排版、轻分割线和浅灰激活态。",
    "",
    "# 可见中文合同",
    "",
    "可见 UI 文案必须全中文。不要在 HTML 可见文本里写 MiMo Agent、Agent、Tool、Command、Run、Edited、Add、Delete。",
    "可见产品名必须是中文，例如：智能体工作台。",
    "index.html 必须保留这些中文锚点：已运行、工具调用、子智能体、已编辑、新增、删除、任务账本、上下文、检查点、权限、性能探针、记忆。",
    "index.html 还必须包含这些系统场景：输入区、事件流、文件变更、运行记录、待办、资源占用、风险确认。",
    "index.html 必须保留这些选择器或属性：msg--tools、tool-summary、tool-row、diff__header、diff__line--add、diff__line--remove、sub-agent-item、data-tools-expanded。",
    "app.js 必须使用事件委托，包含 addEventListener、closest(、.tool-summary、.msg--tools、data-tools-expanded。",
    "app.js 的工具摘要点击逻辑必须使用 toolSummary.closest('.msg--tools') 找到最近工具容器，并切换 data-tools-expanded；不要用 '.tool-container' 替代 '.msg--tools'。",
    "",
    "# 目标循环要求",
    "",
    `你需要完成 ${iterationCount} 轮自查与修正。每轮都要读取 index.html、styles.css、app.js，并至少使用一个只读 shell_command 或 search_files 检查选择器、中文文案或事件绑定。`,
    "每轮必须写 iteration-XX.md。如果发现问题，可以改一个 UI 文件；如果没有问题，就在报告里写清未改动原因。",
    "每轮还必须更新 iteration-ledger.json 和 evidence-ledger.json。发现结构、样式、事件或中文问题时，要把问题写入 task-ledger.json 的 remaining 或新增待办。",
    "如果 task-ledger.json 仍有 pending、running 或 blocked 项，goal-status.json 禁止写 completed。",
    "如果质量检查出现 too small、desktop shell incomplete、css layout incomplete、js interactions incomplete，必须改 index.html、styles.css 或 app.js，不要只改报告。",
    "如果质量检查出现 runtime data model too thin 或 self-iteration surface too thin，必须补 app.js 数据模型和 index.html 可见自我迭代界面。",
    "每次停下前都必须更新 reports/goal-status.json，格式为 JSON：",
    '{"status":"in_progress|completed","done":["..."],"todo":["..."],"next_steps":["..."],"acceptance":["..."]}',
    "只有当你确认所有文件、所有迭代、所有中文和系统深度要求都完成时，才能把 status 写成 completed，并且 todo 必须为空数组。",
    "每次准备标记 completed 前，必须运行：",
    `npx tsx packages/agent-runtime/scripts/check-ui-quality.ts ${output}`,
    "如果该命令输出 warnings，必须先按具体计数修复，不允许把 goal-status.json 写成 completed。",
    "",
    "# 执行限制",
    "",
    "不要修改 replicate_ui，不要删除任何已有 .tmp 项目。",
    "不要调用 restore_file_snapshot，除非你手里有工具返回的真实 snapshotPath；不能把普通工作区文件路径当成 snapshotPath。",
    "如果工具失败，换参数或换策略继续，不要重复同一个错误。"
  ].join("\n");
}

function buildGoalContinuePrompt(pass: number, verification: GoalVerification, totalDurationMs: number): string {
  const done = doneItems(verification);
  const todo = pendingItems(verification, totalDurationMs);
  return [
    "/goal continue",
    "",
    `这是第 ${pass} 次目标续跑。你刚才停下了，但系统验收还没有完全通过。`,
    "请不要解释你为什么停下，直接继续执行剩余任务。",
    "",
    "## 已完成",
    ...done.map((item) => `- ${item}`),
    "",
    "## 待做和失败项",
    ...todo.map((item) => `- ${item}`),
    "",
    "## 继续要求",
    "",
    "1. 先读取 reports/goal-status.json、reports/task-ledger.json、reports/iteration-ledger.json、reports/evidence-ledger.json、reports/data-contract.json、index.html、styles.css、app.js。",
    `2. 运行 npx tsx packages/agent-runtime/scripts/check-ui-quality.ts ${toWorkspacePath(outputRoot)}，按 metrics 里的数字补齐结构。`,
    "3. 对待做项进行精细拆解，不要泛泛而谈。",
    "4. 优先修复系统验收失败项，再补 UI 深度；如果出现 too small、desktop shell incomplete、css layout incomplete、js interactions incomplete，必须改对应 UI 文件。",
    `5. 再运行 npx tsx packages/agent-runtime/scripts/check-ui-quality.ts ${toWorkspacePath(outputRoot)}，确认具体计数已经补齐。`,
    "6. 更新 product-blueprint.md、data-contract.json、task-ledger.json、iteration-ledger.json、evidence-ledger.json、event-binding-audit.md 中实际变化的部分。",
    "7. 更新必要 UI 文件和本轮 iteration 报告。页面必须能看见迭代账本、证据账本、数据契约、事件绑定、质量门槛和恢复动作。",
    "8. 最后更新 reports/goal-status.json。只有系统验收项都满足、任务账本没有未完成项、证据覆盖验收项时，status 才能写 completed，todo 必须为空数组。",
    "9. 不要调用 restore_file_snapshot，除非你手里有工具返回的真实 snapshotPath；不能把普通文件路径当成 snapshotPath。",
    "",
    `输出目录：${toWorkspacePath(outputRoot)}`
  ].join("\n");
}

const startedAt = Date.now();
const passReports: GoalPassReport[] = [];
let messages: AgentMessage[] = [];
let finalVerification = buildVerification(elapsedMs());
let completed = false;

for (let pass = 1; pass <= maxGoalPasses; pass++) {
  const promptKind = pass === 1 && !hasExistingOutput ? "initial" : "goal-continue";
  const prompt = promptKind === "initial" ? buildInitialPrompt() : buildGoalContinuePrompt(pass, finalVerification, elapsedMs());
  const runtime = createRuntime(messages);
  const probe = await runRuntimeWithProbe(runtime, prompt, {
    maxStoredEvents: 200,
    onEvent(event, report) {
      writePartial(pass, promptKind, event.type, report, finalVerification);
    }
  });

  messages = probe.messages;
  finalVerification = buildVerification(elapsedMs());
  passReports.push({ pass, promptKind, report: probe.report, verification: finalVerification });
  writePartial(pass, promptKind, "pass-complete", probe.report, finalVerification);

  if (isGoalComplete(finalVerification, elapsedMs()) && probe.report.errors.length === 0) {
    completed = true;
    break;
  }
}

const totalDurationMs = elapsedMs();
const errors = [
  ...passReports.flatMap((pass) => pass.report.errors.map((error) => `pass ${pass.pass}: ${error}`)),
  ...finalVerification.warnings.map((warning) => `local verification: ${warning}`)
];
if (!completed) errors.push(`goal loop stopped before completion after ${maxGoalPasses} pass(es)`);

writeFileSync(
  finalPath,
  JSON.stringify(
    {
      outputRoot,
      finalPath,
      resumed: hasExistingOutput,
      resumeElapsedMs,
      minWorkDurationMs,
      iterationCount,
      maxGoalPasses,
      contextCompression: {
        contextWindowTokens: mimoContextWindowTokens,
        thresholdTokens: mimoCompressionThresholdTokens,
        targetRecentTokens: mimoCompressionRecentTokens
      },
      completed,
      totalDurationMs,
      durationMinutes: Math.round((totalDurationMs / 60_000) * 100) / 100,
      passReports,
      finalVerification,
      errors
    },
    null,
    2
  ),
  "utf8"
);

console.log(
  JSON.stringify(
    {
      outputRoot,
      finalPath,
      resumed: hasExistingOutput,
      resumeElapsedMs,
      completed,
      durationMs: totalDurationMs,
      durationMinutes: Math.round((totalDurationMs / 60_000) * 100) / 100,
      passCount: passReports.length,
      contextCompression: {
        contextWindowTokens: mimoContextWindowTokens,
        thresholdTokens: mimoCompressionThresholdTokens,
        targetRecentTokens: mimoCompressionRecentTokens
      },
      aggregateToolCallsByName: aggregateToolCalls(passReports),
      errors,
      warnings: finalVerification.warnings
    },
    null,
    2
  )
);

if (errors.length > 0) {
  process.exitCode = 1;
}

function writePartial(
  pass: number,
  promptKind: "initial" | "goal-continue",
  currentEvent: string,
  report: RuntimeProbeReport,
  verification: GoalVerification
): void {
  writeFileSync(
    partialPath,
    JSON.stringify(
      {
        outputRoot,
        resumed: hasExistingOutput,
        resumeElapsedMs,
        pass,
        promptKind,
        currentEvent,
        elapsedMs: elapsedMs(),
        report,
        verification
      },
      null,
      2
    ),
    "utf8"
  );
}

function buildVerification(totalDurationMs: number): GoalVerification {
  const htmlPath = join(outputRoot, "index.html");
  const cssPath = join(outputRoot, "styles.css");
  const jsPath = join(outputRoot, "app.js");
  const goalStatusPath = join(reportDir, "goal-status.json");
  const html = readOptionalText(htmlPath);
  const css = readOptionalText(cssPath);
  const js = readOptionalText(jsPath);
  const warnings: string[] = [];
  const systemQuality = evaluateSystemUiQuality({
    html,
    css,
    js,
    minHtmlChars: 18_000,
    minCssChars: 14_000,
    minJsChars: 6_000,
    requireSelfIteration: true
  });

  const generatedFiles = {
    readme: existsSync(join(outputRoot, "README.md")),
    indexHtml: existsSync(htmlPath),
    stylesCss: existsSync(cssPath),
    appJs: existsSync(jsPath),
    encodingCheck: existsSync(join(reportDir, "encoding-check.json")),
    finalReview: existsSync(join(reportDir, "final-review.md")),
    goalStatus: existsSync(goalStatusPath)
  };
  for (const [name, passed] of Object.entries(generatedFiles)) {
    if (!passed) warnings.push(`missing file: ${name}`);
  }

  const systemArtifacts = {
    productBlueprint: existsSync(join(reportDir, "product-blueprint.md")),
    dataContract: existsSync(join(reportDir, "data-contract.json")),
    taskLedger: existsSync(join(reportDir, "task-ledger.json")),
    iterationLedger: existsSync(join(reportDir, "iteration-ledger.json")),
    evidenceLedger: existsSync(join(reportDir, "evidence-ledger.json")),
    eventBindingAudit: existsSync(join(reportDir, "event-binding-audit.md")),
    uiSelfReview: existsSync(join(reportDir, "ui-self-review.md"))
  };
  for (const [name, passed] of Object.entries(systemArtifacts)) {
    if (!passed) warnings.push(`missing system artifact: ${name}`);
  }

  const artifactValidation = validateSystemArtifacts();
  for (const warning of artifactValidationWarnings(artifactValidation)) {
    warnings.push(warning);
  }

  const anchors = {
    ranCommands: html.includes("已运行"),
    toolCall: html.includes("工具调用"),
    subAgent: html.includes("子智能体"),
    edited: html.includes("已编辑"),
    added: html.includes("新增"),
    deleted: html.includes("删除"),
    taskLedger: html.includes("任务账本"),
    context: html.includes("上下文"),
    checkpoint: html.includes("检查点"),
    permission: html.includes("权限"),
    performanceProbe: html.includes("性能探针"),
    memory: html.includes("记忆"),
    selfIteration: html.includes("自我迭代") || html.includes("迭代账本"),
    evidenceLedger: html.includes("证据账本") || html.includes("证据链"),
    dataContract: html.includes("数据契约") || html.includes("数据流"),
    eventBinding: html.includes("事件绑定") || html.includes("事件委托"),
    qualityGate: html.includes("质量门槛") || html.includes("系统验收"),
    recoveryActions: html.includes("继续执行") && html.includes("暂停") && (html.includes("回退") || html.includes("恢复"))
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
    hasAddDiff: html.includes("diff__line--add"),
    hasRemoveDiff: html.includes("diff__line--remove"),
    hasSubAgentItems: html.includes("sub-agent-item"),
    jsMentionsToolSummary: js.includes(".tool-summary"),
    jsMentionsToolContainer: js.includes(".msg--tools"),
    jsUsesExpandedState: js.includes("data-tools-expanded"),
    jsUsesEventDelegation: /addEventListener\(['"]click['"]/.test(js) && /(?:event\.target|target)\.closest\(/.test(js)
  };
  for (const [name, passed] of Object.entries(interactionContract)) {
    if (!passed) warnings.push(`interaction contract failed: ${name}`);
  }

  const systemDepth = {
    ...systemQuality.metrics
  };
  warnings.push(...systemQuality.warnings.map((warning) => `system quality failed: ${warning}`));

  const actualIterationReports = Array.from({ length: iterationCount }, (_, index) =>
    existsSync(join(reportDir, `iteration-${String(index + 1).padStart(2, "0")}.md`))
  ).filter(Boolean).length;
  const iterationReports = { expected: iterationCount, actual: actualIterationReports };
  if (actualIterationReports < iterationCount) {
    warnings.push(`iteration reports missing: ${actualIterationReports}/${iterationCount}`);
  }

  const goalStatus = readGoalStatus(goalStatusPath);
  if (!goalStatus.exists) warnings.push("goal status missing");
  if (goalStatus.exists && !goalStatus.completed) warnings.push("goal status is not completed");
  if (goalStatus.todoCount > 0) warnings.push(`goal status has todo items: ${goalStatus.todoCount}`);
  if (goalStatus.parseError) warnings.push(`goal status parse error: ${goalStatus.parseError}`);

  if (totalDurationMs > 0 && totalDurationMs < minWorkDurationMs) {
    warnings.push(`work duration below target: ${totalDurationMs}ms < ${minWorkDurationMs}ms`);
  }

  return {
    generatedFiles,
    anchors,
    interactionContract,
    systemDepth,
    systemQuality,
    systemArtifacts,
    artifactValidation,
    iterationReports,
    goalStatus,
    warnings
  };
}

function validateSystemArtifacts(): Record<string, boolean | number | string> {
  const dataContract = readJsonArtifact("data-contract.json");
  const taskLedger = readJsonArtifact("task-ledger.json");
  const iterationLedger = readJsonArtifact("iteration-ledger.json");
  const evidenceLedger = readJsonArtifact("evidence-ledger.json");
  const tasks = arrayFromLedger(taskLedger.value, "tasks");
  const iterations = arrayFromLedger(iterationLedger.value, "iterations");
  const evidence = arrayFromLedger(evidenceLedger.value, "evidence");
  const openTasks = tasks.filter((task) => {
    const status = stringField(task, "status");
    return status !== "done" && status !== "completed";
  });
  const dataObjectCount = arrayField(dataContract.value, "dataObjects").length;
  const renderTargetCount = arrayField(dataContract.value, "renderTargets").length;
  const eventBindingCount = arrayField(dataContract.value, "eventBindings").length;
  const runtimeStateCount = arrayField(dataContract.value, "runtimeStates").length;
  const recoveryActionCount = arrayField(dataContract.value, "recoveryActions").length;

  return {
    dataContractParseable: dataContract.ok,
    dataObjectCount,
    renderTargetCount,
    eventBindingCount,
    runtimeStateCount,
    recoveryActionCount,
    taskLedgerParseable: taskLedger.ok,
    taskCount: tasks.length,
    openTaskCount: openTasks.length,
    iterationLedgerParseable: iterationLedger.ok,
    iterationEntryCount: iterations.length,
    evidenceLedgerParseable: evidenceLedger.ok,
    evidenceCount: evidence.length,
    eventBindingAuditChars: readOptionalText(join(reportDir, "event-binding-audit.md")).length,
    productBlueprintChars: readOptionalText(join(reportDir, "product-blueprint.md")).length,
    uiSelfReviewChars: readOptionalText(join(reportDir, "ui-self-review.md")).length
  };
}

function artifactValidationWarnings(validation: Record<string, boolean | number | string>): string[] {
  const warnings: string[] = [];
  warnIf(validation.dataContractParseable !== true, "artifact invalid: data-contract.json is not parseable");
  warnIf(numberValidation(validation.dataObjectCount) < 6, `artifact invalid: dataObjects ${validation.dataObjectCount}/6`);
  warnIf(numberValidation(validation.renderTargetCount) < 4, `artifact invalid: renderTargets ${validation.renderTargetCount}/4`);
  warnIf(numberValidation(validation.eventBindingCount) < 6, `artifact invalid: eventBindings ${validation.eventBindingCount}/6`);
  warnIf(numberValidation(validation.runtimeStateCount) < 4, `artifact invalid: runtimeStates ${validation.runtimeStateCount}/4`);
  warnIf(numberValidation(validation.recoveryActionCount) < 3, `artifact invalid: recoveryActions ${validation.recoveryActionCount}/3`);
  warnIf(validation.taskLedgerParseable !== true, "artifact invalid: task-ledger.json is not parseable");
  warnIf(numberValidation(validation.taskCount) < 8, `artifact invalid: task count ${validation.taskCount}/8`);
  warnIf(numberValidation(validation.openTaskCount) > 0, `artifact invalid: open tasks remain ${validation.openTaskCount}`);
  warnIf(validation.iterationLedgerParseable !== true, "artifact invalid: iteration-ledger.json is not parseable");
  warnIf(numberValidation(validation.iterationEntryCount) < iterationCount, `artifact invalid: iteration ledger ${validation.iterationEntryCount}/${iterationCount}`);
  warnIf(validation.evidenceLedgerParseable !== true, "artifact invalid: evidence-ledger.json is not parseable");
  warnIf(numberValidation(validation.evidenceCount) < 8, `artifact invalid: evidence count ${validation.evidenceCount}/8`);
  warnIf(numberValidation(validation.eventBindingAuditChars) < 800, `artifact invalid: event-binding-audit.md too thin ${validation.eventBindingAuditChars}/800 chars`);
  warnIf(numberValidation(validation.productBlueprintChars) < 1_200, `artifact invalid: product-blueprint.md too thin ${validation.productBlueprintChars}/1200 chars`);
  warnIf(numberValidation(validation.uiSelfReviewChars) < 800, `artifact invalid: ui-self-review.md too thin ${validation.uiSelfReviewChars}/800 chars`);
  return warnings;

  function warnIf(condition: boolean, warning: string): void {
    if (condition) warnings.push(warning);
  }
}

function readGoalStatus(path: string): GoalVerification["goalStatus"] {
  if (!existsSync(path)) return { exists: false, completed: false, todoCount: 0 };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { status?: unknown; todo?: unknown };
    const todo = Array.isArray(data.todo) ? data.todo : [];
    return {
      exists: true,
      completed: data.status === "completed",
      todoCount: todo.length
    };
  } catch (cause) {
    return {
      exists: true,
      completed: false,
      todoCount: 0,
      parseError: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

function isGoalComplete(verification: GoalVerification, totalDurationMs: number): boolean {
  return verification.warnings.length === 0 && verification.goalStatus.completed && verification.goalStatus.todoCount === 0 && totalDurationMs >= minWorkDurationMs;
}

function doneItems(verification: GoalVerification): string[] {
  const items: string[] = [];
  for (const [name, passed] of Object.entries(verification.generatedFiles)) if (passed) items.push(`文件已存在：${name}`);
  for (const [name, passed] of Object.entries(verification.systemArtifacts)) if (passed) items.push(`系统产物已存在：${name}`);
  for (const [name, passed] of Object.entries(verification.anchors)) if (passed) items.push(`中文锚点已满足：${name}`);
  for (const [name, passed] of Object.entries(verification.interactionContract)) if (passed === true) items.push(`交互合同已满足：${name}`);
  items.push(`迭代报告：${verification.iterationReports.actual}/${verification.iterationReports.expected}`);
  return items.slice(0, 40);
}

function pendingItems(verification: GoalVerification, totalDurationMs: number): string[] {
  const items = [...verification.warnings, ...interactionContractHints(verification), ...qualityMetricHints(verification)];
  if (totalDurationMs < minWorkDurationMs) {
    items.push(`目标工作深度不足：当前 ${Math.round(totalDurationMs / 1000)} 秒，至少需要 ${Math.round(minWorkDurationMs / 1000)} 秒。不要空等，用更多系统化自查、修正和复核来补足。`);
  }
  return items.length > 0 ? items : ["系统未发现明确失败项，但你还没有把 goal-status.json 标记为 completed；请复核后完成。"];
}

function interactionContractHints(verification: GoalVerification): string[] {
  const hints: string[] = [];
  if (verification.warnings.some((warning) => warning.includes("jsMentionsToolContainer"))) {
    hints.push("交互合同修复：app.js 必须包含字面量 '.msg--tools'，工具摘要点击时应使用 toolSummary.closest('.msg--tools') 找到最近工具容器，不要使用 '.tool-container' 替代。");
  }
  if (verification.warnings.some((warning) => warning.includes("jsMentionsToolSummary"))) {
    hints.push("交互合同修复：app.js 必须包含字面量 '.tool-summary'，并通过事件委托监听工具摘要行点击。");
  }
  if (verification.warnings.some((warning) => warning.includes("jsUsesExpandedState"))) {
    hints.push("交互合同修复：app.js 必须读写 data-tools-expanded，用它控制连续工具调用摘要、工具行和详情的三级展开状态。");
  }
  if (verification.warnings.some((warning) => warning.includes("jsUsesEventDelegation"))) {
    hints.push("交互合同修复：app.js 必须使用 document.addEventListener('click', ...) 或消息流根节点事件委托，并使用 event.target.closest(...)。");
  }
  return hints;
}

function qualityMetricHints(verification: GoalVerification): string[] {
  const metric = verification.systemQuality.metrics;
  return [
    `质量计数：HTML ${metric.htmlChars}/18000，CSS ${metric.cssChars}/14000，JS ${metric.jsChars}/6000。`,
    `结构计数：header ${metric.semanticHeaderCount}/1，aside ${metric.semanticAsideCount}/1，main ${metric.semanticMainCount}/1，nav ${metric.semanticNavCount}/1，section ${metric.semanticSectionCount}/6。`,
    `控件计数：button ${metric.buttonCount}/12，输入控件 ${metric.formControlCount}/1。`,
    `工具流计数：tool-summary ${metric.toolSummaryCount}/2，tool-row ${metric.toolRowCount}/5，diff__header ${metric.diffHeaderCount}/2，sub-agent-item ${metric.subAgentItemCount}/3。`,
    `样式与脚本计数：CSS 变量 ${metric.cssVariableCount}/12，@media ${metric.responsiveRuleCount}/1，grid 标记 ${metric.gridLayoutCount}/1，委托点击 ${metric.eventDelegationCount}/1，closest ${metric.closestCallCount}/2，.tool-summary ${metric.jsMentionsToolSummary}，.msg--tools ${metric.jsMentionsToolContainer}，data-tools-expanded ${metric.jsUsesExpandedState}。`
  ];
}

function aggregateToolCalls(reports: GoalPassReport[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const pass of reports) {
    for (const [name, count] of Object.entries(pass.report.toolCallsByName)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
  }
  return counts;
}

function readOptionalText(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function readJsonArtifact(name: string): { ok: boolean; value?: unknown; error?: string } {
  const path = join(reportDir, name);
  if (!existsSync(path)) return { ok: false, error: "missing" };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function arrayFromLedger(value: unknown, key: string): Record<string, unknown>[] {
  const source = Array.isArray(value) ? value : value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(source) ? source.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberValidation(value: boolean | number | string | undefined): number {
  return typeof value === "number" ? value : 0;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function elapsedMs(): number {
  return resumeElapsedMs + Date.now() - startedAt;
}

function readResumeElapsedMs(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { elapsedMs?: unknown };
    return typeof parsed.elapsedMs === "number" && Number.isFinite(parsed.elapsedMs) && parsed.elapsedMs > 0
      ? Math.trunc(parsed.elapsedMs)
      : 0;
  } catch (err) {
    console.error(`[run-mimo] readResumeElapsedMs error: ${err}`);
    return 0;
  }
}
