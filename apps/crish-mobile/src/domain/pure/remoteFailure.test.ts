// 远程流内失败分类映射测试（批 C ⑮）：原始 reason 串 → 本地封闭
// 分类呈现；原始串只进 detail；映射不中归未分类诚实呈现。
import {
  classifyRemoteFailure,
  extractHttpStatus,
  presentRemoteFailure,
} from './remoteFailure';

describe('extractHttpStatus', () => {
  it('前缀形态与裸状态码都可提取', () => {
    expect(extractHttpStatus('HTTP 401 Unauthorized')).toBe(401);
    expect(extractHttpStatus('status: 500 Internal')).toBe(500);
    expect(extractHttpStatus('供应商返回 429')).toBe(429);
    expect(extractHttpStatus('普通错误描述')).toBeNull();
  });
});

describe('classifyRemoteFailure', () => {
  it('带状态码走 HTTP 分类（401 → auth，500 → server，429 → rateLimit）', () => {
    expect(classifyRemoteFailure('HTTP 401 Unauthorized').kind).toBe('auth');
    expect(classifyRemoteFailure('HTTP 500').kind).toBe('server');
    expect(classifyRemoteFailure('error: 429').kind).toBe('rateLimit');
  });

  it('无状态码走错误体模式（model_not_found / context_length）', () => {
    expect(classifyRemoteFailure('model_not_found: gpt-x').kind).toBe(
      'modelNotFound'
    );
    expect(classifyRemoteFailure('context_length_exceeded').kind).toBe(
      'contextLength'
    );
    expect(classifyRemoteFailure('insufficient_quota').kind).toBe('quota');
  });

  it('网络/中断自由文本 → network / stream', () => {
    expect(classifyRemoteFailure('Request timed out').kind).toBe('network');
    expect(classifyRemoteFailure('网络连接失败').kind).toBe('network');
    expect(classifyRemoteFailure('stream interrupted').kind).toBe('stream');
  });

  it('映射不中 → unknown 且 detail 保留原始串（不吞不编）', () => {
    const error = classifyRemoteFailure('某种从未见过的错误 XYZ');
    expect(error.kind).toBe('unknown');
    expect(error.detail).toBe('某种从未见过的错误 XYZ');
  });

  it('空 reason → unknown 且无 detail', () => {
    const error = classifyRemoteFailure(null);
    expect(error.kind).toBe('unknown');
    expect(error.detail).toBeUndefined();
  });
});

describe('presentRemoteFailure', () => {
  it('已分类：主文案 = 分类文案（标题 + 一句话），原始串进 detail', () => {
    const p = presentRemoteFailure('HTTP 401 Unauthorized');
    expect(p.text).toContain('鉴权失败');
    expect(p.detail).toBe('HTTP 401 Unauthorized');
    expect(p.kind).toBe('auth');
  });

  it('未分类：主文案明示「未分类」，原始串进 detail', () => {
    const p = presentRemoteFailure('某种从未见过的错误 XYZ');
    expect(p.text).toBe('运行失败（未分类）');
    expect(p.detail).toBe('某种从未见过的错误 XYZ');
  });

  it('无 reason：只呈现「运行失败」，无 detail', () => {
    expect(presentRemoteFailure(null)).toEqual({
      text: '运行失败',
      kind: 'unknown',
    });
    expect(presentRemoteFailure('')).toEqual({
      text: '运行失败',
      kind: 'unknown',
    });
  });
});
