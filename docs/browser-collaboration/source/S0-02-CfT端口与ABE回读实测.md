# S0-02 CfT 端口与 ABE 回读实测

- 日期：2026-08-09
- 角色：S0 spike 验证 Agent（S0-B：CfT 可用性 / 随机端口 / App-Bound 回读实证）
- 实验目录：`C:\Users\orange\AppData\Local\Temp\opencode\s0-browser\`（脚本留存：cdp.mjs / extract-key.cjs / decrypt-all.cjs / inspect-db.cjs，均不入库）
- 范围：全部使用自行创建的空 profile + 测试 cookie，未读取/复制任何用户真实 profile

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11（win32） |
| Shell | PowerShell 5.1 |
| Node | v24.11.0（自带全局 WebSocket，CDP 走 Node 路径） |
| 系统 Chrome | 151.0.7922.72（C:\Program Files\Google\Chrome\Application\chrome.exe） |
| 系统 Edge | 147.0.3912.72（C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe） |
| CfT | 151.0.7922.77（自行下载） |
| 网络工具 | curl.exe / tar.exe 可用 |

## 2. 逐项实测结果

### 2.1 CfT 可用性（P0-5）——✅ 可用

- 来源：`https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`
- stable win64 URL：`https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.77/win64/chrome-win64.zip`
- 下载：**191.8 MB / 36.8 秒**（curl，EXIT=0）；解压：tar 1.9 秒
- CfT chrome.exe 文件版本：**151.0.7922.77**（与系统 Chrome 151.0.7922.72 同大版本，属同家族）

### 2.2 随机端口 + DevToolsActivePort 闭环（P0-3）——✅ 成立

- 启动参数：`--remote-debugging-port=0 --user-data-dir=<dir> --remote-allow-origins=*`（fresh profile）
- 轮询 `<user-data-dir>/DevToolsActivePort`（50ms 间隔）：**首轮即读到，耗时 1301 ms**（覆盖浏览器冷启动）
- 文件内容格式（2 行，纯文本）：

```
38689
/devtools/browser/ba90110e-33a1-4569-9dd1-5437b8f729b0
```

- 以 `ws://127.0.0.1:38689/devtools/browser/<guid>` 连接后 `Browser.getVersion` 成功返回：

```json
{"protocolVersion":"1.3","product":"Chrome/151.0.7922.77","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/151.0.0.0 Safari/537.36","jsVersion":"15.1.206.10"}
```

- 结论：随机端口 + DevToolsActivePort 文件是可靠的启动握手通道（1.3s 级）；端口为 0 时由 Chrome 自行挑选，文件先行写入、WS 随后可用，需以"读到文件→尝试连接"做闭环而非仅凭文件存在。

### 2.3 Chrome 版本与 App-Bound 预判（P0-4 前置）——⚠️ 预判被实证否定

- 系统 Chrome **151.0.7922.72 ≥ 127**、Edge 147 ≥ 127，按任务预判"ABE 启用、不同 exe 读 cookie 应失败"。
- **实测证据显示本机 cookie 加密并未绑定 exe 家族**：
  1. Local State `os_crypt` 仅有 `encrypted_key`（DPAPI 包裹），**无 `app_bound_encrypted_key`**；
  2. 注册表无任何 `AppBound` 键（HKCU/HKLM 均 0 匹配）；
  3. HKLM/HKCU 策略注册表均无 `AppBoundEncryptionEnabled` 值（非策略禁用）；
  4. Cookies DB 中 cookie 值为 `v10` ASCII 前缀格式（`76 31 30`），但**用 `encrypted_key`（DPAPI → 32 字节 AES-256 用户密钥）直接 AES-GCM 解密成功**，明文尾部即测试值 `value1/value2/value3`（每 cookie 前置 32 字节信封 + `\t` + 明文值）。
- 解释：该环境（Chrome 151 / Win11）下 cookie 密文实际只受**"Windows 用户级"DPAPI 密钥**保护；`v10` 格式前缀已不代表"app-bound 绑定 exe"。设计假设"Chrome ≥127 ⇒ 复制 profile 后由不同 exe 读取 cookie 必然解密失败"**在本机不成立**。

### 2.4 profile 复制回读最小实验（P0-4）——❌ 无法区分 exe 家族

流程：系统 Chrome 以空 profile 启动 → CDP `Network.setCookies` 写入 3 个测试 cookie（`test1=value1`、`test2=value2`、`test3=value3`，域 .example.com / sub.example.com）→ 内存回读确认写入 → `Browser.close` 正常退出 → Cookies DB 位于 `<profile>/Default/Network/Cookies`（新版布局，无 Default/Cookies）→ 复制整个 profile（含 Local State，跳过锁/DevToolsActivePort/Crashpad）到 3 个目录 → 分别用不同 exe 启动 `--user-data-dir=复制目录` → CDP `Storage.getCookies` 回读。

| 场景 | 写入 exe | 读取 exe | 关系 | 回读结果 |
|---|---|---|---|---|
| 基线 | 系统 Chrome | 系统 Chrome（复制后） | 同 exe | ✅ 3/3，值正确 |
| A | 系统 Chrome | CfT 151.0.7922.77 | 同家族、不同安装 | ✅ 3/3，值正确 |
| B | 系统 Chrome | Edge 147.0.3912.72 | 跨家族 | ✅ 3/3，值正确 |

- 场景 B 与"ABE 生效则失败"的预判**相反**：Edge 完整读出了 Chrome 写入的 cookie 值与域。与 2.3 的密钥证据一致（仅按用户加密）。
- 推论：在本机，"复制迁移回读校验"机制**无法**通过"另一 exe 读取 cookie 失败"来判定 profile 是否被复制迁移——任何同用户 exe（含 Edge）都能解密。

### 2.5 崩溃重启最小验证（加分项）——✅ 闭环成立，附一个陷阱

- 启动 → 端口 57346，连接 OK → 强杀进程 → 旧端口 + 旧 ws_path 连接失败（预期）→ 重启 → 新端口 2440、新 ws_path GUID，连接 OK。
- **陷阱**：强杀后 `<user-data-dir>/DevToolsActivePort` **残留陈旧内容**（进程未删除）。若直接按文件重连，会读到旧 port/旧 GUID 而连接失败；实测二次启动若先删陈旧文件再轮询，即可稳定取得新端口。实现层必须做"文件 mtime/内容变化 + 连接成功"双重校验，或在启动前删除该文件。

## 3. 结论

| 编号 | 假设 | 结论 |
|---|---|---|
| P0-3 | 随机端口 + DevToolsActivePort 闭环可靠 | ✅ 成立：1.3s 级拿到端口，文件 2 行格式稳定，WS 可验证 |
| P0-4 | "复制 profile 后由不同 exe 读取 cookie 解密失败"可作迁移校验 | ❌ 本机不成立：同家族与跨家族（含 Edge）均回读成功；cookie 仅按 Windows 用户加密 |
| P0-5 | CfT 可用（last-known-good 下载） | ✅ 成立：151.0.7922.77 下载/解压/启动/CDP 全链路通过 |

## 4. 风险与建议

- **回读校验不能作为"复制迁移检测"的充分判据**：本机实测所有 exe（含 Edge）都能读回。该机制的成立依赖 ABE 对 cookie 值生效（如 2025 年 Chrome 127 时代的 v10 app-bound 行为）；2026 年 Chrome 151 实测已不成立。若产品以"回读失败"判定复制浏览器，会产生误判（把正常浏览器判为复制）或漏判（复制也能读回）。
- **可行的替代/增强方向**（供 S0 决策）：a) 校验 Local State 中 `app_bound_encrypted_key` 是否存在，仅当存在时回读校验才有意义；b) 改用"安装目录内嵌凭据/签名"而非 cookie 解密作为家族指纹；c) 若必须用 cookie 校验，至少把"写入→跨 exe 读回"做成对同一 exe 也验证的差分测试（基线 A 本身就是正面例证）。
- **实现层注意**：DevToolsActivePort 在进程被杀后残留，端口可能复用但 ws GUID 必变；重启接入前须删除陈旧文件或校验内容变化，避免"假握手成功/假失败"。
- **跨机器迁移**未实测（单机限制）：若复制到另一台机器，DPAPI 用户密钥失效，同 exe 也会解密失败——因此"回读失败"在本方案下只能证明"非本用户/本机写入"，不能证明"非本家族浏览器"。
- 本次结论基于单机（本机）实测，ABE 行为受版本演进影响大，若目标环境 Chrome 版本不同（<132 或 >151），建议在目标版本上重跑 2.3/2.4 最小实验确认。
