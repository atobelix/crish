// HttpClient 骨架（D4 §6.3）：fetch 封装（超时 / 重试 / 错误归一化）
// 移动端 HTTP 面极小（配对握手、令牌刷新、文件元信息），不引入 axios；
// R2-02 落地错误归一（401 → 触发令牌刷新；网络错误 → network.unreachable）
export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
}

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: HttpClientOptions = {}
  ) {}

  get base(): string {
    return this.baseUrl;
  }

  /** R2-02 使用：超时 / 重试配置读取（骨架期保留字段防 unused 告警） */
  get options(): HttpClientOptions {
    return this.opts;
  }
}
