/**
 * sessionRustDb 写竞态防线（从 sessionRustDbSql 拆出）
 *
 * 职责：模块级串行队列 + 批次版本戳（PS-03 T3.2 D6；Wave C 收敛后）。
 * - enqueuePersist：把持久化任务串入模块级写队列（主防线）
 * - nextBatchVersion：发起序版本戳（随 IPC batchVersion 传递）
 *
 * Wave C（06 §3.4 D-F01/D-F02）后已删：
 * - isHydrateTruncated persist 熔断（后端 Upsert 全绿，前端信任后端）
 * - writtenBodyBatchVersions 内存 CAS 映射（为全量覆盖防御设计的脆弱补丁）
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
 * 批次版本计数器。
 *
 * 裁决 R9：版本戳用单调递增版本号（替代任务书原方案的 batchAt 时间戳——
 * ms 粒度在快速连续 commit 下可能相同，无法区分新旧）。每个 persist 调用
 * 在发起时领取递增版本号（发起序 = 版本序，后发起 = 高版本），版本随
 * save_session_body 调用路径传递到 IPC 边界。
 *
 * 注：Wave C 后内存侧不再做 CAS 比较/丢弃（writtenBodyBatchVersions 已删）；
 * 版本仅作 IPC 观测与未来 Rust 侧可选消费。
 */
let batchVersionCounter = 0;

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

/** 领取下一批次版本号（发起序 = 版本序，R9）。 */
export function nextBatchVersion(): number {
  return ++batchVersionCounter;
}
