/**
 * sessionRustDb 写竞态防线（从 sessionRustDbSql 拆出）
 *
 * 职责：模块级串行队列 + 批次版本戳 CAS（PS-03 T3.2 D6）。
 * - enqueuePersist：把持久化任务串入模块级写队列（主防线）
 * - nextBatchVersion / writtenBodyVersion / recordWrittenBodyVersion：CAS 防线 2
 * - isHydrateTruncated：P1-D2 persist 熔断判定
 */

/**
 * 模块级写串行队列（主防线）。
 *
 * 问题背景（R2 §5 / F5-02）：persist 批次间无队列、无版本戳；store 层 350ms
 * debounce（store-persistence.ts:136-145）只保证「调度串行」，不保证「IPC
 * 飞行期互斥」——store 高频变更时两个 persist 周期可并发飞行，旧批次晚完成
 * 整体覆盖新批次（sessionRustDbWriteModel.test.ts 曾把回滚固化为契约，
 * T3.2 已翻转）。本队列把每个 persist 批次整体串入 promise 链：
 *
 * - 新批次执行前先 await 上一轮 promise → 同一时刻至多一个批次在飞行期，
 *   同会话写任务严格按发起顺序落库（后发批次最后写，最终 = 最新快照）；
 * - 单轮失败吞掉，不影响链上后续批次（对齐 persistAllSessionsRust 既有
 *   「内部 allSettled、不对外抛错」语义）；
 * - 队列语义 = 每会话保留最新快照：过期批次被后续批次覆盖，不产生回滚。
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 批次版本计数器（CAS 防线 2）。
 *
 * 裁决 R9：CAS 哨兵用单调递增版本号（替代任务书原方案的 batchAt 时间戳——
 * ms 粒度在快速连续 commit 下可能相同，无法区分新旧）。每个 persist 调用
 * 在发起时领取递增版本号（发起序 = 版本序，后发起 = 高版本），版本随
 * save_session_body 调用路径传递到 IPC 边界，供 Rust 侧未来 updated_at
 * CAS 消费（任务书 T3.2 ③；Rust 命令面改动不在本实现轮范围）。
 */
let batchVersionCounter = 0;

/**
 * 各会话已落库正文的最高批次版本（CAS 比较基准）。
 * 串行队列下单上下文内写序已确定，本表是第二道防线：任何路径下旧版本
 * 批次在落库前被识别并直接丢弃（不覆盖已落库的新版本）。
 */
const writtenBodyBatchVersions = new Map<string, number>();

/**
 * 把持久化任务串入模块级写队列。
 * 返回任务自身 promise（调用方可 await 感知完成）；链尾由 writeChain 承接，
 * 单轮失败由 catch 吞掉，保证链永不因单轮异常而断裂。
 */
export function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const run = writeChain
    .then(() => task())
    .catch(() => {
      /* 单轮失败吞掉：不影响链上后续批次 */
    });
  writeChain = run;
  return run;
}

/** 领取下一批次版本号（发起序 = 版本序，R9 CAS 防线 2）。 */
export function nextBatchVersion(): number {
  return ++batchVersionCounter;
}

/** 读取某会话已落库正文的最高批次版本（无记录返回 -1）。 */
export function writtenBodyVersion(sessionId: string): number {
  return writtenBodyBatchVersions.get(sessionId) ?? -1;
}

/** 记录某会话已落库正文的批次版本（CAS 比较基准更新）。 */
export function recordWrittenBodyVersion(
  sessionId: string,
  version: number
): void {
  writtenBodyBatchVersions.set(sessionId, version);
}

/**
 * P1-D2（T3.6）persist 熔断判定：引擎懒水合「未完整」的会话禁止回写正文。
 *
 * 根因（R2 §6）：hydrate 单页截断 → hydratedFromEngine=true 封死重试 → 350ms
 * debounce → save_session_body 先删后插 → 截断正文不可逆覆盖 SQLite。
 * 修复后 hydrate 已分页拉全；但引擎异常（超页数上限/游标停滞）仍可能产生
 * 截断态，store 以 hydrateTruncated 标记刻画，此处为兜底防线：任何 persist
 * 周期（主路径 / LS 降级镜像 / beforeunload 同步）对未完整会话一律跳过
 * 正文回写——截断态永不固化；分页拉全后标记清除，熔断自然解除。
 */
export function isHydrateTruncated(s: {
  hydratedFromEngine?: boolean;
  hydrateTruncated?: boolean;
}): boolean {
  return s.hydratedFromEngine === true && s.hydrateTruncated === true;
}
