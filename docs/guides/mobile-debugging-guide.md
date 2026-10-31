# 移动端真机调试与运行标准指南（AI 协同与开发者手册）

> 本文档为 Conex / Crish 移动端（`apps/crish-mobile`，React Native 0.86 / Expo SDK 57 / TurboModule）的**真机编译、安装、调试与故障排除标准操作手册（SOP）**。
> 专为接手项目的 AI 智能体与人类开发者编写，涵盖环境准备、华为/鸿蒙真机避坑、Metro 双栈陷阱、原生编译、生命周期命令与视觉验收闭环。

---

## 1. 核心技术栈与架构概况

- **框架版本**：React Native 0.86.0 + Expo SDK 57 + React 19（Hermes 引擎 + TurboModule 原生新架构）。
- **原生层工程**：`apps/crish-mobile/android`（Gradle 9.0.0 + Android SDK Platform 36）。
- **前端代码目录**：`apps/crish-mobile/src` 与 Expo Router 目录 `apps/crish-mobile/app`。
- **通信与后端网关**：
  - 账号中心：`https://auth.flowbit.me`（Fastify 统一鉴权入口）。
  - 中继网络：`https://proxy.flowbit.me:8443`（WSS 双端信令中继）。
  - 本地配对：TLS WebSocket 4000/4001（局域网局域发现与握手）。

---

## 2. 宿主机环境与工具链依赖

在执行任何构建与调试前，必须核查并调配以下系统环境变量（尤其是 Windows 机器）：

### 2.1 Java 17+ 强制要求（重大陷阱）

React Native 0.86 与 Gradle 9+ **最低要求 Java 17**。Windows 系统环境变量 `PATH` 常残留旧版 JRE 1.8（如 `C:\Program Files\Java\jre1.8.0_491`），若直接运行 `gradlew` 会立即抛出 JVM 版本不兼容错误。

**解决方案（PowerShell 会话内动态注入）**：
```powershell
# 宿主机已安装 Amazon Corretto JDK 17
$env:JAVA_HOME = "C:\Program Files\Amazon Corretto\jdk17.0.21_0"
$env:PATH = "C:\Program Files\Amazon Corretto\jdk17.0.21_0\bin;" + $env:PATH

# 验证版本
java -version
# 期望输出：openjdk version "17.0.10" 或 "17.0.21"
```

### 2.2 Android SDK 与 ADB 路径

本机 Android Platform Tools 位于系统固定路径：
```powershell
$env:ADB = "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe"
& $env:ADB version
# Android Debug Bridge version 1.0.41
```

### 2.3 终端环境规范

依据项目权威规范 `AGENTS.md`，执行命令一律使用 **PowerShell 7（pwsh）**，避免 Windows PowerShell 5.1 默认 GBK 编码引发的文件乱码与管道截断。

---

## 3. 华为 / 鸿蒙（HarmonyOS）真机连接三道关卡

华为与鸿蒙手机对 USB 调试有特殊安全策略，连接时必须确保逐一解除以下三项限制，否则 `adb devices` 永远为空或报 `unauthorized`：

1. **关卡 1：华为私有 HDB 协议冲突**
   - 现象：插上数据线后电脑自动拉起华为手机助手，占用 USB 通道，ADB 无法探测到设备。
   - 解决：进入手机【设置】->【系统和更新】->【开发人员选项】-> **关闭「允许通过 HDB 连接设备」**。
2. **关卡 2：“仅充电”模式断开 ADB 保护**
   - 现象：插线默认弹窗选了“仅充电”后，系统出于防窃听保护自动切断 ADB 调试接口。
   - 解决：在【开发人员选项】中，**开启「“仅充电”模式下允许 ADB 调试」**。
3. **关卡 3：RSA 计算机指纹信任授权**
   - 现象：`adb devices` 显示设备序列号但状态为 `unauthorized`。
   - 解决：点亮手机屏幕，在弹出的“允许 USB 调试吗？计算机密钥指纹为...”对话框中，勾选**「始终允许这台计算机进行调试」**并点击**「确定」**。

**连接校验命令**：
```powershell
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" devices
```
**正常输出标杆**：
```text
List of devices attached
MDX0220527044325	device
```
（状态必须为 `device`，不能为 `offline` 或 `unauthorized`）。

---

## 4. 原生 APK 编译与安装

当修改了原生配置、AndroidManifest、C++ TurboModule 或升级依赖时，需要重新编译 Debug APK。纯 TypeScript/UI 修改无需重新编译（走 Metro 热加载即可）。

### 4.1 编译 Debug APK

在 `apps/crish-mobile/android` 目录下执行 Gradle 构建任务：
```powershell
pwsh -Command {
    $env:JAVA_HOME = "C:\Program Files\Amazon Corretto\jdk17.0.21_0"
    $env:PATH = "C:\Program Files\Amazon Corretto\jdk17.0.21_0\bin;" + $env:PATH
    cd apps/crish-mobile/android
    .\gradlew assembleDebug
}
```
- **耗时**：全量初次构建约 3-5 分钟；增量构建约 30-50 秒。
- **输出产物路径**：`apps/crish-mobile/android/app/build/outputs/apk/debug/app-debug.apk`。

### 4.2 推送安装到真机

使用带有 `-r`（替换安装）与 `-d`（允许降级）的 ADB 安装命令：
```powershell
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" install -r -d apps/crish-mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
输出 `Success` 即表示安装成功。

---

## 5. Metro Dev Server 与 Windows IPv6 双栈致命陷阱

这是 Windows + Android ADB 调试中最容易导致 AI 陷入死循环的底层缺陷：

### 5.1 陷阱根因分析

1. 若使用 `npx expo start --localhost`，Node.js 在 Windows 上默认优先绑定 IPv6 回环地址 `::1:8081`。
2. 而 ADB 的端口转发机制 `adb reverse tcp:8081 tcp:8081` 仅将手机端 `127.0.0.1:8081`（IPv4）映射到宿主机 IPv4 `127.0.0.1:8081`。
3. 结果：宿主机没有监听 IPv4 的 8081 端口，手机端请求 `http://127.0.0.1:8081/index.bundle` 直接被操作系统立即 Refuse，手机端抛出致命白屏：
   `java.lang.RuntimeException: Unable to load script. Make sure you're running Metro...`。

### 5.2 正确标准作业程序（SOP）

1. **第一步：建立 ADB 端口反向代理**
   ```powershell
   & "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" reverse tcp:8081 tcp:8081
   # 验证映射列表
   & "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" reverse --list
   # 输出：(reverse) tcp:8081 tcp:8081
   ```
2. **第二步：启动 Metro 并强制监听 LAN / 双栈（0.0.0.0）**
   必须使用 `--host lan` 启动：
   ```powershell
   cd apps/crish-mobile
   npx expo start --host lan
   ```
   启动后，Node.js 同时监听 `0.0.0.0:8081`（IPv4 全部网卡）与 `[::]:8081`（IPv6），无论手机走 USB Reverse 还是走局域网 Wi-Fi，均能 100% 连通。

---

## 6. 应用生命周期控制与自动化命令

调试过程中，AI 可以通过 ADB 命令全自动拉起、重载、停止应用：

| 动作 | 完整 ADB 命令 | 说明 |
| :--- | :--- | :--- |
| **拉起应用** | `adb shell am start -n com.crish.mobile/.MainActivity` | 启动主 Activity 进入前台 |
| **强制停止** | `adb shell am force-stop com.crish.mobile` | 彻底杀掉后台进程 |
| **重新加载 JS** | `adb shell input keyevent 82` 随后发送两次 `r` 键 | 唤出 Expo 开发者菜单或触发 Fast Refresh |
| **回车确认** | `adb shell input keyevent 66` | 模拟按键 Enter (KEYCODE_ENTER) |
| **返回键** | `adb shell input keyevent 4` | 模拟系统 Back 键 (KEYCODE_BACK) |

---

## 7. 视觉验收与无头调试工具集（AI 必用）

作为没有物理显示屏的 AI 助理，必须依靠以下命令获得“视觉眼睛”和“输入双手”，形成完整的自检闭环：

### 7.1 截屏验收与视觉回传（获得当前手机屏幕画面）

```powershell
# 1. 在真机上截屏保存到 sdcard
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" shell screencap -p /sdcard/screen_debug.png

# 2. 将截屏拉取到本地工作区
& "C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe" pull /sdcard/screen_debug.png .agent-outputs/screen_debug.png

# 3. 使用 read_file 读取本地 png 图片，直接在上下文中查看手机真实渲染界面
```

### 7.2 模拟触控与文本输入

```powershell
# 模拟点击坐标 (x, y)
& $env:ADB shell input tap 540 1200

# 模拟键入英文或数字文本（注意特殊字符转义）
& $env:ADB shell input text "test_user@example.com"
```

### 7.3 Logcat 实时日志追踪

过滤 React Native 控制台输出及原生 Crash：
```powershell
# 查看 JS 层的 console.log / console.error
& $env:ADB logcat -v time ReactNativeJS:V AndroidRuntime:E *:S

# 过滤指定进程崩溃堆栈
& $env:ADB logcat -b crash -d
```

---

## 8. 云端账号与接口故障排查专栏

### 8.1 鉴权中心架构与接口一览

- 鉴权服务器地址：`https://auth.flowbit.me`。
- **统一邮箱入口**：`POST /api/auth/email/continue`
  - 传参：`{ "email": string }`。
  - 逻辑：服务端自动判定——已注册用户发送登录验证码；未注册用户发送注册验证码。
  - 返回：`{ ok: true, isNewUser: boolean, hasPassword: boolean, expiresIn: 600, resendAfter: 60 }`。
- **统一邮箱确认**：`POST /api/auth/email/continue/confirm`
  - 传参：`{ "email": string, "code": string, "deviceId": string, "deviceName"?: string }`。
  - 老用户直接返回登录凭据；新用户返回 `{ status: "password_required", setupToken: string }` 进入设密步骤。

### 8.2 网络超时与 SMTP 延迟排查

- **现象**：点击“继续”后界面提示“网络请求超时，请稍后重试”或卡在“正在发送…”。
- **原因**：账号中心收到发码请求后，需同步连接上游 SMTP 邮件代理服务器执行 TLS 握手并投递邮件。受跨国链路影响，耗时常在 3-10 秒。
- **守则**：
  1. 移动端 `REQUEST_TIMEOUT_MS` 与桌面端 Reqwest HTTP 客户端超时已统一扩展为 **25 秒**（`accountConstants.ts` 与 `client.rs`），杜绝 10s/12s 误杀。
  2. 捕获异常必须归一化：React Native 的 Abort 会抛出 `Fetch request has been canceled`，已被规范映射为 `timeout` 码而非裸暴露。
  3. 界面必须带有分级提示状态（如 3s 提示“正在连接海外节点”，8s 提示“网络较慢，仍在努力验证”）。

---

## 9. 快速自检清单（Cheatsheet）

- [ ] `$env:JAVA_HOME` 指向 Amazon Corretto JDK 17。
- [ ] 手机关闭 HDB 连接，开启“仅充电允许调试”，并在屏幕上授权信任 RSA。
- [ ] `adb devices` 输出设备状态为 `device`。
- [ ] `adb reverse tcp:8081 tcp:8081` 端口映射已就绪。
- [ ] Metro 以 `npx expo start --host lan` 启动，监听 `0.0.0.0:8081`。
- [ ] 截屏拉取确认首屏与组件渲染正常，无红屏 RedBox 阻断。
