import { describe, it, expect } from 'vitest';
import {
  abbreviateModel,
  consonantSkeleton,
  disambiguateModelList,
  stripPhysicalNoise,
  tokenizeModelId,
} from './modelAbbreviation';

describe('modelAbbreviation: 核心分词与降噪逻辑', () => {
  it('应当正确剥离多级物理网关路径与扩展名', () => {
    expect(stripPhysicalNoise('openrouter/anthropic/claude-3-5-sonnet:beta')).toBe('claude-3-5-sonnet');
    expect(stripPhysicalNoise('ollama:deepseek-r1:32b.gguf')).toBe('deepseek-r1:32b');
    expect(stripPhysicalNoise('D:/ai/models/weights/mistral-7b.bin')).toBe('mistral-7b');
    expect(stripPhysicalNoise('openai/gpt-4o@channel')).toBe('gpt-4o');
  });

  it('应当严格保护浮点代际版本（1.2, 1.3, 3.5, 6.8），不被点号拆分', () => {
    const tokens = tokenizeModelId('muse-spark-1.2-contributor');
    expect(tokens).toContain('1.2');
    expect(tokens).not.toContain('1');
    expect(tokens).not.toContain('2');

    const tokensClaude = tokenizeModelId('claude-3.5-sonnet');
    expect(tokensClaude).toContain('3.5');
  });

  it('零字典辅音骨架抽脂算法（Consonant Skeleton）应当优雅收缩未知长词', () => {
    expect(consonantSkeleton('contributor', 4)).toBe('cntr');
    expect(consonantSkeleton('checkpoint', 4)).toBe('chck');
    expect(consonantSkeleton('hyperion', 4)).toBe('hypr');
    expect(consonantSkeleton('pro', 4)).toBe('pro');
  });
});

describe('modelAbbreviation: 关键模型缩写与用户审美偏好对齐', () => {
  it('用户关键用例 1: Muse 体系保留核心主名与版本代际，剥离 contributor 噪音', () => {
    const res12 = abbreviateModel('meta/muse-spark-1.2-contributor');
    expect(res12.standard).toBe('Muse Spark 1.2');
    expect(res12.compact).toBe('Muse 1.2 Spk');
    expect(res12.micro).toBe('Muse 1.2');

    const res13 = abbreviateModel('meta/muse-spark-1.3-contributor');
    expect(res13.micro).toBe('Muse 1.3');

    // 绝对互斥断言：绝不允许发生机械截断碰撞！
    expect(res12.micro).not.toBe(res13.micro);
  });

  it('用户关键用例 2: DeepSeek V4 系列必须以单字母 F / P 精确区分 Flash 与 Pro', () => {
    const flash = abbreviateModel('deepseek-ai/deepseek-v4-flash-0731');
    expect(flash.standard).toBe('DeepSeek V4 Flash');
    expect(flash.compact).toBe('DS V4 Flash');
    expect(flash.micro).toBe('DS V4F');

    const pro = abbreviateModel('deepseek-ai/deepseek-v4-pro-0813');
    expect(pro.standard).toBe('DeepSeek V4 Pro');
    expect(pro.compact).toBe('DS V4 Pro');
    expect(pro.micro).toBe('DS V4P');

    // 互斥断言
    expect(flash.micro).not.toBe(pro.micro);
  });

  it('用户关键用例 3: Claude 体系必须以 3.5 Snt / 3.5 Hku 紧凑呈现，代际版本优先', () => {
    const sonnet = abbreviateModel('anthropic/claude-3-5-sonnet-20241022');
    expect(sonnet.standard).toBe('Claude 3.5 Sonnet');
    expect(sonnet.compact).toBe('3.5 Sonnet');
    expect(sonnet.micro).toBe('3.5 Snt');

    const haiku = abbreviateModel('anthropic/claude-3-5-haiku-20241022');
    expect(haiku.compact).toBe('3.5 Haiku');
    expect(haiku.micro).toBe('3.5 Hku');
  });

  it('主流商用模型: SenseNova、GPT-4o、Gemini 规范呈现', () => {
    const nova = abbreviateModel('sensenova/sensenova-6.8-flash-lite');
    expect(nova.standard).toBe('SenseNova 6.8 Flash');
    expect(nova.compact).toBe('Nova 6.8 Flash');
    expect(nova.micro).toBe('SN 6.8 F');

    const gpt4o = abbreviateModel('openai/gpt-4o-2024-11-20');
    expect(gpt4o.version).toBe('4O');
    expect(gpt4o.micro).toBe('G 4O');
  });
});

describe('modelAbbreviation: 完全未在列表的未知与异构模型泛化测试', () => {
  it('企业私有未知微调模型：识别主体、版本与 MoE 结构', () => {
    const res = abbreviateModel('internal-corp/fin-analyst-alpha-9.2-fast-8x7b-v2-preview');
    expect(res.version).toBe('9.2');
    expect(res.scale).toBe('8X7B');
    expect(res.micro).toBe('Fin 9.2-8X7B');
  });

  it('未来未知新模型：零字典辅音抽脂泛化', () => {
    const res = abbreviateModel('hyperion-neo-6.5-quantum-88b-fp8');
    expect(res.version).toBe('6.5');
    expect(res.scale).toBe('88B');
    expect(res.micro).toBe('Hyp 6.5-88B');
  });

  it('开源 MoE 垂直领域模型', () => {
    const res = abbreviateModel('biomed-specialist-16x8b-chat-awq');
    expect(res.scale).toBe('16X8B');
    expect(res.micro).toBe('Bmd 16X8B');
  });
});

describe('modelAbbreviation: MUDT 上下文消歧与防碰撞测试', () => {
  it('当同家族不同快照模型同屏并存时，自动激活最小差异提权消歧', () => {
    const list = [
      { id: 'openai/gpt-4o-2024-05-13' },
      { id: 'openai/gpt-4o-2024-08-06' },
    ];
    const map = disambiguateModelList(list);
    const m1 = map.get('openai/gpt-4o-2024-05-13');
    const m2 = map.get('openai/gpt-4o-2024-08-06');

    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    // 经 MUDT 消歧后，两者的 micro 胶囊绝不相同！
    expect(m1?.micro).not.toBe(m2?.micro);
  });
});

describe('modelAbbreviation: 安全防爆浆与异常容灾测试', () => {
  it('处理空值与 undefined 应当优雅保底', () => {
    expect(abbreviateModel('').standard).toBe('');
    expect(abbreviateModel(undefined as unknown as string).standard).toBe('');
  });

  it('处理超长 10,000 字符输入应当安全限流截断，零崩溃', () => {
    const malicious = 'a'.repeat(10000);
    const res = abbreviateModel(malicious);
    expect(res.cleanId.length).toBeLessThanOrEqual(256);
  });
});
