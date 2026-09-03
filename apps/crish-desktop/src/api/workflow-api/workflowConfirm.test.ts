/**
 * apps/crish-desktop/src/api/workflow-api/workflowConfirm.test.ts
 * 路径 B 确认载荷解析器单测（详案 05 §2.4.2）：
 * - 围栏提取正逆向（合法载荷 / 非法 JSON / 缺字段 / 无围栏）
 * - strip 围栏后的展示文本
 * - payloadToWorkflowSchedule 四态 wire 转换
 */
import { describe, expect, it } from 'vitest';
import {
  extractWorkflowConfirmPayload,
  payloadToWorkflowSchedule,
  stripWorkflowConfirmFence,
} from './workflowConfirm';

describe('extractWorkflowConfirmPayload 围栏解析', () => {
  it('提取合法 daily 载荷', () => {
    const text = [
      '任务配置如下：',
      '```json:workflow-payload',
      JSON.stringify({
        name: '每日代码体检',
        prompt: '巡检仓库并汇报未解决 PR',
        scheduleType: 'daily',
        dailyTime: '09:30',
      }),
      '```',
      '请确认。',
    ].join('\n');
    const p = extractWorkflowConfirmPayload(text);
    expect(p).toEqual({
      name: '每日代码体检',
      prompt: '巡检仓库并汇报未解决 PR',
      scheduleType: 'daily',
      dailyTime: '09:30',
    });
  });

  it('提取 manual / intervalMinutes / cron 载荷（可选字段按类型携带）', () => {
    const manual = extractWorkflowConfirmPayload(
      '```json:workflow-payload\n{"name":"手动任务","prompt":"执行 X","scheduleType":"manual"}\n```'
    );
    expect(manual?.scheduleType).toBe('manual');

    const interval = extractWorkflowConfirmPayload(
      '```json:workflow-payload\n{"name":"轮询","prompt":"查依赖","scheduleType":"intervalMinutes","intervalMinutes":30}\n```'
    );
    expect(interval).toMatchObject({
      scheduleType: 'intervalMinutes',
      intervalMinutes: 30,
    });

    const cron = extractWorkflowConfirmPayload(
      '```json:workflow-payload\n{"name":"巡检","prompt":"体检","scheduleType":"cron","cronExpression":"0 9 * * 1-5"}\n```'
    );
    expect(cron).toMatchObject({
      scheduleType: 'cron',
      cronExpression: '0 9 * * 1-5',
    });
  });

  it('非法 JSON / 缺 name / 缺 prompt / 无围栏 → null（不阻断对话）', () => {
    expect(
      extractWorkflowConfirmPayload(
        '```json:workflow-payload\n{ not json }\n```'
      )
    ).toBeNull();
    expect(
      extractWorkflowConfirmPayload(
        '```json:workflow-payload\n{"name":"缺 prompt"}\n```'
      )
    ).toBeNull();
    expect(
      extractWorkflowConfirmPayload(
        '```json:workflow-payload\n{"prompt":"缺 name"}\n```'
      )
    ).toBeNull();
    expect(extractWorkflowConfirmPayload('没有围栏的普通文本')).toBeNull();
    expect(extractWorkflowConfirmPayload('')).toBeNull();
  });

  it('未知 scheduleType 回落 manual', () => {
    const p = extractWorkflowConfirmPayload(
      '```json:workflow-payload\n{"name":"x","prompt":"y","scheduleType":"weekly"}\n```'
    );
    expect(p?.scheduleType).toBe('manual');
  });
});

describe('stripWorkflowConfirmFence 展示文本剔除', () => {
  it('剔除围栏并收敛多余空行', () => {
    const text = '前缀\n\n```json:workflow-payload\n{"a":1}\n```\n\n后缀';
    expect(stripWorkflowConfirmFence(text)).toBe('前缀\n\n后缀');
  });

  it('无围栏返回原文', () => {
    expect(stripWorkflowConfirmFence('普通文本')).toBe('普通文本');
  });
});

describe('payloadToWorkflowSchedule 四态 wire 转换', () => {
  it('daily 自动带默认时区', () => {
    const { schedule } = payloadToWorkflowSchedule({
      name: 'x',
      prompt: 'y',
      scheduleType: 'daily',
      dailyTime: '08:00',
    });
    expect(schedule).toMatchObject({ type: 'daily', time: '08:00' });
    expect((schedule as { timezone?: string }).timezone).toBeTruthy();
  });

  it('intervalMinutes / cron / manual', () => {
    expect(
      payloadToWorkflowSchedule({
        name: 'x',
        prompt: 'y',
        scheduleType: 'intervalMinutes',
        intervalMinutes: 45,
      }).schedule
    ).toEqual({ type: 'intervalMinutes', intervalMinutes: 45 });

    expect(
      payloadToWorkflowSchedule({
        name: 'x',
        prompt: 'y',
        scheduleType: 'cron',
        cronExpression: '0 0 * * *',
      }).schedule
    ).toEqual({ type: 'cron', expression: '0 0 * * *' });

    expect(
      payloadToWorkflowSchedule({
        name: 'x',
        prompt: 'y',
        scheduleType: 'manual',
      }).schedule
    ).toEqual({ type: 'manual' });
  });
});
