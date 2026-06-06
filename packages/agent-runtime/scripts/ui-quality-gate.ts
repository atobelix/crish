export interface UiQualityGate {
  metrics: Record<string, boolean | number>;
  panelAnchors: Record<string, boolean>;
  warnings: string[];
}

export interface UiQualityGateInput {
  html: string;
  css: string;
  js: string;
  minHtmlChars?: number;
  minCssChars?: number;
  minJsChars?: number;
  requireSelfIteration?: boolean;
}

const DEFAULT_MIN_HTML_CHARS = 12_000;
const DEFAULT_MIN_CSS_CHARS = 12_000;
const DEFAULT_MIN_JS_CHARS = 5_000;

export function evaluateSystemUiQuality(input: UiQualityGateInput): UiQualityGate {
  const minHtmlChars = input.minHtmlChars ?? DEFAULT_MIN_HTML_CHARS;
  const minCssChars = input.minCssChars ?? DEFAULT_MIN_CSS_CHARS;
  const minJsChars = input.minJsChars ?? DEFAULT_MIN_JS_CHARS;
  const html = input.html;
  const css = input.css;
  const js = input.js;
  const requireSelfIteration = input.requireSelfIteration ?? false;

  const metrics: Record<string, boolean | number> = {
    htmlChars: html.length,
    cssChars: css.length,
    jsChars: js.length,
    semanticHeaderCount: countMatches(html, /<header\b/gi),
    semanticAsideCount: countMatches(html, /<aside\b/gi),
    semanticMainCount: countMatches(html, /<main\b/gi),
    semanticSectionCount: countMatches(html, /<section\b/gi),
    semanticNavCount: countMatches(html, /<nav\b/gi),
    buttonCount: countMatches(html, /<button\b/gi),
    formControlCount: countMatches(html, /<(?:input|textarea|select)\b/gi),
    toolSummaryCount: countOccurrences(html, "tool-summary"),
    toolRowCount: countOccurrences(html, "tool-row"),
    diffHeaderCount: countOccurrences(html, "diff__header"),
    diffAddLineCount: countOccurrences(html, "diff__line--add"),
    diffRemoveLineCount: countOccurrences(html, "diff__line--remove"),
    subAgentItemCount: countOccurrences(html, "sub-agent-item"),
    cssVariableCount: countMatches(css, /--[a-zA-Z0-9-]+\s*:/g),
    responsiveRuleCount: countMatches(css, /@media\b/g),
    gridLayoutCount: countMatches(css, /(?:display\s*:\s*grid|grid-template-columns)/g),
    eventDelegationCount: countMatches(js, /addEventListener\(['"]click['"]/g),
    closestCallCount: countOccurrences(js, ".closest(") + countOccurrences(js, "closest("),
    jsMentionsToolSummary: js.includes(".tool-summary"),
    jsMentionsToolContainer: js.includes(".msg--tools"),
    jsUsesExpandedState: js.includes("data-tools-expanded"),
    runtimeDataModelCount: countMatches(
      js,
      /\b(?:taskLedger|iterationLedger|evidenceLedger|messageStream|toolBatches|subagents|fileChanges|runtimeProbe|eventLedger|qualityGate)\b/g
    ),
    visibleSelfIterationAnchorCount: countMatches(
      html,
      /(?:自我迭代|迭代账本|证据账本|数据契约|数据流|事件绑定|质量门槛|恢复|继续执行|暂停|回退)/g
    ),
    hasSystemSizedHtml: html.length >= minHtmlChars,
    hasSystemSizedCss: css.length >= minCssChars,
    hasSystemSizedJs: js.length >= minJsChars
  };

  metrics.hasSemanticDesktopShell =
    numberMetric(metrics.semanticHeaderCount) >= 1 &&
    numberMetric(metrics.semanticAsideCount) >= 1 &&
    numberMetric(metrics.semanticMainCount) >= 1 &&
    numberMetric(metrics.semanticSectionCount) >= 6 &&
    numberMetric(metrics.semanticNavCount) >= 1;
  metrics.hasControlDensity = numberMetric(metrics.buttonCount) >= 12 && numberMetric(metrics.formControlCount) >= 1;
  metrics.hasToolFlowDensity =
    numberMetric(metrics.toolSummaryCount) >= 2 && numberMetric(metrics.toolRowCount) >= 5;
  metrics.hasDiffDensity =
    numberMetric(metrics.diffHeaderCount) >= 2 &&
    numberMetric(metrics.diffAddLineCount) >= 2 &&
    numberMetric(metrics.diffRemoveLineCount) >= 2;
  metrics.hasSubAgentDensity = numberMetric(metrics.subAgentItemCount) >= 3;
  metrics.hasCssSystemLayout =
    numberMetric(metrics.cssVariableCount) >= 12 &&
    numberMetric(metrics.responsiveRuleCount) >= 1 &&
    numberMetric(metrics.gridLayoutCount) >= 1;
  metrics.hasJsSystemInteractions =
    numberMetric(metrics.eventDelegationCount) >= 1 &&
    numberMetric(metrics.closestCallCount) >= 2 &&
    metrics.jsMentionsToolSummary === true &&
    metrics.jsMentionsToolContainer === true &&
    metrics.jsUsesExpandedState === true;
  metrics.hasRuntimeDataModel = numberMetric(metrics.runtimeDataModelCount) >= 7;
  metrics.hasSelfIterationSurface = numberMetric(metrics.visibleSelfIterationAnchorCount) >= 8;

  const panelAnchors = {
    taskLedger: includesAny(html, ["任务账本", "任务清单", "待办"]),
    iterationLedger: includesAny(html, ["迭代账本", "自我迭代", "迭代自查"]),
    evidenceLedger: includesAny(html, ["证据账本", "证据链", "验收证据"]),
    dataContract: includesAny(html, ["数据契约", "数据对象", "数据流"]),
    eventBinding: includesAny(html, ["事件绑定", "点击展开", "事件委托"]),
    qualityGate: includesAny(html, ["质量门槛", "验收门槛", "系统验收"]),
    recoveryControls: includesAny(html, ["继续执行", "暂停", "回退", "恢复"]),
    contextBudget: includesAny(html, ["上下文预算", "上下文"]),
    performanceProbe: includesAny(html, ["性能探针", "资源占用", "内存"]),
    permissionReview: includesAny(html, ["权限", "风险确认"]),
    checkpoints: includesAny(html, ["检查点", "撤回", "快照"]),
    memory: includesAny(html, ["记忆", "长期偏好"]),
    eventStream: includesAny(html, ["事件流", "时间线", "运行记录"]),
    fileChanges: includesAny(html, ["文件变更", "已编辑", "新增", "删除"]),
    composer: includesAny(html, ["输入", "发送", "继续执行"])
  };

  const warnings: string[] = [];
  warnIf(!metrics.hasSystemSizedHtml, `html too small: ${html.length}/${minHtmlChars} chars`);
  warnIf(!metrics.hasSystemSizedCss, `css too small: ${css.length}/${minCssChars} chars`);
  warnIf(!metrics.hasSystemSizedJs, `js too small: ${js.length}/${minJsChars} chars`);
  warnIf(
    !metrics.hasSemanticDesktopShell,
    `desktop shell incomplete: header ${metrics.semanticHeaderCount}/1, aside ${metrics.semanticAsideCount}/1, main ${metrics.semanticMainCount}/1, nav ${metrics.semanticNavCount}/1, section ${metrics.semanticSectionCount}/6`
  );
  warnIf(
    !metrics.hasControlDensity,
    `control density too low: buttons ${metrics.buttonCount}/12, form controls ${metrics.formControlCount}/1`
  );
  warnIf(
    !metrics.hasToolFlowDensity,
    `tool flow too thin: summaries ${metrics.toolSummaryCount}/2, rows ${metrics.toolRowCount}/5`
  );
  warnIf(
    !metrics.hasDiffDensity,
    `diff density too low: headers ${metrics.diffHeaderCount}/2, add lines ${metrics.diffAddLineCount}/2, remove lines ${metrics.diffRemoveLineCount}/2`
  );
  warnIf(!metrics.hasSubAgentDensity, `sub-agent rows too few: ${metrics.subAgentItemCount}/3`);
  warnIf(
    !metrics.hasCssSystemLayout,
    `css layout incomplete: variables ${metrics.cssVariableCount}/12, media rules ${metrics.responsiveRuleCount}/1, grid markers ${metrics.gridLayoutCount}/1`
  );
  warnIf(
    !metrics.hasJsSystemInteractions,
    `js interactions incomplete: delegated click handlers ${metrics.eventDelegationCount}/1, closest calls ${metrics.closestCallCount}/2, .tool-summary ${metrics.jsMentionsToolSummary}, .msg--tools ${metrics.jsMentionsToolContainer}, data-tools-expanded ${metrics.jsUsesExpandedState}`
  );
  if (requireSelfIteration) {
    warnIf(
      !metrics.hasRuntimeDataModel,
      `runtime data model too thin: ${metrics.runtimeDataModelCount}/7 required model markers`
    );
    warnIf(
      !metrics.hasSelfIterationSurface,
      `self-iteration surface too thin: ${metrics.visibleSelfIterationAnchorCount}/8 visible anchors`
    );
  }
  for (const [name, passed] of Object.entries(panelAnchors)) {
    if (!passed && (requireSelfIteration || isBasePanelAnchor(name))) {
      warnings.push(`missing system panel anchor: ${name}`);
    }
  }

  return { metrics, panelAnchors, warnings };

  function warnIf(condition: boolean, warning: string): void {
    if (condition) warnings.push(warning);
  }
}

function countMatches(input: string, pattern: RegExp): number {
  return input.match(pattern)?.length ?? 0;
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

function includesAny(input: string, needles: string[]): boolean {
  return needles.some((needle) => input.includes(needle));
}

function numberMetric(value: boolean | number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function isBasePanelAnchor(name: string): boolean {
  return [
    "taskLedger",
    "contextBudget",
    "performanceProbe",
    "permissionReview",
    "checkpoints",
    "memory",
    "eventStream",
    "fileChanges",
    "composer"
  ].includes(name);
}
