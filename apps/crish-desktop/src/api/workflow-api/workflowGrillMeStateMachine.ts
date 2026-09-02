/**
 * apps/crish-desktop/src/api/workflow-api/workflowGrillMeStateMachine.ts
 * Grill-Me 四要素渐进提取器（05 详案 §1.2 / §2.3）：对用户的自然语言
 * 定时任务描述做**纯函数**预提取——伪监听判定 + 执行周期 / 任务名称
 * 结构化候选。产出仅作为表单预填与追问聚焦的建议值（ Pillar 候选），
 * 最终合法性仍由既有 validateWorkflowDraft / validateWorkflowSchedule
 * 与 Rust parse_cron 双重校验承载——本模块不做第二套合法性裁决。
 *
 * 设计红线（05 详案 §1.2 概念 4 伪监听纠偏）：系统定时任务基于后台
 * 时钟调度，严禁假装支持文件监听 / Git 钩子触发——isWatchRequest 命中
 * 后由调用方走「高频轮询替代」引导话术。
 */

import { defaultTimezone, type WorkflowSchedule } from './workflowScheduler';

/** 间隔分钟合法上界（与引擎 INTERVAL_MINUTES_MAX 同源口径：7 天） */
export const GRILL_ME_INTERVAL_MAX_MINUTES = 10080;

/** 四要素提取结果（缺项字段留空，由 Grill-Me 追问聚焦补齐） */
export interface ExtractedPillars {
  /** 任务名称候选（「任务名称：」「名称：」等标签后文本） */
  name?: string;
  /** 执行周期候选（每天 HH:mm / 每 N 分钟 / 5 字段 cron） */
  schedule?: WorkflowSchedule;
  /** 目标工作区（调用方默认带出当前激活工作区绝对路径） */
  cwd?: string;
  /** 伪监听请求判定命中（git push / 文件变更等时钟不可承载语义） */
  isWatchRequest?: boolean;
}

/** 伪监听判定：文件监听 / Git push / 保存触发等时钟调度不可承载语义 */
const WATCH_REQUEST_RE =
  /文件变更|文件监听|监听文件|改动触发|变更触发|保存时触发|on\s*file|file[\s_-]?watch|watch(?:ing)?\s+(?:the\s+)?(?:file|repo|git)|git\s*push|after\s*(?:each\s*)?push/i;

/** 每天 HH:mm（含 9:00 / 09:00 / 上午省略形态；中文冒号兼容） */
const DAILY_TIME_RE = /每天\s*(?:[早中晚]\s*)?([01]?\d|2[0-3])[:：]([0-5]\d)/;

/** 每 N 分钟（N 为 1–10080 整数；「每 30 分钟」「每30分钟」） */
const INTERVAL_MINUTES_RE = /每\s*(\d+)\s*分钟/;

/** 5 字段 cron 表达式（连续 5 段 cron 原子：数字/星号/范围/步进/列表） */
const CRON_EXPRESSION_RE =
  /\b([0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+)\b/;

/** 每周 X  HH:mm → cron（周字段 0=周日；「每周一」「每周 星期一」） */
const WEEKLY_RE =
  /每周(?:\s*星期|\s*周)?\s*([日一二三四五六天])\s*([01]?\d|2[0-3])[:：]([0-5]\d)/;

const WEEKDAY_INDEX: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 「任务名称：」「任务目标：」「名称：」标签后取值（至行尾/逗号/分号止） */
const NAME_LABEL_RE = /(?:任务名称|任务目标|名称)\s*[:：]\s*([^\n，,；;]+)/;

/**
 * 从自然语言描述提取四要素候选（纯函数；多形态同时命中时按
 * daily > weekly-cron > interval > bare-cron 优先级取首个可信周期）。
 */
export function extractPillarsFromText(
  text: string,
  defaultCwd: string,
): ExtractedPillars {
  const result: ExtractedPillars = {};
  const source = (text || '').trim();
  if (!source) return result;

  // 1. 伪监听判定（正面纠偏的触发信号，不参与周期候选）
  if (WATCH_REQUEST_RE.test(source)) {
    result.isWatchRequest = true;
  }

  // 2. 执行周期候选（按优先级取首个命中）
  const daily = source.match(DAILY_TIME_RE);
  if (daily) {
    const hh = (daily[1] ?? '0').padStart(2, '0');
    const mm = daily[2] ?? '00';
    result.schedule = {
      type: 'daily',
      time: `${hh}:${mm}`,
      timezone: defaultTimezone(),
    };
  } else {
    const weekly = source.match(WEEKLY_RE);
    if (weekly) {
      const weekday = WEEKDAY_INDEX[weekly[1] ?? ''] ?? 0;
      const hh = (weekly[2] ?? '0').padStart(2, '0');
      const mm = weekly[3] ?? '00';
      result.schedule = {
        type: 'cron',
        expression: `${mm} ${hh} * * ${weekday}`,
      };
    } else {
      const interval = source.match(INTERVAL_MINUTES_RE);
      const intervalMinutes = interval ? parseInt(interval[1] ?? '', 10) : NaN;
      if (
        Number.isFinite(intervalMinutes) &&
        intervalMinutes >= 1 &&
        intervalMinutes <= GRILL_ME_INTERVAL_MAX_MINUTES
      ) {
        result.schedule = { type: 'intervalMinutes', intervalMinutes };
      } else {
        const cron = source.match(CRON_EXPRESSION_RE);
        if (cron && cron[1]) {
          result.schedule = { type: 'cron', expression: cron[1].trim() };
        }
      }
    }
  }

  // 3. 任务名称候选
  const name = source.match(NAME_LABEL_RE);
  if (name && name[1]) {
    result.name = name[1].trim();
  }

  // 4. 目标工作区（调用方默认带出；空值不覆盖）
  if (defaultCwd && defaultCwd.trim()) {
    result.cwd = defaultCwd;
  }

  return result;
}

/**
 * 缺项追问聚焦（05 详案 §2.3 纠偏话术的结构化面）：返回仍缺失的要素
 * 清单（单轮追问数 ≤ 3 由调用方裁剪），伪监听命中时返回引导信号。
 */
export function missingPillars(pillars: ExtractedPillars): {
  missing: Array<'name' | 'schedule' | 'prompt'>;
  isWatchRequest: boolean;
} {
  const missing: Array<'name' | 'schedule' | 'prompt'> = [];
  if (!pillars.name) missing.push('name');
  if (!pillars.schedule) missing.push('schedule');
  return { missing, isWatchRequest: pillars.isWatchRequest === true };
}
