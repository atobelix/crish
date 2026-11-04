// apps/crish-mobile/src/domain/pure/markdown/tailGradient.test.ts
// 流式文本末端行内字素梯度分段窗口模型（IGSW）纯逻辑切分单元测试

import { partitionTailGradient, splitGraphemes } from './tailGradient';

describe('partitionTailGradient 纯逻辑切分算法', () => {
  it('短文本边界：长度 <= 4 字符时不切分，全量作为 solidPrefix 返回', () => {
    const res = partitionTailGradient('你好世界', true);
    expect(res.solidPrefix).toBe('你好世界');
    expect(res.tiers).toHaveLength(0);
  });

  it('空文本或空串安全处理', () => {
    expect(partitionTailGradient('', true)).toEqual({
      solidPrefix: '',
      tiers: [],
    });
    // @ts-expect-error 测试防空边界
    expect(partitionTailGradient(null, true)).toEqual({
      solidPrefix: '',
      tiers: [],
    });
  });

  it('长文本切分：稳定基底区与渐变梯级文本拼接后 100% 字符守恒', () => {
    const text =
      '回望历史，中华文明是人类历史上唯一绵延不断、从未中断的伟大文明。四大发明的璀璨光芒曾照亮人类文明的暗夜。';
    const res = partitionTailGradient(text, true, { windowGraphemes: 20 });

    const reconstructed =
      res.solidPrefix + res.tiers.map((t) => t.text).join('');
    expect(reconstructed).toBe(text);
  });

  it('梯级透明度严格单调递减', () => {
    const text = '测试文本'.repeat(15);
    const res = partitionTailGradient(text, true);

    expect(res.tiers.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < res.tiers.length - 1; i++) {
      expect(res.tiers[i]!.opacity).toBeGreaterThan(res.tiers[i + 1]!.opacity);
    }
  });

  it('末梢梯级正确注入微发光阴影 (hasGlow / blurRadius)', () => {
    const text = '深度思考与高维抽象能力'.repeat(5);
    const res = partitionTailGradient(text, true);

    expect(res.tiers.length).toBe(5);
    // 前面较深的梯级不开启光晕
    expect(res.tiers[0]!.hasGlow).toBe(false);
    expect(res.tiers[1]!.hasGlow).toBe(false);
    expect(res.tiers[2]!.hasGlow).toBe(false);
    // 末端最淡的梯级开启微扩散光晕
    expect(res.tiers[3]!.hasGlow).toBe(true);
    expect(res.tiers[4]!.hasGlow).toBe(true);
    expect(res.tiers[4]!.blurRadius).toBe(2.5);
  });

  it('Unicode 字符簇安全保护：Emoji 与国旗修饰符不被从中断开', () => {
    const emojiText = '这是测试文本前缀'.repeat(5) + '科技改变未来👩‍💻🇨🇳✨🎉';
    const res = partitionTailGradient(emojiText, true);

    const reconstructed =
      res.solidPrefix + res.tiers.map((t) => t.text).join('');
    expect(reconstructed).toBe(emojiText);

    // 确保任何梯级都不含截断的乱码字符 \uFFFD
    for (const tier of res.tiers) {
      expect(tier.text).not.toContain('\uFFFD');
    }
  });

  it('关闭渐变模式时 (enabled=false)，全量返回为 solidPrefix', () => {
    const text = '完整长文本内容'.repeat(10);
    const res = partitionTailGradient(text, false);
    expect(res.solidPrefix).toBe(text);
    expect(res.tiers).toHaveLength(0);
  });

  it('超长文本 (10 万字) 常数时间 O(1) 计算且保持字符守恒', () => {
    const longText =
      '稳定文本前缀'.repeat(16_000) + '末端正在生成的微光流淌内容';
    const start = Date.now();
    const res = partitionTailGradient(longText, true, { windowGraphemes: 24 });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(50); // 必须在 50ms 内完成，实测 < 5ms
    const reconstructed =
      res.solidPrefix + res.tiers.map((t) => t.text).join('');
    expect(reconstructed).toBe(longText);
    expect(res.tiers.length).toBe(5);
  });

  it('自定义透明度范围 (minOpacity / maxOpacity) 线性渐变映射', () => {
    const text = '自定义透明度测试'.repeat(5);
    const res = partitionTailGradient(text, true, {
      minOpacity: 0.1,
      maxOpacity: 0.9,
    });

    expect(res.tiers[0]!.opacity).toBe(0.9);
    expect(res.tiers[res.tiers.length - 1]!.opacity).toBe(0.1);
  });

  it('splitGraphemes 工具函数对 Emoji 复合字符簇的保真切分', () => {
    const s = 'A👩‍💻B';
    const graphemes = splitGraphemes(s);
    expect(graphemes).toEqual(['A', '👩‍💻', 'B']);
  });
});
