// HttpClient 骨架单测（D4 §6.3）：baseUrl / 超时 / 重试配置读取
// 当前骨架期仅承载配置读取（超时/重试/错误归一由 R2-02 后续扩展），
// 断言构造注入与缺省值语义，防后续扩展时破坏构造面。
import { HttpClient } from './HttpClient';

describe('HttpClient 骨架（D4 §6.3）', () => {
  it('构造注入 baseUrl 与缺省配置', () => {
    const client = new HttpClient('https://example.com');
    expect(client.base).toBe('https://example.com');
    expect(client.options).toEqual({});
  });

  it('options 透传注入的超时与重试配置（R2-02 读取面）', () => {
    const client = new HttpClient('https://example.com', {
      timeoutMs: 5_000,
      retries: 2,
    });
    expect(client.options).toEqual({ timeoutMs: 5_000, retries: 2 });
  });

  it('空 opts 与部分 opts 的兼容（缺省不注入多余键）', () => {
    const partial = new HttpClient('https://example.com', { retries: 3 });
    expect(partial.options).toEqual({ retries: 3 });
    const empty = new HttpClient('https://example.com', {});
    expect(empty.options).toEqual({});
  });
});
