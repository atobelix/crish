# AC-01 命令红线绕过链修复验收（P0-1）

- 验收员：独立验收（未读任何修复报告，只读 + 运行测试）
- 验收日期：2026-08-08
- 验收对象：PS-01 红测试提交 `f59487c2` + 修复提交 `30017c43`
- 验收口径：门禁层 `CommandGatekeeper::check_command`（与 r1_redline_chain.rs 同口径）

## 验收结论：**通过（带 2 个过拦截发现项 + 1 个 flaky 观察）**

- 8/8 绕过形态修复后全部 Blocked；自己构造的 22 个攻击变体 + 12 个混淆/判别变体全部拦截，零漏拦截。
- 对照组 `ls -la` / `git status` / `rm -rf dist` 不误伤。
- 红测试提交真实有效：worktree 隔离实测修复前 `3 passed; 9 failed`（与提交声明 "9 failed as expected" 完全一致），测试文件在红→修两段提交间**零修改**（未被弱化）。
- 发现项均非漏拦截（安全方向），见 §5。

---

## 1. 红测试存在性

| 项目 | 证据 |
|---|---|
| 红测试提交 | `f59487c2` test(conex-sandbox): PS-01 redline bypass chain red tests — 8/8 forms must be Blocked [RED PHASE: 9 failed as expected]，仅新增 `crates/conex-sandbox/tests/r1_redline_chain.rs`（129 行） |
| 修复提交 | `30017c43` fix(conex-sandbox): seal red-line bypass chain … [GREEN PHASE]，仅改 3 文件：`semantics.rs` +570 / `lib.rs` +21 / `agent-tools/shell.rs` +13 |
| 时间线 | 红 08-07 20:56 → 修 08-07 21:38（相隔 6 个无关提交：PS-02/PS-03/editor） |

`r1_redline_chain.rs` 覆盖 8/8 形态（逐条对应审计形态）：

| # | 形态 | 测试函数 |
|---|---|---|
| 1 | `$()` 命令替换 | `r1_chain_cmd_subst_blocked` |
| 2 | 反引号 | `r1_chain_backtick_blocked` |
| 3 | 换行分隔（真实 \n） | `r1_chain_newline_printf_blocked` |
| 4 | 换行 + PS 别名 ri | `r1_chain_ps_alias_newline_blocked` |
| 5 | iex | `r1_chain_iex_blocked` |
| 6 | Invoke-Expression | `r1_chain_invoke_expression_blocked` |
| 7 | Start-Process | `r1_chain_start_process_blocked` |
| 8 | -EncodedCommand | `r1_chain_encoded_command_blocked` |

另有对照组（rm -rf -- /、sudo rm -rf /）、上下文变体（cwd==workspace_root 8 形态仍 Blocked）、负例 2 条（引号内换行 `echo "a\nb"`、`echo $HOME && git status`），共 12 个测试。

## 2. 实跑验证（全部命令实测）

### cargo test -p conex-sandbox — **全绿 116 项**
```
unittests src\lib.rs:   test result: ok. 93 passed; 0 failed; 0 ignored
tests\cd_shape.rs:      test result: ok. 11 passed; 0 failed; 0 ignored
tests\r1_redline_chain: test result: ok. 12 passed; 0 failed; 0 ignored
```

### cargo test -p agent-tools — **全绿 525 项**
```
test result: ok. 511 passed; 0 failed; 0 ignored
test result: ok. 14 passed; 0 failed; 0 ignored
test result: ok. 0 passed; 0 failed; 1 ignored
```

### cargo test -p crish-agent-workbench — **3 次全绿 / 1 次 1 failed（flaky，见 §5-O1）**
```
第 2、3、4 次（连续复测）:
unittests src\main.rs:             test result: ok. 445 passed; 0 failed; 2 ignored
tests\config_command_names_contract: test result: ok. 13 passed; 0 failed; 0 ignored
tests\event_bridge_contract:       test result: ok. 17 passed; 0 failed; 0 ignored
```

### RED 阶段真实性（worktree 隔离，未触碰主工作区）
```
git worktree add <tmp> f59487c2 && cargo test -p conex-sandbox --test r1_redline_chain
→ test result: FAILED. 3 passed; 9 failed（断言示例：命令 "printf x\n/bin/rm -rf -- /" 必须被红线拦截（Blocked）left: Allowed）
```
与红测试提交声明 "9 failed as expected" 完全一致；worktree 已移除。

## 3. 攻击性复核（独立构造，临时工程 `%TEMP%\opencode\ac01-attack`，path 依赖 conex-sandbox，未改仓库）

### 3.1 任务书指定变体 — 22/22 Blocked

| 变体 | 结果 |
|---|---|
| `echo "$(rm -rf -- /etc)"` / 双 `$()` 混合 / 赋值 `x=$(…)` | Blocked |
| `echo \`rm -rf -- /etc\`` | Blocked |
| `printf x\n/bin/rm -rf -- /etc`（真实换行）/ CRLF + `Remove-Item C:\ -Recurse -Force` | Blocked |
| `bash -c 'rm -rf -- /etc'` / `bash -c "…"` / `sh -c '…'` | Blocked |
| `powershell -EncodedCommand <base64(/etc)>` / `-e` 短选项 | Blocked |
| `iex 'rm -rf /etc'` / `Invoke-Expression('…')` / `iEx '…'` 大小写 | Blocked |
| `& { rm -rf -- /etc }` / 裸 `$(rm -rf -- /etc)` | Blocked |
| `Start-Process cmd -ArgumentList '/c …'` | Blocked |
| `eval 'rm -rf -- /etc'` / `cmd /c …` / `powershell -Command "…"` | Blocked |
| 递归包裹 `echo "$(bash -c 'rm -rf -- /etc')"` / 20 层 `$()` 嵌套（深度兜底 MAX_WRAP_DEPTH=16） | Blocked |

### 3.2 混淆变体 — 12/12 Blocked（通配/拼接/多空格/pwsh 全拦）

| 变体 | 结果 |
|---|---|
| `rm -rf /e*`（通配匹配 /etc）、`rm -rf -- /e*`、`echo "$(rm -rf /e*)"` | Blocked |
| `rm -rf /e'tc'`（引号拼接）、`echo "$(rm -rf /e' tc')"` | Blocked |
| `rm -rf /etc/`（结尾斜杠）、`rm   -rf   --   /etc`（多空格） | Blocked |
| `pwsh -EncodedCommand …` / `pwsh -e …`（PS Core 命令名） | Blocked |

### 3.3 对照与边界

| 变体 | 结果 | 判定 |
|---|---|---|
| `ls -la` / `git status` / `echo $HOME && git status` | Allowed | ✓ 不误伤 |
| `rm -rf dist`（相对路径） | Allowed | ✓ 符合任务书 |
| `echo '$(echo hi)'` / `echo '$(rm -rf dist)'` | Allowed | ✓ 单引号内 $() 确实不提取（提取器语义正确） |
| `echo "$(rm -rf dist)"` | Allowed | ✓ 双引号内提取生效，相对路径不拦（依赖工作区约束层兜底，见 §5-O2） |
| `echo "a\nb"`（引号内真实换行，无 rm 文本） | Allowed | ✓ 拆段器引号内不拆换行正确 |
| `echo '$(rm -rf /etc)'`（单引号字面量含绝对路径） | **Blocked** | ⚠ 发现项 F1（过拦截） |
| `echo "x\n/bin/rm -rf -- /etc"`（双引号内真实换行含 rm 文本） | **Blocked** | ⚠ 发现项 F2（过拦截） |

## 4. 回归确认

| 检查项 | 证据 |
|---|---|
| 测试未弱化 | `git diff f59487c2..30017c43 -- crates/conex-sandbox/tests/` 输出为空（r1_redline_chain.rs 两段提交间零修改）；修复提交仅改 3 个实现文件 |
| 无新增 #[ignore]/#[allow] | grep `#\[(ignore|allow)` crates/conex-sandbox → 无匹配 |
| 无 --no-verify 痕迹 | 两段提交信息均为规范 feat/test 格式，无 --no-verify 字样 |
| 既有门禁用例保留 | r1_redline_chain.rs 12 个测试全保留通过；lib.rs 既有单元测试（93 项）全绿 |

## 5. 发现项（不修，只报告）

- **F1（过拦截，安全方向，非漏拦截）**：`echo '$(rm -rf /etc)'` 返回 Blocked。判别组证明提取器在单引号内**确实不提取**（`echo '$(rm -rf dist)'` → Allowed），最终 Blocked 源于静态正则层兜底（`rm\s+-rf…\s+/` 模式命中 `/etc` 文本，lib.rs:32 新增 `--` 变体条目所在清单）。即任务书声称"单引号内 $() 不提取（bash 语义）"在提取器层面成立，但最终返回值被静态层抬升为 Blocked。bash 语义下该命令仅打印文本，属超覆盖。若产品要求"字面量不误伤"，需静态层按引号上下文消歧（当前为设计取舍：对象窄化 + 纵深防御，宁可错杀）。
- **F2（过拦截，安全方向，非漏拦截）**：`echo "x\n/bin/rm -rf -- /etc"`（双引号内真实换行）返回 Blocked。拆段器引号内不拆换行正确（既有负例 `echo "a\nb"` → Allowed），Blocked 同样源于静态层文本模式命中。安全含义同上。
- **O1（flaky 观察，与修复无直接关联）**：crish-agent-workbench 首次全量 1 failed（`444 passed; 1 failed; 2 ignored`，失败名未捕获），随后连续 3 次全绿（445/13/17）。修复仅触及 conex-sandbox 与 agent-tools（后者 525 项全绿），该 flaky 疑似并发/计时类既有问题，建议另行排查。
- **O2（依赖说明，非缺陷）**：`echo "$(rm -rf dist)"`（命令替换内相对路径）→ Allowed，符合任务书"相对路径仍 Allowed"声称；但该形态实际会执行 `rm -rf dist`，门禁层刻意放行，依赖后续工作区约束层/命令面拦截。验收口径为门禁层，未验证命令面兜底。

## 6. 附件

- 攻击工程：`%TEMP%\opencode\ac01-attack`（独立 bin crate，path 依赖 conex-sandbox；不提交仓库）
- RED 验证 worktree：`%TEMP%\opencode\red-check`（已移除）
- 相关实现：crates/conex-sandbox/src/semantics.rs（拆段 :173 / 包裹提取 :254 / 深度上限 :97）、lib.rs:76（check_command）、agent-tools/src/tools/shell.rs:1523（端到端接线测试）
