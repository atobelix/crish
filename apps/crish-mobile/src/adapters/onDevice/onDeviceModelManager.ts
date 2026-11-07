// 端侧（本机）GGUF 模型管理器：多模型目录版的按需下载 + 完整性校验 +
// 断点续传 + 本地落盘。泛化自 ASR 离线模型管理器
// （src/adapters/asr/modelManager.ts）的生产先例：同样的诚实状态机
// （缺失/下载中/校验中/就绪/失败可重试）、同样的多源回退序
// （hf-mirror → huggingface.co）、同样的固定 size+sha256 校验与
//.part 原子落盘、同样的 verified.json 增量标记纪律。
//
// 曾评估把 AsrModelManager 抽成
// 共享基类供 ASR 与本管理器共用，结论是本批不抽，理由：
// 1) ASR 管理器已在真机生产运行，其公开面（扁平单目录 + 三件固定文件
// + AsrModelPaths 专用路径组）与本管理器的形状（多模型、每模型独立
// 子目录与标记）不同构，抽基类必须改动 ASR 的公开行为面；
// 2) 本管理器对 ASR 版有三处明确增量——断点续传持久化、空间预检、
// 逐模型状态/占用——基类会被这些增量反向污染；
// 3) 真正可共享的纯函数（toNativeFilePath / formatBytes）已直接从
// ASR 模块导入复用，没有复制第二份。
// 故本文件按同一接口形状平行实现，状态类型与进度类型字段与 ASR 同构。
// 收口裁决（2026-11-06，端侧模型波收口）：维持平行实现，不抽共享
// 基类；两处文件头互相标注（ASR 侧标注见 modelManager.ts 文件头）。
// 往后若要抽取两者共同的下载/校验内核，前提是 ASR 回归全绿，并以
// 独立批次承接，不在本文件内顺手为之。
//
// ASR 版每轮新建下载任务从零拉取
// （228MiB 可忍），GGUF 单文件 0.75–1.96GiB 不可忍。本管理器在下载
// 进度回调中节流地把 DownloadResumable.savable()（url/fileUri/
// resumeData）写入 SQLite kv（键 ondevice.resume.<modelId>）；App
// 被杀/重启后 ensureReady 以 resumeData 重建任务续传；服务端不接受
// 续传（任务抛错或落盘尺寸不符）时自动清记录、删.part、整文件重下，
// 并如实置状态。校验成功后删除续传记录。
//
// 状态机只报真实状态：不做首启自动下载（下载只由
// ensureReady 的显式调用触发）；空间不足在下载前预检拦截并给出
// 需要/可用数字；校验失败绝不把损坏件移入正式路径，既有正式文件
// 绝不惩罚性删除（同 ASR 非破坏性策略）。
import { sha256} from '@noble/hashes/sha2.js';
import { bytesToHex} from '@noble/hashes/utils.js';
import * as FileSystem from 'expo-file-system/legacy';
import { getCrishAsrNative} from 'crish-asr';
import { formatBytes, toNativeFilePath} from '../asr/modelManager';
import { base64ToBytes} from '../asr/base64';
import {
ON_DEVICE_MODEL_CATALOG,
type OnDeviceModelSpec,
} from './onDeviceModelCatalog';
export type { OnDeviceModelSpec} from './onDeviceModelCatalog';
export { formatBytes, toNativeFilePath};
/** 下载进度（与 ASR 的 AsrModelProgress 同构：字段名/语义一致，另加 modelId） */
export interface OnDeviceModelProgress {
/** 模型 id */
modelId: string;
/** 当前正在下载/校验的文件名（GGUF 文件名） */
fileName: string;
/** 当前文件序号（1-based；端侧每模型单文件，恒为 1） */
fileIndex: number;
/** 总文件数（恒为 1） */
totalFiles: number;
/** 当前文件已接收字节数 */
receivedBytes: number;
/** 当前文件期望总字节数 */
totalBytes: number;
/** 总体进度 0..1 */
overallFraction: number;
/** 格式化好的进度文案，如 "45.2 MB / 1.0 GB (20%)" */
progressText?: string;
/** 瞬时下载速率 (bytes/s，可选) */
speedBytesPerSec?: number;
}
/**
* 逐模型状态机（对 UI 诚实：与 ASR 的 AsrModelState 同构，另加 modelId）。
* L0（2026-11-07，本机模型状态修复）起 check 能区分四种磁盘形态：
* missing = 磁盘上零字节（唯一可称「未下载」的形态）；
* partial = 只有 .part 半成品或正式文件尺寸不符（未完成，有字节）；
* unverified = 正式文件在且尺寸精确，但 verified.json 标记不在案
* （待校验：刷新走 verifyExisting 自愈，或下载入口校验后补标记）；
* ready = 文件在位 + 尺寸精确 + 标记在案。
*/
export type OnDeviceModelState =
| { kind: 'missing'; modelId: string}
| { kind: 'partial'; modelId: string; receivedBytes: number}
| { kind: 'unverified'; modelId: string; sizeBytes: number}
| ({ kind: 'downloading'; modelId: string} & OnDeviceModelProgress)
| {
kind: 'verifying';
modelId: string;
fileName: string;
fileIndex: number;
totalFiles: number;
overallFraction: number;
}
| { kind: 'ready'; modelId: string; path: string; sizeBytes: number}
| { kind: 'error'; modelId: string; message: string; canRetry: boolean};
/** 续传记录 kv 面（生产实现 = SqlSettingsDao 的 get/set/delete 子集） */
export interface OnDeviceResumeKv {
get(key: string): Promise<string | null>;
set(key: string, value: string): Promise<void>;
delete(key: string): Promise<void>;
}
/** 可保存的下载任务状态（JSON 可序列化，落 SQLite kv 跨进程恢复） */
export interface OnDeviceDownloadSavable {
url: string;
fileUri: string;
resumeData?: string;
}
/** 一次可断点续传的下载任务（生产实现包 expo-file-system 的 DownloadResumable） */
export interface OnDeviceResumableDownload {
/** 开始下载；以 resumeData 构造时为续传。完成返回 HTTP 状态 */
run(): Promise<{ status: number}>;
/** 当前可保存状态（供节流持久化；尚无续传凭据时 resumeData 缺省） */
savable(): OnDeviceDownloadSavable;
}
/** 存储/下载依赖面（生产实现走 expo-file-system/legacy，测试注入假实现） */
export interface OnDeviceModelStoreDeps {
/** 模型根目录 URI（documentDirectory + 'crish-llm-models/'），模型子目录在其下 */
rootDir: string;
ensureDir(path: string): Promise<void>;
fileSize(path: string): Promise<number | null>;
/** 原生加速 SHA-256（可选；返回 64 位小写十六进制，失败/不可用返回 null） */
computeSha256?(path: string): Promise<string | null>;
readChunk?(
path: string,
position: number,
length: number
): Promise<Uint8Array>;
writeTextFile(path: string, content: string): Promise<void>;
readTextFile(path: string): Promise<string | null>;
remove(path: string): Promise<void>;
move(from: string, to: string): Promise<void>;
/** 当前可用磁盘字节数；取不到返回 null（预检此时不拦截、不虚报） */
freeDiskSpace(): Promise<number | null>;
/** 续传记录 kv（SQLite settings 表） */
kv: OnDeviceResumeKv;
/** 创建一次下载任务；resumeData 存在时任务以续传方式运行 */
createResumableDownload(
url: string,
destPath: string,
resumeData: string | undefined,
onProgress: (receivedBytes: number, totalBytes: number) => void
): OnDeviceResumableDownload;
}
const MARKER_NAME = 'verified.json';
const HASH_CHUNK_BYTES = 2 * 1024 * 1024;
/** 下载前空间预检余量系数：需要 可用空间 ≥ 文件大小 × 1.1 */
const SPACE_HEADROOM_FACTOR = 1.1;
/** 续传记录 kv 键前缀（值 = OnDeviceDownloadSavable 的 JSON） */
const RESUME_KV_PREFIX = 'ondevice.resume.';
/** 续传状态节流持久化：至少间隔 1.5s 或新增 4MiB 才再写一次 kv */
const RESUME_PERSIST_MIN_INTERVAL_MS = 1500;
const RESUME_PERSIST_MIN_BYTES = 4 * 1024 * 1024;
interface SavedResume extends OnDeviceDownloadSavable {
savedAt: number;
}
export class OnDeviceModelManager {
private readonly deps: OnDeviceModelStoreDeps;
private readonly specs: readonly OnDeviceModelSpec[];
private readonly byId: ReadonlyMap<string, OnDeviceModelSpec>;
/** 逐模型在途下载去重：同模型并发调用共享同一轮下载 */
private readonly inflight = new Map<string, Promise<OnDeviceModelState>>();
/** 状态订阅者（L0）：管理器是唯一状态源，VM 卸载不丢终态——终态保留在 lastStates，新订阅方经 lastKnownStates() 补齐 */
private readonly listeners = new Set<(state: OnDeviceModelState) => void>();
/** 逐模型最近一次已知状态（事件流写入；check 查询结果仅在未被事件流超越时写入，见 recordFromCheck） */
private readonly lastStates = new Map<string, OnDeviceModelState>();
/** 逐模型事件序号：每次 emit 递增，check 以此识别自己的观测是否已被更新的事件超越 */
private readonly stateSeq = new Map<string, number>();
constructor(
deps: OnDeviceModelStoreDeps,
specs: readonly OnDeviceModelSpec[] = ON_DEVICE_MODEL_CATALOG
) {
this.deps = deps;
this.specs = specs;
this.byId = new Map(specs.map((s) => [s.id, s]));
}
/** 全部目录条目（管理面呈现用） */
listSpecs(): readonly OnDeviceModelSpec[] {
return this.specs;
}
/** 按 id 取目录条目（未知 id 返回 undefined） */
spec(modelId: string): OnDeviceModelSpec | undefined {
return this.byId.get(modelId);
}
/**
* 订阅状态事件（L0）：ensureReady / verifyExisting / remove 产生的
* 每个状态都经此通道发出，与调用方的 onState 同源。返回退订函数。
* 管理面 VM 挂载时订阅、卸载时退订；终态保留在管理器内（见
* lastKnownStates），页面离开期间完成的下载不会丢状态。
*/
subscribe(listener: (state: OnDeviceModelState) => void): () => void {
this.listeners.add(listener);
return () => {
this.listeners.delete(listener);
};
}
/** 某模型最近一次已知状态（从未观测过返回 undefined） */
lastKnownState(modelId: string): OnDeviceModelState | undefined {
return this.lastStates.get(modelId);
}
/** 全部已观测模型的最近状态快照（新挂载的管理面以此补齐初值） */
lastKnownStates(): OnDeviceModelState[] {
return [...this.lastStates.values()];
}
/** 事件流统一入口：保留终态 + 递增序号 + 通知订阅者（订阅者异常不污染状态机） */
private emit(state: OnDeviceModelState): void {
this.lastStates.set(state.modelId, state);
this.stateSeq.set(
state.modelId,
(this.stateSeq.get(state.modelId)?? 0) + 1
);
for (const listener of [...this.listeners]) {
try {
listener(state);
} catch {
// 订阅者只是观察方：其异常不得影响下载/校验主流程
}
}
}
/**
* check 查询结果写入保留态的守卫：下载在途时以事件流为准；查询
* 开始后该模型已有更新事件落地时，迟到的旧观测不得覆盖新终态。
*/
private recordFromCheck(state: OnDeviceModelState, seqAtStart: number): void {
if (this.inflight.has(state.modelId)) return;
if ((this.stateSeq.get(state.modelId)?? 0)!== seqAtStart) return;
this.lastStates.set(state.modelId, state);
}
private dirOf(spec: OnDeviceModelSpec): string {
return this.deps.rootDir + spec.id + '/';
}
private pathOf(spec: OnDeviceModelSpec): string {
return this.dirOf(spec) + spec.fileName;
}
private partPathOf(spec: OnDeviceModelSpec): string {
return this.pathOf(spec) + '.part';
}
private markerPathOf(spec: OnDeviceModelSpec): string {
return this.dirOf(spec) + MARKER_NAME;
}
private resumeKeyOf(spec: OnDeviceModelSpec): string {
return RESUME_KV_PREFIX + spec.id;
}
/**
* 交给原生推理引擎的模型文件路径（真实文件系统路径，已剥 file://
* scheme；同 ASR 的 toNativeFilePath 纪律）。未知 id 返回 null。
*/
localPath(modelId: string): string | null {
const spec = this.byId.get(modelId);
if (!spec) return null;
return toNativeFilePath(this.pathOf(spec));
}
/**
* 快速就绪检查（廉价核对，不算哈希）：区分四种磁盘形态——
* 文件齐全 + 尺寸精确 + 校验标记在案 → ready；正式文件在且尺寸
* 精确但标记不在案 → unverified（待校验）；只有 .part 半成品或
* 正式文件尺寸不符 → partial（未完成）；零字节 → missing。
* （哈希在下载完成时已全量验证并记录标记；启动时不重算，
* 同 ASR check() 的廉价口径。）
*/
async check(modelId: string): Promise<OnDeviceModelState> {
const spec = this.byId.get(modelId);
if (!spec) return { kind: 'missing', modelId};
const seqAtStart = this.stateSeq.get(modelId)?? 0;
const state = await this.inspect(spec);
this.recordFromCheck(state, seqAtStart);
return state;
}
/** check 的磁盘形态判定本体（checkAll 共用同一口径） */
private async inspect(
spec: OnDeviceModelSpec
): Promise<OnDeviceModelState> {
const modelId = spec.id;
try {
await this.deps.ensureDir(this.dirOf(spec));
const formalSize = await this.deps.fileSize(this.pathOf(spec));
if (formalSize === spec.size) {
const marker = await this.readMarker(spec);
if (marker[spec.fileName] === spec.sha256) {
return {
kind: 'ready',
modelId,
path: toNativeFilePath(this.pathOf(spec)),
sizeBytes: spec.size,
};
}
return { kind: 'unverified', modelId, sizeBytes: formalSize};
}
const partSize =
(await this.deps.fileSize(this.partPathOf(spec)))?? 0;
if (partSize > 0) {
return { kind: 'partial', modelId, receivedBytes: partSize};
}
if (formalSize!== null && formalSize > 0) {
return { kind: 'partial', modelId, receivedBytes: formalSize};
}
return { kind: 'missing', modelId};
} catch {
return { kind: 'missing', modelId};
}
}
/** 全部目录模型的快速检查（管理面一次取齐） */
async checkAll(): Promise<OnDeviceModelState[]> {
const out: OnDeviceModelState[] = [];
for (const spec of this.specs) {
out.push(await this.check(spec.id));
}
return out;
}
/** 某模型当前磁盘占用（正式文件 +.part 半成品，不含标记文件） */
async usageBytes(modelId: string): Promise<number> {
const spec = this.byId.get(modelId);
if (!spec) return 0;
const formal = (await this.deps.fileSize(this.pathOf(spec)))?? 0;
const part = (await this.deps.fileSize(this.partPathOf(spec)))?? 0;
return formal + part;
}
/** 全部目录模型磁盘占用合计（管理面「总占用」显示） */
async totalUsageBytes(): Promise<number> {
let sum = 0;
for (const spec of this.specs) {
sum += await this.usageBytes(spec.id);
}
return sum;
}
/**
* 删除本地模型（管理入口）：正式文件 +.part 半成品 + 校验标记 +
* 续传 kv 记录一并清除。幂等：文件/记录本不存在时静默成功，
* 重复调用无碍；删除后 check() 回到 missing，可重新下载。
*/
async remove(modelId: string): Promise<void> {
const spec = this.byId.get(modelId);
if (!spec) return;
await this.deps.remove(this.pathOf(spec));
await this.deps.remove(this.partPathOf(spec));
await this.deps.remove(this.markerPathOf(spec));
await this.deps.remove(this.dirOf(spec));
await this.deps.kv.delete(this.resumeKeyOf(spec));
this.emit({ kind: 'missing', modelId});
}
/** 高效校验单个文件：尺寸预检 + 原生加速哈希（降级纯 JS 分块）比对 */
async verifyFile(
spec: OnDeviceModelSpec,
targetPath?: string
): Promise<boolean> {
const path = targetPath?? this.pathOf(spec);
const size = await this.deps.fileSize(path);
if (size!== spec.size) return false;
let computedHash: string | null = null;
if (this.deps.computeSha256) {
try {
computedHash = await this.deps.computeSha256(path);
} catch {
computedHash = null;
}
}
if (!computedHash && this.deps.readChunk) {
const hasher = sha256.create();
let position = 0;
while (position < size) {
const length = Math.min(HASH_CHUNK_BYTES, size - position);
const chunk = await this.deps.readChunk(path, position, length);
if (chunk.length === 0) return false;
hasher.update(chunk);
position += chunk.length;
}
computedHash = bytesToHex(hasher.digest());
}
return computedHash === spec.sha256;
}
/**
* 确保模型就绪（显式下载入口，不做首启自动调用）：缺失/损坏则
* 下载（多源回退 + 断点续传）并校验，全程通过 onState 回报诚实
* 状态。成功返回 ready，失败返回 error（canRetry 指明可否重试）。
*/
async ensureReady(
modelId: string,
onState: (state: OnDeviceModelState) => void
): Promise<OnDeviceModelState> {
const existing = this.inflight.get(modelId);
if (existing) return existing;
// 状态双通道同源：调用方 onState 与订阅/保留态吃同一份事件流
const tracked = (state: OnDeviceModelState): void => {
this.emit(state);
onState(state);
};
const run = this.ensureReadyInternal(modelId, tracked).finally(() => {
this.inflight.delete(modelId);
});
this.inflight.set(modelId, run);
return run;
}
private async ensureReadyInternal(
modelId: string,
onState: (state: OnDeviceModelState) => void
): Promise<OnDeviceModelState> {
const spec = this.byId.get(modelId);
if (!spec) {
const failure: OnDeviceModelState = {
kind: 'error',
modelId,
message: `未知模型：${modelId}`,
canRetry: false,
};
onState(failure);
return failure;
}
try {
await this.deps.ensureDir(this.dirOf(spec));
const path = this.pathOf(spec);
const size = await this.deps.fileSize(path);
const marker = await this.readMarker(spec);
// 已在案且尺寸吻合：快速就绪（哈希在下载时已全量验证）
if (size === spec.size && marker[spec.fileName] === spec.sha256) {
const ready: OnDeviceModelState = {
kind: 'ready',
modelId,
path: toNativeFilePath(path),
sizeBytes: spec.size,
};
onState(ready);
return ready;
}
// 文件已在且尺寸吻合但标记不在案：哈希自愈校验，通过则补标记
if (size === spec.size) {
const healed = await this.healExisting(spec, onState);
if (healed) return healed;
// 哈希不符：非破坏性策略，不删既有文件，后续下载以.part+move 覆盖
}
// 下载前空间预检：可用 < 文件大小 × 1.1 直接拒绝并给出数字
const free = await this.deps.freeDiskSpace();
const needed = Math.ceil(spec.size * SPACE_HEADROOM_FACTOR);
if (free!== null && free < needed) {
const failure: OnDeviceModelState = {
kind: 'error',
modelId,
message:
`设备可用空间不足：下载 ${spec.displayName} 约需 ` +
`${formatBytes(needed)}（含余量），当前可用 ${formatBytes(free)}。` +
`请先清理空间后重试。`,
canRetry: true,
};
onState(failure);
return failure;
}
await this.downloadAndVerify(spec, onState);
await this.writeMarker(spec);
const ready: OnDeviceModelState = {
kind: 'ready',
modelId,
path: toNativeFilePath(path),
sizeBytes: spec.size,
};
onState(ready);
return ready;
} catch (error) {
const failure: OnDeviceModelState = {
kind: 'error',
modelId,
message: error instanceof Error? error.message: '模型下载失败',
canRetry: true,
};
onState(failure);
return failure;
}
}
/**
* 已有正式文件的自愈校验（ensureReady 与 verifyExisting 共用）：
* 发 verifying → 全量校验 → 通过则补写标记并发 ready；不通过返回
* null（调用方决定落下载还是报诚实错误）。既有文件绝不删除。
*/
private async healExisting(
spec: OnDeviceModelSpec,
emitState: (state: OnDeviceModelState) => void
): Promise<OnDeviceModelState | null> {
emitState({
kind: 'verifying',
modelId: spec.id,
fileName: spec.fileName,
fileIndex: 1,
totalFiles: 1,
overallFraction: 0,
});
if (!(await this.verifyFile(spec))) return null;
await this.writeMarker(spec);
const ready: OnDeviceModelState = {
kind: 'ready',
modelId: spec.id,
path: toNativeFilePath(this.pathOf(spec)),
sizeBytes: spec.size,
};
emitState(ready);
return ready;
}
/**
* 只校验不下载（L0 刷新自愈入口）：正式文件在、尺寸对、标记不在案
* （unverified）时走 healExisting；通过变 ready 并补标记，不通过变
* 诚实 error（不自动重下载、不删既有文件）。其余形态直查返回。
*/
async verifyExisting(
modelId: string,
onState: (state: OnDeviceModelState) => void
): Promise<OnDeviceModelState> {
const tracked = (state: OnDeviceModelState): void => {
this.emit(state);
onState(state);
};
const current = await this.check(modelId);
if (current.kind!== 'unverified') return current;
const spec = this.byId.get(modelId);
if (!spec) return current;
const healed = await this.healExisting(spec, tracked);
if (healed) return healed;
const failure: OnDeviceModelState = {
kind: 'error',
modelId,
message:
`模型文件哈希校验不匹配：${spec.fileName}。` +
'文件已在盘上但内容不正确，请删除后重新下载。',
canRetry: true,
};
tracked(failure);
return failure;
}
/**
* 下载并校验单个模型文件：逐源尝试；每源先试续传（若有在案记录），
* 续传失败自动回退整文件重下。.part 阶段就地校验，百分百通过才
* 原子 move 落正；全部来源失败抛最后一个错误。
*/
private async downloadAndVerify(
spec: OnDeviceModelSpec,
onState: (state: OnDeviceModelState) => void
): Promise<void> {
const partPath = this.partPathOf(spec);
const saved = await this.readSavedResume(spec);
let lastError: unknown = null;
for (const url of spec.urls) {
const attempts: (string | undefined)[] = [];
if (saved && saved.url === url && saved.fileUri === partPath) {
attempts.push(saved.resumeData);
}
attempts.push(undefined);
for (const resumeData of attempts) {
try {
await this.runDownloadAttempt(spec, url, resumeData, onState);
const partSize = await this.deps.fileSize(partPath);
if (partSize!== spec.size) {
throw new Error(
`模型文件大小不符：${spec.fileName}（期望 ${spec.size}，实际 ${partSize?? '未知'}）`
);
}
onState({
kind: 'verifying',
modelId: spec.id,
fileName: spec.fileName,
fileIndex: 1,
totalFiles: 1,
overallFraction: 1,
});
const valid = await this.verifyFile(spec, partPath);
if (!valid) {
// 内容已被证明错误：.part 留着只会成为下次续传的错误前缀，
// 与续传记录一并清除（失败状态文案保持哈希不匹配口径）
await this.deps.kv.delete(this.resumeKeyOf(spec));
await this.deps.remove(partPath);
throw new Error(`模型文件哈希校验不匹配：${spec.fileName}`);
}
await this.deps.move(partPath, this.pathOf(spec));
await this.deps.kv.delete(this.resumeKeyOf(spec));
return;
} catch (error) {
lastError = error;
if (resumeData!== undefined) {
// 续传不被接受：清掉在案记录与半成品，下一 attempt 整文件重下
await this.deps.kv.delete(this.resumeKeyOf(spec));
await this.deps.remove(partPath);
}
// 非破坏性保护：绝不惩罚性删除既有正式文件
}
}
}
throw lastError instanceof Error
? lastError
: new Error(`模型下载失败：${spec.fileName}`);
}
/**
* 执行一次下载 attempt：进度回调发状态 + 节流持久化续传凭据。
* HTTP 非 200 判失败（同 ASR 口径）。
*/
private async runDownloadAttempt(
spec: OnDeviceModelSpec,
url: string,
resumeData: string | undefined,
onState: (state: OnDeviceModelState) => void
): Promise<void> {
const partPath = this.partPathOf(spec);
let handle: OnDeviceResumableDownload | null = null;
let lastPersistAt = 0;
let lastPersistedBytes = 0;
let persistInFlight = false;
let speedSampleAt = Date.now();
let speedSampleBytes = 0;
let speedBytesPerSec: number | undefined;
const persistSavable = (): void => {
if (!handle || persistInFlight) return;
persistInFlight = true;
void (async () => {
try {
const state = handle!.savable();
if (state.resumeData) {
const record: SavedResume = {...state, savedAt: Date.now()};
await this.deps.kv.set(
this.resumeKeyOf(spec),
JSON.stringify(record)
);
}
} catch {
// 续传凭据持久化是尽力而为：失败只损失续传点，不影响本次下载
} finally {
persistInFlight = false;
}
})();
};
handle = this.deps.createResumableDownload(
url,
partPath,
resumeData,
(received) => {
const now = Date.now();
if (now - speedSampleAt >= 400 && received > speedSampleBytes) {
speedBytesPerSec = Math.round(
((received - speedSampleBytes) / (now - speedSampleAt)) * 1000
);
speedSampleAt = now;
speedSampleBytes = received;
}
const overall = spec.size > 0? received / spec.size: 0;
onState({
kind: 'downloading',
modelId: spec.id,
fileName: spec.fileName,
fileIndex: 1,
totalFiles: 1,
receivedBytes: received,
totalBytes: spec.size,
overallFraction: overall,
progressText: `${formatBytes(received)} / ${formatBytes(spec.size)} (${Math.round(overall * 100)}%)`,
...(speedBytesPerSec!== undefined? { speedBytesPerSec}: {}),
});
if (
now - lastPersistAt >= RESUME_PERSIST_MIN_INTERVAL_MS ||
received - lastPersistedBytes >= RESUME_PERSIST_MIN_BYTES
) {
lastPersistAt = now;
lastPersistedBytes = received;
persistSavable();
}
}
);
try {
const result = await handle.run();
if (result.status!== 200) {
throw new Error(`下载失败（HTTP ${result.status}）：${url}`);
}
} catch (error) {
// 失败退出前尽力再存一次续传凭据（杀进程/断网后可续）
persistSavable();
throw error;
}
}
private async readSavedResume(
spec: OnDeviceModelSpec
): Promise<SavedResume | null> {
try {
const raw = await this.deps.kv.get(this.resumeKeyOf(spec));
if (!raw) return null;
const parsed: unknown = JSON.parse(raw);
if (typeof parsed!== 'object' || parsed === null) return null;
const record = parsed as Partial<SavedResume>;
if (
typeof record.url!== 'string' ||
typeof record.fileUri!== 'string' ||
typeof record.resumeData!== 'string'
) {
return null;
}
return record as SavedResume;
} catch {
return null;
}
}
private async readMarker(
spec: OnDeviceModelSpec
): Promise<Record<string, string>> {
try {
const raw = await this.deps.readTextFile(this.markerPathOf(spec));
if (!raw) return {};
const parsed: unknown = JSON.parse(raw);
if (typeof parsed!== 'object' || parsed === null) return {};
return parsed as Record<string, string>;
} catch {
return {};
}
}
private async writeMarker(spec: OnDeviceModelSpec): Promise<void> {
const marker: Record<string, string> = { [spec.fileName]: spec.sha256};
await this.deps.writeTextFile(
this.markerPathOf(spec),
JSON.stringify(marker)
);
}
}
/**
* 生产依赖实现（expo-file-system/legacy）。kv 为注入的 SQLite
* settings DAO（get/set/delete 子集，装配归 wiring 层，同
* settingsStore 的 configureSettingsPersistence 纪律）。
*/
export function createExpoOnDeviceModelStoreDeps(
kv: OnDeviceResumeKv
): OnDeviceModelStoreDeps {
const rootDir = (FileSystem.documentDirectory?? '') + 'crish-llm-models/';
return {
rootDir,
kv,
async ensureDir(path) {
const info = await FileSystem.getInfoAsync(path);
if (!info.exists) {
await FileSystem.makeDirectoryAsync(path, { intermediates: true});
}
},
async fileSize(path) {
const info = await FileSystem.getInfoAsync(path);
return info.exists && 'size' in info? info.size: null;
},
async computeSha256(path) {
// 复用 crish-asr 原生模块的通用文件 SHA-256（与 ASR 管理器同口径）
const native = getCrishAsrNative();
if (native?.fileSha256) {
try {
return await native.fileSha256(toNativeFilePath(path));
} catch {
return null;
}
}
return null;
},
async readChunk(path, position, length) {
const base64 = await FileSystem.readAsStringAsync(path, {
encoding: FileSystem.EncodingType.Base64,
position,
length,
});
return base64ToBytes(base64);
},
async writeTextFile(path, content) {
await FileSystem.writeAsStringAsync(path, content);
},
async readTextFile(path) {
const info = await FileSystem.getInfoAsync(path);
if (!info.exists) return null;
return FileSystem.readAsStringAsync(path);
},
async remove(path) {
await FileSystem.deleteAsync(path, { idempotent: true});
},
async move(from, to) {
await FileSystem.moveAsync({ from, to});
},
async freeDiskSpace() {
try {
return await FileSystem.getFreeDiskStorageAsync();
} catch {
return null;
}
},
createResumableDownload(url, destPath, resumeData, onProgress) {
const task = FileSystem.createDownloadResumable(
url,
destPath,
{},
(progress) => {
onProgress(
progress.totalBytesWritten,
progress.totalBytesExpectedToWrite
);
},
resumeData
);
return {
async run() {
const result = resumeData
? await task.resumeAsync()
: await task.downloadAsync();
if (!result) {
throw new Error(`下载无响应：${url}`);
}
return { status: result.status};
},
savable() {
const state = task.savable();
return {
url: state.url,
fileUri: state.fileUri,
...(state.resumeData? { resumeData: state.resumeData}: {}),
};
},
};
},
};
}
/**
* 全局单例（惰性，需注入 kv 后首次调用时组装）：UI 与服务层共用
* 同一管理器。惰性初始化避免模块导入期触碰原生文件系统
* （jest / Web 环境安全）。
*/
let singleton: OnDeviceModelManager | null = null;
export function onDeviceModelManager(
kv: OnDeviceResumeKv
): OnDeviceModelManager {
if (!singleton) {
singleton = new OnDeviceModelManager(createExpoOnDeviceModelStoreDeps(kv));
}
return singleton;
}
export default onDeviceModelManager;
