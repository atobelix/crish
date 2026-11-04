# Crish 移动端真机冒烟（Maestro E2E）

流程级自动化验收：用 Maestro 在**真机 release 包**上跑四条英雄流，专防单测全盲的
缺陷类别（键盘避让 / worklet 运行时 / 手势）。立项依据：工程健康审计 H-2
（`~/workspace/crish-audit/工程健康审计-指南对照.md`）——152 套 jest 全绿曾漏掉
真机必崩的 Sheet worklet P0，这类问题只有真机流程能拦。

## 工具与安装（版本锁定）

- **Maestro CLI `cli-2.12.1`**（2026-11-02 锁定；升级时改本节记录并全流回归）。
  - 官方分发：GitHub `mobile-dev-inc/Maestro` releases 的 `maestro.zip`
    （SHA256 以同版 `checksums_sha256.txt` 校验，安装时已核对一致）。
  - 安装位置（用户级，不进仓库依赖）：`%USERPROFILE%\.maestro\maestro\`
    ，可执行文件在 `bin\maestro.bat`。注意本机 Administrator 的真实
    USERPROFILE 是 `C:\Users\administrator.DESKTOP-J31MN6T`（不是
    `C:\Users\Administrator`，往字面路径装会落进临时配置目录、会话结束即失）。
    下载原件留在 `C:\Users\Administrator\.maestro-install\`（仅 zip 留存）。
  - **orange 用户副本（2026-11-02 收尾轮补装）**：同一 2.12.1 整目录复制到
    `C:\Users\orange\.maestro\maestro\`（`bin\maestro.bat`），已在 orange
    交互会话中实测 `maestro --version` → `2.12.1`、退出码 0。本机跑流走
    **orange 交互通道**（见下「跑法」）：Administrator 在本机没有交互登录
    会话，以它为主体的计划任务只会注册、永不启动（LastTaskResult 267011
    = 从未运行）；adb 的 5037 server 为各上下文共用，orange 客户端连接
    同样是已授权状态（实测 `adb devices` 为 device）。
  - 跑流时建议带 `MAESTRO_CLI_NO_ANALYTICS=1` 关掉匿名分析提示噪音。
  - 前置：Java 17+（本机 Amazon Corretto 17，`JAVA_HOME` 指向它）、
    Android SDK platform-tools（`ANDROID_HOME=C:\Users\orange\AppData\Local\Android\Sdk`）。
  - 重装/升级：下载新版 zip → 校验 SHA256 → 解压覆盖 `~\.maestro\maestro\` →
    `maestro --version` 核对 → 更新本节版本号。
- 流文件：本目录 `flows/*.yaml`，纯 YAML、无凭据（供应商 key 只在设备
  SecureStore，流不读取不回显）。

## 跑法

设备：验收机 Huawei ELS-AN00（Android 12）USB 连接，**屏幕保持解锁亮屏**
（Maestro 驱动经 adb 注入，锁屏/熄屏会失败）。App 须为当前工作区构建的
arm64 release 包且处于**已登录态**（流内不做登录）。

设备侧必备人工步（2026-11-02 实测）：本机 EMUI 对 USB 安装有确认门——
`adb install` / `pm install` 会一直等到用户在手机上点确认为止（安装界面
是安全表面，远程截屏为黑帧；此前装崩溃修复包时亦是用户点确认后才成）。
跑流前：① 解锁亮屏（可用 `adb shell svc power stayon true` 设插电常亮，
验完改回 `false`）；② 装 APK 时在手机上点安装确认；③ 首次跑 Maestro 时
它要装驱动 APK，同样需在手机上点一次确认。另外本机 adb server 会被其它
进程/会话反复重启：短命令靠自动拉起无碍，但 Maestro 长会话与流式安装易
被打断——装包优先用 `adb push` 到 `/data/local/tmp` 后 `pm install -r`，
比流式 `adb install` 更抗抖。

```powershell
# 在 PC 上（Administrator 会话，adb 授权在此上下文）
$env:JAVA_HOME = 'C:\Program Files\Amazon Corretto\jdk17.0.21_0'
$env:ANDROID_HOME = 'C:\Users\orange\AppData\Local\Android\Sdk'
$env:PATH = "$env:PATH;$env:ANDROID_HOME\platform-tools;$env:USERPROFILE\.maestro\maestro\bin"

cd C:\Software\conex\apps\crish-mobile\e2e
maestro test flows\01-cold-start-home.yaml
maestro test flows\02-session-keyboard.yaml
maestro test flows\03-sheet-swipe-close.yaml
maestro test flows\04-local-chat.yaml
# 或整目录：maestro test flows
```

预置的一键连跑（orange 交互会话，计划任务 `MuseE2EFlows` 已注册待启）：
载荷 `C:\Users\Administrator\AppData\Local\Temp\muse-e2e\flowall.ps1`
按 01→04 顺序连跑四条流，日志写同目录 `flows.log`（每条流带 exit 码），
完成标记 `flows-done.txt`；启动器同目录 `flowstart2.ps1`。Maestro 产物
（截图/层级）在 `C:\Users\orange\.maestro\tests\<时间戳>\` 下。
注意首跑会给设备装 Maestro 驱动 APK，EMUI 可能再弹一次安装确认，需人工点。

构建被测包（orange 交互会话，仓库根外用计划任务跑亦可）：

```cmd
cd C:\Software\conex\apps\crish-mobile\android
gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app\build\outputs\apk\release\app-release.apk
```

注：EMUI 对 `adb install` 可能弹设备端确认，未确认会以
`INSTALL_FAILED_ABORTED: User rejected permissions` 失败——请在设备上点允许，
不要反复重试。

## 四条流与预期

| 流 | 守什么 | 预期 |
|---|---|---|
| 01-cold-start-home | 冷启动不崩、登录态保持、主页首帧 | 绿 |
| 02-session-keyboard | 会话页键盘弹起后输入框仍可见（避让回归）；桌面离线时降级为断线条存证 | 绿（离线降级亦算过） |
| 03-sheet-swipe-close | Sheet 下滑关闭手势契约 | Sheet 拖拽关闭（审计 D1）已在手感批次落地到工作区（未提交）；须以包含该批次的新包验证转绿，旧包上仍为红。**不得**改成点遮罩关闭凑绿 |
| 04-local-chat | 本地链：新建线程→发送→流式回复；未配置供应商时断言诚实报错 | 绿（两种终态皆可） |

流 04 会在设备上留下一条标题为「E2E冒烟：本地对话链路测试」的本地线程，
是冒烟产物，可在本地对话列表页随手删除（流内不删：线程行 testID 含动态 id）。

## 失败怎么看

- Maestro 失败会在控制台指出失败的命令与期望；产物（截图、层级转储）在
  `%USERPROFILE%\.maestro\tests\<时间戳>\` 下，流内的 `takeScreenshot` 帧也在其中。
- 先分三类归属再动手：
  1. **环境问题**：设备锁屏/断连、App 被登出（落到欢迎页）、EMUI 拦装、
     Maestro 驱动未装上（首次运行会自动装驱动 App，同样可能被 EMUI 拦）。
  2. **流脚本问题**：testID 改名/界面结构调整后定位失效——先用
     `maestro hierarchy` 对照真机当前层级，再改流，不要改产品迁就流
     （产品侧仅允许补 testID，不动逻辑）。
  3. **产品缺陷**：流与环境都无误仍失败——这正是本基建要抓的，如实登记
     缺陷并保持流红，不要改流绕过（如 03 之于 D1）。
- 元素定位只许用 testID（产品代码已全量铺设）；万不得已才用文本，
  且文本断言只用于用户自己刚发送的内容这类确定性文案。

## 本轮实跑结果（2026-11-02 收尾轮）

- **流锚点核对**：四条流引用的 testID 已逐个对当前产品代码核完，全部存在，
  无需补 testID、无需改流。注意 `local-chat-composer-send` 不是字面量，
  是 Composer 的模板派生（`src/presentation/ui/Composer.tsx:362`
  `${testID}-send`），运行时存在；流 02 的 `chat-item-.*` 会同时匹配行内
  徽标（chat-item-running / chat-item-pending），但二者在行 Pressable
  内部，点中仍触发整行打开，可用。
- **构建**：当前工作区 arm64 release 构建成功（2m44s），APK
  `android\app\build\outputs\apk\release\app-release.apk`，91,062,425 字节，
  2026-11-02 05:26 产出（任务 `MuseE2EBuild2`，已注销）。
- **装机**：APK 已 push 至设备 `/data/local/tmp/crish-e2e.apk`；
  `pm install -r` 已发起并**阻塞在 EMUI 设备端安装确认**（adb 进程存活
  在跑、截屏为安全表面黑帧/0 字节、`lastUpdateTime` 未变，三证齐全）。
  在手机上点一次「允许安装」即自动完成，后续跑流用上面的预置连跑即可。
  设备上尚无 Maestro 驱动包，首跑装驱动可能再弹一次确认。
- **四条流**：因装机未落地，本轮**未跑**（不是失败，是前置未完成）；
  设备 `svc power stayon true` 已设（插电常亮），验收结束后改回 `false`。

本轮踩到的环境陷阱（后人避坑）：

1. 上一任 04:21 发起的 `adb install` 僵尸进程一直攥着 APK 文件句柄，
   使后续构建在 `:app:packageRelease` 连续两次失败（Unable to delete
   app-release.apk）。装机改走 `adb push` + `pm install -r`（README 既有
   口径）之外，还要先查有没有残留 adb 进程占着产物。
2. PowerShell wrapper 用 `*>` 重定向包裹构建时，gradle daemon 继承管道
   句柄会让 wrapper 永不退出、完成标记永不落盘——载荷应自写日志文件
   （cmd 级重定向）并自写完成标记，不要依赖外层管道重定向。
3. 以 Administrator 为主体的计划任务在本机只注册不运行（无交互会话）；
   一切长任务走 orange 交互通道。

## 纳入验收的建议

- 每次移动端收口/回归轮：先构建装机，再按 01→04 顺序整跑一遍，
  四条流的结果（绿/红 + 红的归属）进收口报告；03 在 D1 落地前为已知红，
  其余三条必须全绿才算冒烟通过。
- 新增高频面（键盘/Sheet/手势/worklet 相关改动）时，优先给对应流加断言，
  而不是新开流；流总数保持个位数、每条都跑得快。
- 后续可把整跑包成一个计划任务脚本（构建→装机→四流→汇总），
  但在 EMUI 拦装需人工点确认的现状下，装机环节保留人工在场。
