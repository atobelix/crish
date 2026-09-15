/**
 * InlineRuler：行内规则插件体系
 * （docs/analysis/06-扩展功能-技术维度.md §1：INLINE_RULES 硬编码 vs markdown-it ruler）
 *
 * 设计要点：
 * - 规则 = { name, priority, match }，match 为纯函数：返回
 *   { type, raw, content, length, ... } 或 null，无副作用——扫描行为完全由
 *   返回值描述，规则之间无顺序耦合（优先级是显式数字而非数组下标）；
 * - scan(text, pos) 按 priority 降序尝试全部规则（实例 + 全局注册表），
 *   首个命中返回（同 markdown-it 链式语义，但优先级显式化）；
 * - add/remove 运行时增删；同名 add 即替换（markdown-it at 语义）；
 * - 静态 register/unregister 全局注册表：宿主自定义语法（@mention 等）
 *   无需改动 parser 核心即可注册；全局规则参与全部 ruler 实例的扫描，
 *   编译缓存按全局版本号失效（getGlobalVersion 供 parseLine 缓存键使用，
 *   防止跨注册版本的 AST 行缓存串扰）；
 * - 引擎内置起止符规则需要「递归解析内层 + 失败位图记忆」等扫描环境，
 *   由扫描循环经 InlineRuleContext 注入——自定义规则通常只依赖
 *   text/pos 即可工作（见 tests/unit/ruler.test.ts 的 @mention 示例）。
 */
import type { InlineNode } from './ast';

/** 规则匹配产物：纯数据描述（无副作用），扫描循环据此构建 token */
export interface InlineMatch {
  /** token 类型（自定义类型不在 InlineType 联合内，渲染侧经注册表接管，见 06 §3） */
  type: string;
  /** 消费的原文片段（raw 保留原文，覆盖守恒依赖它） */
  raw: string;
  /** 渲染内容（实体解码 / 转义还原只发生在 content） */
  content: string;
  /** 词法消费产生的内容源码区间与显示边界。 */
  contentOffset?: number;
  contentSourceLength?: number;
  sourceBoundaries?: readonly (number | null)[];
  /** 消费长度（= raw.length，扫描循环按它推进扫描位置） */
  length: number;
  /** 起止符规则的递归解析产物（正则/原子规则无此字段） */
  children?: InlineNode[];
  url?: string;
  isChecked?: boolean;
}

/** 规则匹配上下文：扫描循环在递归帧内构造，注入引擎内部执行环境 */
export interface InlineRuleContext<RD = unknown> {
  /** 引用链接定义表（reference 规则专用；自定义规则忽略） */
  refDefs: RD;
  /**
   * 递归解析内层内容（起止符规则专用）：从 pos 起按 start/close 消费，
   * 返回内层 tokens 与总消费长度；null = 内层未闭合（调用方自行决定
   * 是否写入失败记忆——引擎内置规则统一在失败时 add 到 failedAt）。
   */
  recurse: (
    start: string,
    close: string,
    type: string,
    pos: number
  ) => { tokens: InlineNode[]; length: number } | null;
  /** 失败位图记忆（跨递归层共享，见 parser.ts ScanFailureMemo）——引擎内部字段 */
  failedAt: Set<string>;
  /** 规则级「闭合标记缺失」最小确认位置表——引擎内部字段 */
  noClose: Map<string, number>;
}

/** 行内规则定义 */
export interface InlineRule<RD = unknown> {
  /** 规则名：同名 add 即替换、remove 按名移除 */
  name: string;
  /** 优先级：数值越大越先尝试（同 priority 时注册更早者优先，稳定排序） */
  priority: number;
  /**
   * 起止符规则的起始标记：供扫描期「start+close 合并串构成他规则」
   * （hasStartRule）与「run 长度恰为两倍时的精确规则互斥」判定
   * （hasExactStart）使用；纯正则/自定义规则可省略。
   */
  start?: string;
  /** 纯函数匹配：命中返回 InlineMatch，否则返回 null（禁止副作用） */
  match(text: string, pos: number, ctx: InlineRuleContext<RD>): InlineMatch | null;
}

/** 全局自定义规则注册表（静态共享，作用于全部 ruler 实例） */
const globalRules: InlineRule[] = [];

/**
 * 行内规则表：add/remove 运行时增删、scan 按 priority 降序尝试。
 * 与 markdown-it Ruler 的差异：不做 alt 链缓存，只维护单一默认链
 * （本引擎无多链需求），失败位图记忆由扫描循环（parser.ts）持有。
 */
export class InlineRuler<RD = unknown> {
  /** 实例规则（注册序） */
  private rules: InlineRule<RD>[] = [];
  /** 编译缓存：实例 + 全局合并、按 priority 降序（首次 scan 时惰性构建） */
  private compiled: InlineRule<RD>[] | null = null;
  /** 编译缓存对应的全局注册表版本（register/unregister 自增后缓存失效） */
  private compiledGlobalVersion = -1;

  /** 全局注册表版本号（静态）：任何 register/unregister 使全部实例缓存失效 */
  private static globalVersion = 0;

  /** 注册规则：同名即替换（markdown-it at 语义），并失效编译缓存 */
  add(rule: InlineRule<RD>): void {
    const idx = this.rules.findIndex((r) => r.name === rule.name);
    if (idx !== -1) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    this.compiled = null;
  }

  /** 移除规则（按名）：返回是否命中 */
  remove(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.compiled = null;
    return true;
  }

  /** 按 priority 降序尝试全部规则（实例 + 全局注册表），首个命中返回 */
  scan(text: string, pos: number, ctx: InlineRuleContext<RD>): InlineMatch | null {
    const compiled = this.getCompiled();
    for (let i = 0; i < compiled.length; i++) {
      const m = compiled[i].match(text, pos, ctx);
      if (m) return m;
    }
    return null;
  }

  /**
   * 是否存在起始标记与 start 完全相同的注册规则——扫描期「start + close
   * 合并串构成他规则」判定（原 INLINE_RULES.some(r => r.start === combined)）。
   * 全局注册表默认为空，包含全局规则不影响内置行为（零变化）。
   */
  hasStartRule(start: string): boolean {
    const compiled = this.getCompiled();
    for (let i = 0; i < compiled.length; i++) {
      if (compiled[i].start === start) return true;
    }
    return false;
  }

  /**
   * 是否存在「起始标记长度为 len 且首字符为 char」的注册规则——exact-match
   * 互斥判定（原 INLINE_RULES.some(r => r.start && r.start.length === runLen &&
   * r.start[0] === char)：'****' 对 '**' 的 run 长度两倍场景由更长的精确规则接管。
   */
  hasExactStart(len: number, char: string): boolean {
    const compiled = this.getCompiled();
    for (let i = 0; i < compiled.length; i++) {
      const s = compiled[i].start;
      if (s && s.length === len && s[0] === char) return true;
    }
    return false;
  }

  /** 编译缓存：实例 + 全局合并按 priority 降序；全局版本变化时自动重建 */
  private getCompiled(): InlineRule<RD>[] {
    if (
      !this.compiled ||
      this.compiledGlobalVersion !== InlineRuler.globalVersion
    ) {
      this.compiled = [...this.rules, ...(globalRules as InlineRule<RD>[])].sort(
        (a, b) => b.priority - a.priority
      );
      this.compiledGlobalVersion = InlineRuler.globalVersion;
    }
    return this.compiled;
  }

  /** 全局注册表版本号（静态）：parseLine 缓存键依赖它（防跨注册版本串扰） */
  static getGlobalVersion(): number {
    return InlineRuler.globalVersion;
  }

  /** 全局注册表注册（静态）：宿主自定义语法（@mention 等），作用于全部实例 */
  static register(rule: InlineRule): void {
    const idx = globalRules.findIndex((r) => r.name === rule.name);
    if (idx !== -1) {
      globalRules[idx] = rule;
    } else {
      globalRules.push(rule);
    }
    InlineRuler.globalVersion++;
  }

  /** 全局注册表移除（静态）：返回是否命中 */
  static unregister(name: string): boolean {
    const idx = globalRules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    globalRules.splice(idx, 1);
    InlineRuler.globalVersion++;
    return true;
  }
}
