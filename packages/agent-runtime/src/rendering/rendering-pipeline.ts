/**
 * RenderingPipeline - 中央统一渲染机制
 *
 * 解决的问题：
 * 1. UI 渲染散落在多处，不同模块各自 emit 渲染事件
 * 2. 渲染顺序不受控制，导致 UI 闪烁或错乱
 * 3. 无法全局暂停/恢复/过滤渲染
 * 4. 缺乏渲染诊断能力
 *
 * 设计原则：
 * 1. 所有渲染必须通过 RenderingPipeline，禁止直接 emit UI 事件
 * 2. 渲染管线由多个阶段组成，每个阶段有明确的职责
 * 3. 支持渲染过滤器（按领域、按来源、按优先级）
 * 4. 内置诊断系统，可追踪每个渲染项的生命周期
 */

import {
  type ConexCanonicalEvent,
  type ConexEventDomain,
  type ConexDiagnostic,
} from "../event-architecture/canonical-event";
import { BoundedMap } from "@crish/shared-utils";

/** 诊断检查记录上限：渲染项追踪记录按 FIFO 淘汰，防止长跑场景下单调增长。 */
const MAX_INSPECTION_RECORDS = 500;

// ─── 渲染项 ───────────────────────────────────────────────

export type RenderItemType =
  | "text"
  | "tool-call"
  | "tool-result"
  | "approval-request"
  | "approval-resolution"
  | "status-indicator"
  | "progress-bar"
  | "diagnostic"
  | "error"
  | "divider"
  | "custom";

export type RenderPriority = "critical" | "high" | "normal" | "low" | "debug";

export interface RenderItem {
  /** 渲染项唯一 ID */
  id: string;
  /** 渲染项类型 */
  type: RenderItemType;
  /** 优先级 */
  priority: RenderPriority;
  /** 来源领域 */
  domain: ConexEventDomain;
  /** 来源事件 ID */
  sourceEventId?: string;
  /** 渲染数据 */
  data: unknown;
  /** 时间戳 */
  createdAt: string;
  /** 是否已渲染 */
  rendered: boolean;
  /** 是否被过滤 */
  filtered: boolean;
  /** 过滤原因 */
  filterReason?: string;
  /** 诊断信息 */
  diagnostics?: ConexDiagnostic[];
}

// ─── 渲染管线阶段 ─────────────────────────────────────────

export type RenderStage =
  | "collect"     // 收集渲染项
  | "filter"      // 过滤渲染项
  | "transform"   // 转换渲染项
  | "sort"        // 排序渲染项
  | "emit";       // 发射渲染项

export interface RenderStageResult {
  stage: RenderStage;
  inputCount: number;
  outputCount: number;
  filteredCount: number;
  transformedCount: number;
  durationMs: number;
}

// ─── 渲染过滤器 ───────────────────────────────────────────

export interface RenderFilter {
  name: string;
  /** 返回 true 表示保留该渲染项 */
  test(item: RenderItem): boolean;
}

// ─── 渲染转换器 ───────────────────────────────────────────

export interface RenderTransformer {
  name: string;
  transform(item: RenderItem): RenderItem | null;
}

// ─── 渲染管线配置 ─────────────────────────────────────────

export interface RenderingPipelineOptions {
  /** 是否启用诊断模式 */
  diagnosticMode: boolean;
  /** 最大队列长度（背压） */
  maxQueueSize: number;
  /** 默认优先级 */
  defaultPriority: RenderPriority;
  /** 是否按优先级排序 */
  sortByPriority: boolean;
  /** 优先级排序权重 */
  priorityWeight: Record<RenderPriority, number>;
}

export const DEFAULT_RENDERING_OPTIONS: RenderingPipelineOptions = {
  diagnosticMode: false,
  maxQueueSize: 1000,
  defaultPriority: "normal",
  sortByPriority: true,
  priorityWeight: {
    critical: 100,
    high: 75,
    normal: 50,
    low: 25,
    debug: 0
  }
};

// ─── RenderingPipeline ────────────────────────────────────

export class RenderingPipeline {
  private queue: RenderItem[] = [];
  private filters: RenderFilter[] = [];
  private transformers: RenderTransformer[] = [];
  private stageResults: RenderStageResult[] = [];
  private emittedItems: RenderItem[] = [];
  private listener?: (item: RenderItem) => void;
  private paused = false;
  private readonly maxEmittedHistory = 100;
  private readonly maxStageResults = 200;

  constructor(private readonly options: RenderingPipelineOptions = DEFAULT_RENDERING_OPTIONS) {}

  /**
   * 注册渲染过滤器
   */
  addFilter(filter: RenderFilter): void {
    this.filters.push(filter);
  }

  /**
   * 移除渲染过滤器
   */
  removeFilter(name: string): void {
    this.filters = this.filters.filter((f) => f.name !== name);
  }

  /**
   * 注册渲染转换器
   */
  addTransformer(transformer: RenderTransformer): void {
    this.transformers.push(transformer);
  }

  /**
   * 移除渲染转换器
   */
  removeTransformer(name: string): void {
    this.transformers = this.transformers.filter((t) => t.name !== name);
  }

  /**
   * 设置渲染监听器
   */
  onEmit(listener: (item: RenderItem) => void): void {
    this.listener = listener;
  }

  /**
   * 提交渲染项到管线
   */
  submit(item: Omit<RenderItem, "id" | "createdAt" | "rendered" | "filtered">): RenderItem {
    const fullItem: RenderItem = {
      ...item,
      id: createRenderId(),
      createdAt: new Date().toISOString(),
      rendered: false,
      filtered: false,
      priority: item.priority ?? this.options.defaultPriority
    };

    // 背压检查
    if (this.queue.length >= this.options.maxQueueSize) {
      // 丢弃最低优先级的项
      this.queue.sort((a, b) => this.options.priorityWeight[b.priority] - this.options.priorityWeight[a.priority]);
      const dropped = this.queue.pop();
      if (this.options.diagnosticMode && dropped) {
        this.addStageResult({
          stage: "collect",
          inputCount: 1,
          outputCount: 0,
          filteredCount: 1,
          transformedCount: 0,
          durationMs: 0
        });
      }
    }

    this.queue.push(fullItem);

    // 如果未暂停，立即处理
    if (!this.paused) {
      this.flush();
    }

    return fullItem;
  }

  /**
   * 从 Canonical Event 创建渲染项
   */
  submitFromEvent(event: ConexCanonicalEvent, type: RenderItemType, data: unknown, priority?: RenderPriority): RenderItem {
    return this.submit({
      type,
      priority: priority ?? this.options.defaultPriority,
      domain: event.domain,
      sourceEventId: event.eventId,
      data,
      diagnostics: event.diagnostics
    });
  }

  /**
   * 暂停渲染
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * 恢复渲染
   */
  resume(): void {
    this.paused = false;
    this.flush();
  }

  /**
   * 刷新队列中的所有渲染项
   */
  flush(): void {
    if (this.queue.length === 0) return;

    const items = [...this.queue];
    this.queue = [];

    // Stage: Filter
    const filtered = this.applyFilters(items);

    // Stage: Transform
    const transformed = this.applyTransformers(filtered);

    // Stage: Sort
    const sorted = this.applySort(transformed);

    // Stage: Emit
    for (const item of sorted) {
      item.rendered = true;
      this.emittedItems.push(item);
      if (this.emittedItems.length > this.maxEmittedHistory) {
        this.emittedItems.shift();
      }
      this.listener?.(item);
    }
  }

  /**
   * 获取管线诊断信息
   */
  getDiagnostics(): RenderingPipelineDiagnostics {
    return {
      queueLength: this.queue.length,
      emittedCount: this.emittedItems.length,
      filterCount: this.filters.length,
      transformerCount: this.transformers.length,
      paused: this.paused,
      stageResults: [...this.stageResults],
      recentEmitted: this.emittedItems.slice(-20)
    };
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    this.stageResults = [];
  }

  // ─── 内部方法 ────────────────────────────────────────────

  private addStageResult(result: RenderStageResult): void {
    this.stageResults.push(result);
    if (this.stageResults.length > this.maxStageResults) {
      this.stageResults.shift();
    }
  }

  private applyFilters(items: RenderItem[]): RenderItem[] {
    if (this.filters.length === 0) return items;

    const startMs = Date.now();
    const result: RenderItem[] = [];
    let filteredCount = 0;

    for (const item of items) {
      let passes = true;
      for (const filter of this.filters) {
        if (!filter.test(item)) {
          passes = false;
          item.filtered = true;
          item.filterReason = `Filtered by: ${filter.name}`;
          filteredCount++;
          break;
        }
      }
      if (passes) result.push(item);
    }

    if (this.options.diagnosticMode) {
      this.addStageResult({
        stage: "filter",
        inputCount: items.length,
        outputCount: result.length,
        filteredCount,
        transformedCount: 0,
        durationMs: Date.now() - startMs
      });
    }

    return result;
  }

  private applyTransformers(items: RenderItem[]): RenderItem[] {
    if (this.transformers.length === 0) return items;

    const startMs = Date.now();
    const result: RenderItem[] = [];
    let transformedCount = 0;

    for (const item of items) {
      let current: RenderItem | null = item;
      for (const transformer of this.transformers) {
        if (current === null) break;
        const transformed = transformer.transform(current);
        if (transformed !== current) {
          transformedCount++;
        }
        current = transformed;
      }
      if (current !== null) result.push(current);
    }

    if (this.options.diagnosticMode) {
      this.addStageResult({
        stage: "transform",
        inputCount: items.length,
        outputCount: result.length,
        filteredCount: 0,
        transformedCount,
        durationMs: Date.now() - startMs
      });
    }

    return result;
  }

  private applySort(items: RenderItem[]): RenderItem[] {
    if (!this.options.sortByPriority) return items;

    return [...items].sort(
      (a, b) => this.options.priorityWeight[b.priority] - this.options.priorityWeight[a.priority]
    );
  }
}

// ─── 诊断信息 ─────────────────────────────────────────────

export interface RenderingPipelineDiagnostics {
  queueLength: number;
  emittedCount: number;
  filterCount: number;
  transformerCount: number;
  paused: boolean;
  stageResults: RenderStageResult[];
  recentEmitted: RenderItem[];
}

// ─── DiagnosticInspector ──────────────────────────────────

/**
 * 渲染诊断检查器
 *
 * 独立于 RenderingPipeline 的诊断工具，用于：
 * 1. 检查渲染管线的健康状态
 * 2. 发现渲染瓶颈
 * 3. 追踪渲染项的生命周期
 * 4. 生成诊断报告
 */
export class DiagnosticInspector {
  private inspections = new BoundedMap<string, InspectionRecord>(MAX_INSPECTION_RECORDS);

  /**
   * 开始检查一个渲染项
   */
  startInspection(itemId: string, source: string): void {
    this.inspections.set(itemId, {
      itemId,
      source,
      startedAt: Date.now(),
      stages: []
    });
  }

  /**
   * 记录渲染项经过的阶段
   */
  recordStage(itemId: string, stage: RenderStage, detail?: string): void {
    const record = this.inspections.get(itemId);
    if (!record) return;
    record.stages.push({
      stage,
      timestamp: Date.now(),
      detail
    });
  }

  /**
   * 完成检查
   */
  completeInspection(itemId: string): InspectionRecord | undefined {
    const record = this.inspections.get(itemId);
    if (!record) return undefined;
    record.completedAt = Date.now();
    record.totalDurationMs = record.completedAt - record.startedAt;
    return record;
  }

  /**
   * 获取慢渲染项（超过阈值）
   */
  getSlowItems(thresholdMs: number): InspectionRecord[] {
    const slow: InspectionRecord[] = [];
    for (const record of this.inspections.values()) {
      if (record.totalDurationMs !== undefined && record.totalDurationMs > thresholdMs) {
        slow.push(record);
      }
    }
    return slow.sort((a, b) => (b.totalDurationMs ?? 0) - (a.totalDurationMs ?? 0));
  }

  /**
   * 生成诊断报告
   */
  generateReport(): DiagnosticReport {
    const records = [...this.inspections.values()];
    const completed = records.filter((r) => r.totalDurationMs !== undefined);

    const stageBreakdown = new Map<RenderStage, { count: number; totalMs: number }>();
    for (const record of completed) {
      for (let i = 0; i < record.stages.length; i++) {
        const stage = record.stages[i]!;
        const nextTimestamp = record.stages[i + 1]?.timestamp ?? record.completedAt ?? Date.now();
        const duration = nextTimestamp - stage.timestamp;
        const existing = stageBreakdown.get(stage.stage) ?? { count: 0, totalMs: 0 };
        existing.count++;
        existing.totalMs += duration;
        stageBreakdown.set(stage.stage, existing);
      }
    }

    return {
      totalInspections: records.length,
      completedInspections: completed.length,
      averageDurationMs: completed.length > 0
        ? completed.reduce((sum, r) => sum + (r.totalDurationMs ?? 0), 0) / completed.length
        : 0,
      maxDurationMs: completed.length > 0
        ? Math.max(...completed.map((r) => r.totalDurationMs ?? 0))
        : 0,
      stageBreakdown: Object.fromEntries(stageBreakdown)
    };
  }

  /**
   * 清除检查记录
   */
  clear(): void {
    this.inspections.clear();
  }
}

interface InspectionRecord {
  itemId: string;
  source: string;
  startedAt: number;
  completedAt?: number;
  totalDurationMs?: number;
  stages: Array<{ stage: RenderStage; timestamp: number; detail?: string }>;
}

export interface DiagnosticReport {
  totalInspections: number;
  completedInspections: number;
  averageDurationMs: number;
  maxDurationMs: number;
  stageBreakdown: Record<string, { count: number; totalMs: number }>;
}

// ─── 工具函数 ─────────────────────────────────────────────

function createRenderId(): string {
  return `rdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
