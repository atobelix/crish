# PREP · 2026-08-12 post-sd13c2-wave · 本轮并行备忘

| 元数据                                         | 值                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| **轮次**                                       | ①∥② 同轮 · T=8 · E=0                                                                  |
| **审计产出**                                   | 本目录 `00`–`06`（①a=00–04 · ①b=05 · ①c=06）                                          |
| **上轮已合入（① 必审 · 禁整包重做）**          | SD-13 Slash · SD-15 Strict260 · SD-16 fts · CONN-C2 · W6-A-S A-BLK-08                 |
| **本轮 ② 写死（① 04 记「本轮同开」· 禁再派）** | SD-17 · SD-13-R · W4-R · CONN-G2-int · A-MD（blockquote_nested_table）                |
| **锚**                                         | `19` 下一闸；`audit/post-g2e3-wave/{00,04,05,06}`；功能簇 `39e062e5`；docs `a3a16fa9` |

## 0. 调度钉死

- `T = ①3 + ②5 + ③0 = 8` ∈ [6,16]
- ② 含 **≥2 SD/CONN**（本轮 3：SD-17 · SD-13-R · CONN-G2-int）
- ③ **E=0**（无假关/回退红）
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- 禁止 `--no-verify`；禁止 `reset --hard`；提交用 `git commit --only` + UTF-8 无 BOM 信息文件

## 1. 上轮已消化（① 审这些 · ② 禁整包）

| 包               | 主面                                            | 禁                          |
| ---------------- | ----------------------------------------------- | --------------------------- |
| **SD-13** Slash  | Overlay ~161 + catalog/hooks + line-budget ≤220 | 整包重切 Overlay            |
| **SD-15** Strict | 主文件 ~260 + shell/assembly + line-budget ≤399 | 从零再外置 / 改互斥默认     |
| **SD-16** fts    | 门面 ~319 + search/index/tests                  | 从零再切 fts                |
| **CONN-C2**      | `enableProductPaperList` 默认关 + `conn_c2_*`   | 整包会计；默改 true 须新 ID |
| **W6-A-S**       | A-BLK-08 turn_into 抽样；保 `-S`                | 去 `-S`；抽样关 EL-01       |

**累计禁派（整包）**：G2 / E3 / SD-12(query) / SD-14 / A-MD(task_nested_table) / C2 会计 / T=13 七包 / T=12 / 还债 SD-01…11 / SD-04-R-G / W6-D-S / W6-B A-IME-06。

## 2. 本轮 ② 写死（并行 · 文件域互斥）

| #   | 包 ID           | 锁                                                                                 | 完成定义（可测）                                                                                                                  | ≠                    |
| --- | --------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | **SD-17**       | `crates/conex-workspace-store/src/projection.rs`（现 **787**）+ 新切分文件         | ① 主文件 &lt;500 或 实现&lt;500+测旁挂且单文件&lt;700 ② 既有投影/FTS 一致测形状绿 ③ `lib`/`#[path]` 无孤儿 ④ 不切 refs / os_watch | EL-03                |
| 2   | **SD-13-R**     | `packages/block-paper/src/leaves/turnInto.ts`（现 **528**）                        | ① 主文件显著下降（建议 &lt;400）② 既有 turn-into / D3 / W3-H 测形状绿 ③ **≠** Overlay 重做 **≠** PaperList 本包                   | EL-01 / A-BLK-08 e2e |
| 3   | **W4-R**        | `crates/agent-tools`：新 `note_block_set_attr` + matrix/permission/registry        | ① 独立工具 `block_set_attr` 注册 ② 矩阵+plan Deny+新测名 ③ 不重做 insert/update/delete/move 整包                                  | EL-05 / W6-E         |
| 4   | **CONN-G2-int** | 新测文件（建议 `conn-g2.product-apply-strict-refresh.test.tsx`）                   | ① product_apply → Strict 同 doc blocks/rev 前进 ② 异 doc 不误刷 ③ 失败/0 不刷 ④ **不**重做 G2 总线整包                            | EL-01/08             |
| 5   | **A-MD**        | `crates/conex-md-ast/tests/golden/gfm-core/blockquote_nested_table.md` + golden 测 | ① 新路径+新测名可点名 ② **≠** 重做 `task_nested_table`                                                                            | EL-06 / A-MD-01 全集 |

## 3. ① 目的清单（写入 00/01）

1. 上列五包主完成定义是否可证伪、是否假关 EL / 去 `-S`
2. C2 默认关 + 互斥是否回退
3. SD-15 行数门 / presentationMode 是否回退
4. SD-16 切开后 FTS 语义/孤儿
5. W6-A-S 是否仍带 `-S`
6. 黄带余量：projection/refs/os_watch/turnInto/PaperList（计量 Δ）
7. 交叉：G2 缺一体测是否仍在（本轮 ② 在补）；E2 默认关；Workspace 仍不默装 detect

## 4. ① 落盘约定

- ①a：**只写** `00` `01` `02` `03` `04`（可更新本 PREP 勾选，勿删）
- ①b：**只写** `05-结构规范-上帝文件-长逻辑.md`
- ①c：**只写** `06-交叉连通性审计.md`
- 禁止改业务代码；禁止覆盖对方文件
- UTF-8 无 BOM；中文；证据 `路径:行号` / 测名
- 04 的 ② 表必须吸收未还 SD/CONN；**把本轮同开五包标已消化**

## 5. ② 提交

可 `git commit --only` 限定本包路径。信息：`feat(block-workspace): <包ID> …` 或 `test(...)`。中文信息用 Python 写 UTF-8 无 BOM 再 `git -c i18n.commitEncoding=utf-8 commit --only <paths> -F msg`。

## 6. ①a 勾选（2026-08-12 · 只追加 · 未删上文）

| ☑   | 项                               | 结论                                   |
| --- | -------------------------------- | -------------------------------------- |
| ☑   | 五包完成定义可证伪               | 绿 · 见 `01`                           |
| ☑   | 假关 EL / 去 `-S` / fixture 伪装 | 否                                     |
| ☑   | C2 默认关 + 互斥                 | 未回退                                 |
| ☑   | SD-15 行数门 / presentationMode  | 未回退                                 |
| ☑   | SD-16 孤儿 / FTS 语义            | 无孤儿；未见静默改                     |
| ☑   | W6-A-S 仍 `-S`                   | 是                                     |
| ☑   | 黄带计量                         | `01` §5；投影/turnInto 属本轮同开切开  |
| ☑   | 交叉 G2/E2/Workspace detect      | E2/Workspace 仍默认关；G2-int 本轮同开 |
| ☑   | 04 标本轮同开五包                | 是；E=0；②=5 行 ≥2 SD/CONN             |
| —   | 测真跑                           | **否**（无终端面；`02` §2 待主控补跑） |

产出：本目录 `00`–`04`。**未**写/覆盖 `05`/`06`。

_2026-08-12 · 主控 PREP · post-sd13c2-wave_
