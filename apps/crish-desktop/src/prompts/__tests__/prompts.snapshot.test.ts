/**
 * 全量 Prompt 渲染快照回归测试：
 * - 逐字节快照锁定（静态 System Prompt 逐字节不变 → 命中下游前缀缓存）；
 * - 高保真断言（模式指令关键要素齐全、多语言独立可用、注册表覆盖完整）。
 */
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_CORE_PROMPT,
  RESPONSE_STYLE_PROMPT,
  getResponseStyleDescription,
  resolveResponseStyle,
  HOST_ENVIRONMENT_PROMPT,
  WORKFLOW_ASSISTANT_PROMPT,
  GOAL_MODE_PROMPT,
  GRILL_ME_PROMPT,
  CODE_REVIEW_PROMPT,
  PromptRegistry,
  type ResponseStyleLevel,
} from '../index';

describe('systemCore：静态基座快照与恒等断言', () => {
  it('透传用户基座并叠加工程纪律（zh-CN / en-US 快照锁定）', () => {
    const zh = SYSTEM_CORE_PROMPT.render({
      customSystemPrompt: 'You are a coding agent inside Crish.',
    });
    expect(zh).toMatchSnapshot('system-core-zh-with-custom');
    const en = SYSTEM_CORE_PROMPT.render(
      {
        customSystemPrompt: 'You are a coding agent inside Crish.',
      },
      { locale: 'en-US' }
    );
    expect(en).toMatchSnapshot('system-core-en-with-custom');
    // 用户基座置顶 + 工程纪律存在
    expect(zh.startsWith('You are a coding agent inside Crish.')).toBe(true);
    expect(zh).toContain('UTF-8 无 BOM');
    expect(zh).toContain('--no-verify');
    expect(en).toContain('no BOM');
    expect(en).toContain('--no-verify');
  });

  it('用户基座为空时仅输出工程纪律（前置空行被裁剪）', () => {
    const zh = SYSTEM_CORE_PROMPT.render({ customSystemPrompt: '' });
    expect(zh.startsWith('# 通用协作与代码纪律')).toBe(true);
    expect(zh).toMatchSnapshot('system-core-zh-no-custom');
  });

  it('相同参数渲染结果逐字节恒等（Prompt Caching 命中前提）', () => {
    const params = {
      customSystemPrompt: 'You are a coding agent inside Crish.',
    };
    expect(SYSTEM_CORE_PROMPT.render(params)).toBe(
      SYSTEM_CORE_PROMPT.render(params)
    );
    expect(SYSTEM_CORE_PROMPT.render(params, { locale: 'en-US' })).toBe(
      SYSTEM_CORE_PROMPT.render(params, { locale: 'en-US' })
    );
  });
});

describe('hostEnvironment：L1 运行时必填实参', () => {
  const env = {
    os: 'win32',
    shell: 'pwsh7',
    workspaceRoot: 'C:/Software/conex',
  };

  it('渲染 zh-CN / en-US 快照，三者必填', () => {
    expect(HOST_ENVIRONMENT_PROMPT.render(env)).toMatchSnapshot('host-env-zh');
    expect(
      HOST_ENVIRONMENT_PROMPT.render(env, { locale: 'en-US' })
    ).toMatchSnapshot('host-env-en');
    expect(HOST_ENVIRONMENT_PROMPT.render(env, { locale: 'en-US' })).toContain(
      'C:/Software/conex'
    );
  });

  it('元数据无 defaultParams（禁止固化机器路径）', () => {
    expect(HOST_ENVIRONMENT_PROMPT.meta.defaultParams).toBeUndefined();
  });
});

describe('responseStyles：响应风格资产', () => {
  const styles: ResponseStyleLevel[] = ['minimal', 'low', 'medium', 'high'];

  it('getResponseStyleDescription 覆盖全部风格与双语言', () => {
    for (const s of styles) {
      expect(getResponseStyleDescription(s, 'zh-CN')).toContain('回复风格');
      expect(getResponseStyleDescription(s, 'en-US')).toContain(
        'Response style'
      );
    }
    expect(getResponseStyleDescription('medium', 'zh-CN')).toContain('适中');
    expect(getResponseStyleDescription('medium', 'en-US')).toContain(
      'balanced'
    );
  });

  it('resolveResponseStyle 语义等价 streamSession 旧 STYLE_ZH_MAP 归一', () => {
    // wire 枚举原样命中
    expect(resolveResponseStyle('minimal')).toBe('minimal');
    expect(resolveResponseStyle('low')).toBe('low');
    expect(resolveResponseStyle('medium')).toBe('medium');
    expect(resolveResponseStyle('high')).toBe('high');
    // 中文标签 → wire（等价 STYLE_ZH_MAP）
    expect(resolveResponseStyle('极简')).toBe('minimal');
    expect(resolveResponseStyle('简洁')).toBe('low');
    expect(resolveResponseStyle('适中')).toBe('medium');
    expect(resolveResponseStyle('深入')).toBe('high');
    // 大小写容错 + 未知值回退 medium
    expect(resolveResponseStyle('MEDIUM')).toBe('medium');
    expect(resolveResponseStyle('nonsense')).toBe('medium');
    expect(resolveResponseStyle(undefined)).toBe('medium');
  });

  it('RESPONSE_STYLE_PROMPT 渲染快照（含风格描述）', () => {
    const zh = RESPONSE_STYLE_PROMPT.render({
      style: 'medium',
      styleDescription: getResponseStyleDescription('medium', 'zh-CN'),
    });
    expect(zh).toContain('回复风格');
    expect(zh).toMatchSnapshot('response-style-zh');
    const en = RESPONSE_STYLE_PROMPT.render(
      {
        style: 'medium',
        styleDescription: getResponseStyleDescription('medium', 'en-US'),
      },
      { locale: 'en-US' }
    );
    expect(en).toContain('Response style: balanced');
    expect(en).toMatchSnapshot('response-style-en');
  });
});

describe('workflowAssistant：定时任务编排助手高保真', () => {
  const base = { workspacePath: 'C:/Software/conex' };

  it('四要素齐全（任务名称/执行周期/执行指令/目标项目）', () => {
    const zh = WORKFLOW_ASSISTANT_PROMPT.render(base);
    expect(zh).toContain('任务名称');
    expect(zh).toContain('执行周期');
    expect(zh).toContain('执行指令与命令');
    expect(zh).toContain('C:/Software/conex');
    expect(zh).toContain('暂无运行中的定时任务');
    expect(zh).toMatchSnapshot('workflow-assistant-zh');
    const en = WORKFLOW_ASSISTANT_PROMPT.render(base, {
      locale: 'en-US',
    });
    expect(en).toContain('Task Name');
    expect(en).toContain('Execution Schedule');
    expect(en).toMatchSnapshot('workflow-assistant-en');
  });

  it('activeSchedulesSummary 覆盖缺省值', () => {
    const zh = WORKFLOW_ASSISTANT_PROMPT.render({
      ...base,
      activeSchedulesSummary: '运行中：\n- 每日 09:00 健康巡检',
    });
    expect(zh).toContain('运行中：');
    expect(zh).not.toContain('暂无运行中的定时任务');
  });
});

describe('goalMode：长期目标推进高保真', () => {
  it('包含核心目标 / 当前轮次 / 任务清单 Markdown block', () => {
    const zh = GOAL_MODE_PROMPT.render({
      goal: 'ship feature',
      currentRound: 2,
      maxRounds: 5,
      openTasksBlock: '当前未完成任务清单：\n- [ ] open',
    });
    expect(zh).toContain('ship feature');
    expect(zh).toContain('第 2 轮');
    expect(zh).toContain('5 轮');
    expect(zh).toContain('- [ ] open');
    expect(zh).toMatchSnapshot('goal-mode-zh');
    const en = GOAL_MODE_PROMPT.render(
      {
        goal: 'ship feature',
        currentRound: 2,
        maxRounds: 5,
        openTasksBlock: '',
      },
      { locale: 'en-US' }
    );
    expect(en).toContain('Round 2 of 5');
    expect(en).toMatchSnapshot('goal-mode-en');
  });

  it('缺省 openTasksBlock 时保留结构（显式空串不告警）', () => {
    const zh = GOAL_MODE_PROMPT.render({
      goal: 'g',
      currentRound: 1,
      maxRounds: 3,
      openTasksBlock: '',
    });
    expect(zh).toContain('[目标模式 · 系统指令]');
    expect(zh).toMatchSnapshot('goal-mode-zh-no-tasks');
  });
});

describe('grillMe / codeReview：模式模板高保真', () => {
  it('grillMe 含主题与提问上限（双语言）', () => {
    const zh = GRILL_ME_PROMPT.render({ topic: '提示词架构重构' });
    expect(zh).toContain('提示词架构重构');
    expect(zh).toContain('5 个');
    expect(zh).toMatchSnapshot('grill-me-zh');
    const en = GRILL_ME_PROMPT.render(
      { topic: 'prompt architecture' },
      { locale: 'en-US' }
    );
    expect(en).toContain('prompt architecture');
    expect(en).toMatchSnapshot('grill-me-en');
  });

  it('codeReview 含目标路径与重点领域（双语言）', () => {
    const zh = CODE_REVIEW_PROMPT.render({ targetPath: 'crates/session-loop' });
    expect(zh).toContain('crates/session-loop');
    expect(zh).toContain('架构一致性');
    expect(zh).toMatchSnapshot('code-review-zh');
    const en = CODE_REVIEW_PROMPT.render(
      { targetPath: 'crates/session-loop' },
      { locale: 'en-US' }
    );
    expect(en).toContain('crates/session-loop');
    expect(en).toMatchSnapshot('code-review-en');
  });
});

describe('registry：集中注册表覆盖全部模板', () => {
  it('注册表含全部 7 个模板，可按 ID / Layer 检索', () => {
    expect(PromptRegistry.listAll()).toHaveLength(7);
    expect(PromptRegistry.get('core-system-base')?.meta.id).toBe(
      'core-system-base'
    );
    expect(PromptRegistry.get('mode-goal-orchestrator')?.meta.name).toContain(
      '长期目标'
    );
    expect(
      PromptRegistry.listByLayer('core')
        .map((t) => t.meta.id)
        .sort()
    ).toEqual(['core-response-style', 'core-system-base']);
    expect(
      PromptRegistry.listByLayer('mode')
        .map((t) => t.meta.id)
        .sort()
    ).toEqual([
      'mode-code-review',
      'mode-goal-orchestrator',
      'mode-grill-me',
      'mode-workflow-assistant',
    ]);
    expect(
      PromptRegistry.listByLayer('environment').map((t) => t.meta.id)
    ).toEqual(['env-host-context']);
  });
});
