# device-protocol 跨端对拍样例集（R0-05）

> 多端互通 R0-05 任务（TS↔Rust 对拍闭环）共享样例集：**同一份 JSON 载荷双端消费**——
> Rust 侧 `crates/conex-types/tests/device_parity.rs` 与 TS 侧
> `packages/shared-types/src/generated/device/parity.test.ts` 均以本目录为唯一输入。
> 编码：UTF-8 无 BOM；样例集是入库资产（AGENTS.md「测试是资产不是杂物」）。

## 目录结构

| 路径 | 内容 |
|------|------|
| `valid/` | 16 个**合法**样例（双端必须解析成功 + 重序列化与样例一致） |
| `invalid/` | 6 个**非法**样例（双端必须解析失败） |

样例编号 `NN-<kind 名>.json`，覆盖核心消息族：DeviceEnvelope 信封 / 配对请求响应
（pair.*）/ 握手（auth.*）/ 事件 push（含 preview 帧）/ 续传游标（resume.*）/
审批命令（remote.approve + result.approve）/ 流块（stream.chunk）/ 错误码（error）。

## 消费规则（双侧一致约定）

1. **规范形态**：样例即 wire 形态，遵循 Rust serde 序列化纪律——`preview=false`
   等默认值省略、可选字段省略；`pair.hello.code` 为 12 字符标准化形态
   （无 `CXN-` 前缀与分隔符）。双侧解析后重序列化，与样例做**规范化比较**
   （canonical JSON：键码点升序递归排序，参考 `cache-rules.test.ts` 先例）。
2. **valid**：解析成功 + 重序列化规范化一致（含 body 按 kind 的类型化解析，
   Rust 侧额外校验 body 强类型）。
3. **invalid**：解析失败（信封层或 body 层任一失败即失败）。
4. **规范化差异说明**：TS parser 对可选 bool 字段原样保留 `false`，Rust serde
   `skip_serializing_if` 省略——样例规避该差异面（可选 bool 只写 `true` 或省略），
   保持双端重序列化结论一致。

## R0-02a/b 对拍注记裁决（R0-05 统一）

| 注记 | 差异 | 裁决 | 落点 |
|------|------|------|------|
| 配对码字符集 | D3 §4.1 32 字符集（**含 L**）vs M6 §10.3 regex（不含 L） | **以 ADR-06 / D3 §4.1 为唯一真源（含 L）**；Rust `PAIR_CODE_ALPHABET` 已含 L 并强校验；TS parser 层保持形状校验宽容（字符集权威校验在 Rust 网关层，D3 §8.3）；注册表 `pair.hello.code` description 已补明字符集 | 样例 `01-pair-hello.json` 使用含 L 码 `7K4LQ2MB9XRT` 锁定；`invalid/` 不收录「混淆字符码」用例（TS 层接受属已知宽容差异，不做双端一致断言） |
| canon 输入差异 | D3 §5.1（deviceId∥ts∥nonce∥msgId∥kind∥v）vs M6 §10.1（含 from/to） | **以 D3 §5.1 为真源**（Z0 §4.2 复述）；Rust `canonical_signing_payload` 已对齐；M6 §10.1 描述差异以本裁决为准 | Rust 侧 `device_parity.rs` 以 `13-remote-approve.json` 锁定 canon 串字节形态 |
| tauri_command 占位 | C13/C14/C21/C22/C27/C30/C31 为 [新增] 登记先行命令（X-5） | 注册表 `commands[].tauriCommand` 已全部填写预期命令名（无空占位），`registry_drift.rs` 已断言非空；登记先行命令 R1 后接线，接线完成前网关不得暴露 | 无需改动（registry_drift 已锁） |
| ResumeState 死条目 | 注册表 `types.ResumeState`（`{entries}` 包裹建模）与 Rust 侧 `#[serde(transparent)] HashMap`（wire 直接为映射）不符，且无任何消息字段引用（死条目） | **删除注册表死条目**；语义锚定为「会话 id → sequence 整数映射」（Rust transparent 形态）；TS 生成产物随注册表重跑移除 `ResumeState`/`parseResumeState`；`lastSequences`/`resume` 保持 JsonValue（TS 宽容）+ Rust 强类型 | 注册表已删 `types.ResumeState`；样例 `05-auth-hello.json`（resume）与 `07-events-subscribe.json`（lastSequences）以裸映射形态锁定 |

## 门禁接线

- **Rust 侧**：`cargo test --workspace` 已含 `crates/conex-types/tests/device_parity.rs`
  （ci-mid.yml `rust-test` job 覆盖）；
- **TS 侧**：vitest unit 项目 include 面已含 `packages/shared-types/src/generated/device/*.test.ts`
  （ci-mid.yml `test` job 与快层 vitest-fast 覆盖）；
- 无需新增 CI job——D8 §5.3.3 的 protocol-parity 两层由既有 rust-test + test 两 job 承载。
