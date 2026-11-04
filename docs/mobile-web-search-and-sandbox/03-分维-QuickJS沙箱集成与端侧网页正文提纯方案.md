# 03-分维-QuickJS沙箱集成与端侧网页正文提纯方案

> **文档定位**：移动端（`apps/crish-mobile`）本地运行时沙箱与网页提取架构设计方案（分维 03 唯一权威方案）。  
> **设计基准**：严格遵循仓库协作指令 [AGENTS.md](file:///c:/Software/conex/AGENTS.md) 与逻辑规划反退避原则 [.agents/LOGIC_PLAN_NO_RETREAT.md](file:///c:/Software/conex/.agents/LOGIC_PLAN_NO_RETREAT.md)；纯逻辑规划，不设工期人天，不设优先级裁剪；代码证据级真实可靠。  
> **核心使命**：落地用户核心裁决——引入 **QuickJS 原生隔离沙箱**（`crish-js-sandbox`），在移动端实现高安全、低内存、零 UI 掉帧的端侧 HTTP 安全下载与 HTML 正文提纯流水线（`LinkeDOM` + `@mozilla/readability` + `Turndown` + `GFM Tables`）。

---

## 1. 架构背景与核心决策

### 1.1 背景与用户核心裁决
在移动端多级联网搜索与端侧智能体架构中，第 4 级能力为**端侧网页正文直接提取（`web_fetch`）**与**端侧通用脚本安全执行**。用户明确裁决：“**quickjs我们也是可以装上的，让ai可以更多一些工具调用的能力吧**”。

移动端在此场景面临三大致命架构陷阱：
1. **主 JS 线程严重卡顿与掉帧**：React Native 运行在单主 JS 引擎（Hermes）上。若直接在 Hermes 线程内解析多达 1MB 的原始 HTML 并构建 DOM 树，会占用主线程高达数百毫秒甚至秒级 CPU 时间，导致 UI 完全冻结、手势失灵、帧率骤降至个位数；
2. **不可信代码注入与环境污染**：被抓取的第三方网页可能包含对抗性 HTML 片段、恶意脚本或注入攻击。若在 Hermes 全局执行上下文中解析，可能污染全局原型链，甚至导致 App 崩溃；
3. **隐藏 WebView 的内存膨胀与 OOM 崩溃**：若通过移动端无头/隐藏 `react-native-webview` 解析网页，每个 WebView 实例均需初始化完整 WebKit/Blink 进程，瞬间占用 120MB~200MB+ 物理内存。在内存吃紧的 Android 设备上极易触发系统 Low Memory Killer（LMK）导致宿主 App 被直接闪退杀死。

### 1.2 架构决策矩阵

| 评估维度 | 方案 A：React Native Hermes 主线程内直接解析 | 方案 B：后台隐藏 WebView 加载提纯 | 方案 C（本方案）：QuickJS 独立原生 Worker 线程沙箱 |
| :--- | :--- | :--- | :--- |
| **UI 线程影响** | 极差（HTML 解析占用 Hermes 线程，手势与界面卡死） | 较好（运行在独立渲染进程，但通信与初始化开销大） | **极佳（完全在原生后台 Worker 线程，零 UI 线程阻断）** |
| **内存开销** | 较差（大型 DOM 树累加在 Hermes 堆，无法硬限制） | 极差（单 WebView 实例占用 120MB~200MB+ 物理内存） | **极优（单沙箱堆严格限制 64MB，进程增量 < 8MB）** |
| **安全隔离度** | 差（共享 Hermes 全局原型链，存在原型污染与宿主句柄泄露风险） | 较好（WebKit 沙箱，但存在跨域与 WebView 通信注入风险） | **极佳（零 OS/STD 模块暴露，零网络/FS 句柄，标准 JS 纯净环境）** |
| **资源刚性熔断** | 无法做到（Hermes 无法主动中断死循环 `while(true)`） | 差（只能粗暴销毁 WebView，易出现白屏与进程残留） | **极优（C 语言 `JS_SetInterruptHandler` 指令级 5,000ms 硬熔断）** |
| **内存溢出保护** | 无法捕获（超出直接导致整个 React Native 宿主崩溃） | 依赖系统 LMK 机制 | **极优（自定义 `JSMallocFunctions` 分配器，超限优雅抛出 catchable OOM）** |

---

## 2. 移动端 QuickJS 沙箱原生模块设计（`crish-js-sandbox`）

### 2.1 参考实现深度证据剖析（`reference/cherry-studio-app`）
经深入审查 `reference/cherry-studio-app/modules/js-sandbox/`，其生产级架构已被充分验证：
1. **源码组成**：
   - 核心引擎：`vendor/quickjs-ng/quickjs-amalgam.c` 与 `quickjs.h`，采用 QuickJS-NG（Next Generation）的单文件整合（Amalgamation）C 库，完整支持 ES2023 最新语法特性；
   - C++ 隔离层：`cpp/JsSandbox.h` 与 `cpp/JsSandbox.cpp`，实现基于 `JSMallocFunctions` 的自定义内存池、7 MiB 原生栈保护、50 微任务轮询中断机制与 `console` 劫持；
   - Android 桥接：`android/src/main/cpp/JsSandboxJni.cpp`（以 `jbyteArray` 规避 JNI Modified UTF-8 编码截断）+ `JsSandboxModule.kt`（专有 8MB 栈大小独立线程）；
   - iOS 桥接：`ios/JsSandboxRunner.mm`（Objective-C++）+ `JsSandboxModule.swift`（专有 8MB 栈大小 `Thread`）。
2. **性能与稳定性证据**：
   - CMake 与 Xcode 编译配置中强制指定 `-O2` 优化（即使 Debug 模式亦如此）。若使用 `-O0`，QuickJS 运行速度降低约 9 倍，且函数调用帧增大导致调用栈深度从约 7,000 层断崖式跌落至约 800 层。

### 2.2 Expo Native Module 接口契约规范
在 `apps/crish-mobile/modules/` 下新增原生模块 `crish-js-sandbox`，目录结构遵循 Expo Native Module 标准规范：

```
apps/crish-mobile/modules/crish-js-sandbox/
├── expo-module.config.json
├── package.json
├── index.ts
├── cpp/
│   ├── JsSandbox.h
│   ├── JsSandbox.cpp
│   └── QuickJs.c
├── vendor/
│   └── quickjs-ng/
│       ├── quickjs.h
│       └── quickjs-amalgam.c
├── android/
│   ├── build.gradle
│   ├── CMakeLists.txt
│   ├── proguard-rules.pro
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── cpp/
│       │   └── JsSandboxJni.cpp
│       └── java/expo/modules/jssandbox/
│           └── JsSandboxModule.kt
└── ios/
    ├── JsSandbox.podspec
    ├── JsSandboxModule.swift
    ├── JsSandboxRunner.h
    └── JsSandboxRunner.mm
```

#### TypeScript 契约定义（`index.ts`）
```ts
export type JsSandboxLimits = {
  /** 单次执行硬超时时间（毫秒），0 代表无超时限制，默认 5000ms */
  timeoutMs: number;
  /** QuickJS 运行时全局堆内存硬上限（字节），默认 64 * 1024 * 1024 (64 MiB) */
  memoryBytes: number;
  /** 序列化返回结果的最大 UTF-8 字节上限，默认 256 * 1024 (256 KiB) */
  maxResultBytes: number;
  /** 捕获 console 日志的最大 UTF-8 字节上限，默认 4 * 1024 (4 KiB) */
  maxLogBytes: number;
};

export type JsSandboxSuccessOutcome = {
  status: 'ok';
  result?: string;
  resultTruncated?: boolean;
  logs: string;
  logsTruncated: boolean;
  durationMs: number;
};

export type JsSandboxErrorKind =
  | 'timeout'
  | 'memory'
  | 'exception'
  | 'syntax'
  | 'cancelled'
  | 'internal'
  | 'unsettled';

export type JsSandboxErrorOutcome = {
  status: 'error';
  kind: JsSandboxErrorKind;
  message: string;
  logs: string;
  logsTruncated: boolean;
  durationMs: number;
};

export type JsSandboxOutcome = JsSandboxSuccessOutcome | JsSandboxErrorOutcome;

export type EvaluateOptions = {
  code: string;
  limits?: Partial<JsSandboxLimits>;
  signal?: AbortSignal;
  onSettled?: () => void;
};

export interface JsSandboxNativeModule {
  run(runId: string, code: string, limits: JsSandboxLimits): Promise<string>;
  cancel(runId: string): void;
}
```

### 2.3 跨平台 C++ 核心隔离层设计

```
                    ┌────────────────────────────────────────────────────────┐
                    │               原生独立线程 (8 MiB 独立栈空间)          │
                    │                                                        │
                    │   ┌────────────────────────────────────────────────┐   │
                    │   │   JSRuntime (JS_NewRuntime2)                   │   │
                    │   │   ├── 自定义分配器: JSMallocFunctions (Heap)     │   │
                    │   │   │   ├── 严格跟踪 used <= 64 MiB 内存配额       │   │
                    │   │   │   └── 超限优雅返回 nullptr (触发 JS OOM)    │   │
                    │   │   ├── 栈深度门禁: JS_SetMaxStackSize (7 MiB)   │   │
                    │   │   └── 中断钩子: JS_SetInterruptHandler        │   │
                    │   │       ├── 5,000ms 墙上钟硬超时检测              │   │
                    │   │       └── 取消信号 (Cancelled) 指令级轮询       │   │
                    │   └───────────────────────┬────────────────────────┘   │
                    │                           │                            │
                    │   ┌───────────────────────▼────────────────────────┐   │
                    │   │   JSContext (JS_NewContext)                    │   │
                    │   │   ├── 零宿主 API: 剔除 os、std、网络、文件句柄 │   │
                    │   │   ├── Prelude: 安全劫持 console / 堆栈清洗     │   │
                    │   │   └── 异步包装: (async function() { ... })()   │   │
                    │   │       └── drainJobs: 每 50 微任务轮询中断      │   │
                    │   └────────────────────────────────────────────────┘   │
                    └────────────────────────────────────────────────────────┘
```

#### 2.3.1 自定义内存分配器与堆硬限制（防系统级 OOM）
使用 `JS_NewRuntime2` 替换默认分配器，接入自定义 `JSMallocFunctions`。通过平台原生内存尺寸探测（macOS/iOS `malloc_size`，Linux/Android `malloc_usable_size`）精确追踪堆占用，一旦 `used + requested > limit`，立即返回 `nullptr`，促使 QuickJS 抛出捕获式内存异常，彻底杜绝移动端被系统杀死：

```cpp
struct Heap {
  size_t limit;
  size_t used = 0;
  bool exceeded = false;
};

size_t usableSize(const void *ptr) {
#if defined(__APPLE__)
  return malloc_size(ptr);
#else
  return malloc_usable_size(const_cast<void *>(ptr));
#endif
}

bool admit(Heap &heap, size_t releasing, size_t requested) {
  const size_t base = heap.used - releasing;
  if (base > heap.limit || requested > heap.limit - base) {
    heap.exceeded = true;
    return false;
  }
  return true;
}

void *heapMalloc(void *opaque, size_t size) {
  auto &heap = *static_cast<Heap *>(opaque);
  if (!admit(heap, 0, size)) return nullptr;
  void *ptr = std::malloc(size);
  if (ptr) heap.used += usableSize(ptr);
  return ptr;
}

void heapFree(void *opaque, void *ptr) {
  if (ptr) {
    static_cast<Heap *>(opaque)->used -= usableSize(ptr);
    std::free(ptr);
  }
}
```

#### 2.3.2 原生栈深度防护
QuickJS 采用 C 栈帧映射 JS 函数调用。为防止恶意深度递归打崩线程栈，显式配置 `JS_SetMaxStackSize(rt, 7u << 20)`（7 MiB）。配合宿主平台创建的 8 MiB 物理栈，为 C/C++ 原生代码执行留足 1 MiB 安全余量，杜绝 SIGSEGV 崩溃。

#### 2.3.3 指令级超时中断与微任务排空
注册 `JS_SetInterruptHandler`，在 QuickJS 执行字节码操作码及正则回溯时进行纳秒级时钟比对：
```cpp
int interruptHandler(JSRuntime *, void *opaque) {
  auto &session = *static_cast<Session *>(opaque);
  if (!session.interrupt) {
    if (session.state.cancelled) {
      session.interrupt = "cancelled";
    } else if (session.deadline && Clock::now() >= *session.deadline) {
      session.interrupt = "timeout";
    }
  }
  return session.interrupt ? 1 : 0;
}
```
对于连续链式 Promise 微任务（可能绕过操作码轮询），实现 `drainJobs` 循环并在每执行 50 个微任务时强制校验中断：
```cpp
void drainJobs(JSRuntime *rt, Session &session) {
  size_t jobs = 0;
  while (!session.interrupt && JS_IsJobPending(rt)) {
    JSContext *jobContext = nullptr;
    if (JS_ExecutePendingJob(rt, &jobContext) < 0 && jobContext) {
      JS_FreeValue(jobContext, JS_GetException(jobContext));
    }
    if (++jobs % 50 == 0 && interruptHandler(rt, &session)) break;
  }
}
```

#### 2.3.4 全局隔离与安全 Prelude
编译时不链接 QuickJS 的 `quickjs-libc`（即不提供 `std` 与 `os` 模块），全局对象仅包含标准 ECMAScript 内置对象。
在用户代码注入前，执行专有 `kPrelude` 脚本：
1. 劫持 `globalThis.console`，重定向至 C++ `hostLog`，并按 `maxLogBytes`（4KB）做 UTF-8 字符边界截断；
2. 过滤错误调用栈，屏蔽 `<eval>` 和宿主胶水帧，最多保留 8 帧纯净脚本堆栈；
3. 将执行结果通过 `JSON.stringify` 结合自定义 replacer（转换 BigInt、Map、Set）序列化为安全字符串。

### 2.4 Android 端 JNI 与 Kotlin 线程隔离实现

#### 2.4.1 独立 8MB 原生栈线程
在 `JsSandboxModule.kt` 中，严禁使用共享协程池或主线程。每次调用独立启动线程，并指派 8MB 栈空间：
```kotlin
package expo.modules.jssandbox

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

class JsSandboxModule : Module() {
  private val runs = ConcurrentHashMap.newKeySet<String>()

  override fun definition() = ModuleDefinition {
    Name("CrishJsSandbox")

    AsyncFunction("run") { runId: String, code: String, limits: JsSandboxLimitsRecord, promise: Promise ->
      launch(runId, promise) {
        val result = JsSandboxNative.run(
          runId.toByteArray(Charsets.UTF_8),
          code.toByteArray(Charsets.UTF_8),
          limits.timeoutMs,
          limits.memoryBytes,
          limits.maxResultBytes,
          limits.maxLogBytes,
        )
        String(result, Charsets.UTF_8)
      }
    }

    Function("cancel") { runId: String ->
      JsSandboxNative.cancel(runId.toByteArray(Charsets.UTF_8))
    }

    OnDestroy {
      runs.forEach { JsSandboxNative.cancel(it.toByteArray(Charsets.UTF_8)) }
    }
  }

  private fun launch(runId: String, promise: Promise, work: () -> String) {
    runs.add(runId)
    Thread(null, {
      try {
        promise.resolve(work())
      } catch (error: Exception) {
        promise.reject("ERR_CRISH_JS_SANDBOX", error.message, error)
      } finally {
        runs.remove(runId)
      }
    }, "CrishJsSandbox", STACK_SIZE_BYTES).start()
  }

  private companion object {
    const val STACK_SIZE_BYTES = 8L shl 20 // 8 MiB 独立物理栈
  }
}
```

#### 2.4.2 规避 JNI Modified UTF-8 陷阱
标准 JNI 的 `GetStringUTFChars` 返回的是 Modified UTF-8（MUTF-8），对于 U+0000 编码为双字节，对于辅助平面字符（如 Emoji、特殊数学符号等）会拆分为代理对分别编码为 3 字节（共 6 字节），严重破坏网页正文中的多语言字符。
因此，C++ JNI 边界统一使用 `jbyteArray`（纯 UTF-8 字节流）：
```cpp
// JsSandboxJni.cpp
extern "C" JNIEXPORT jbyteArray JNICALL Java_expo_modules_jssandbox_JsSandboxNative_run(
    JNIEnv *env, jclass, jbyteArray runId, jbyteArray code,
    jint timeoutMs, jint memoryBytes, jint maxResultBytes, jint maxLogBytes) {
  const crish::jssandbox::Limits limits{
      static_cast<uint32_t>(timeoutMs),
      static_cast<size_t>(memoryBytes),
      static_cast<size_t>(maxResultBytes),
      static_cast<size_t>(maxLogBytes),
  };
  std::string result = crish::jssandbox::run(fromBytes(env, runId), fromBytes(env, code), limits);
  return toBytes(env, result);
}
```

### 2.5 iOS 端 Objective-C++ 与 Swift 线程隔离实现
在 iOS 端，Swift 无法直接调用 C++ 头文件，通过 Objective-C++ `JsSandboxRunner.mm` 作为中间隔离层，Swift 通过 `Thread` 分配 8MB 栈空间：
```swift
// JsSandboxModule.swift
private func launch(_ runId: String, promise: Promise, work: @escaping () -> String) {
  runLock.lock()
  runs.insert(runId)
  runLock.unlock()
  
  let thread = Thread {
    let result = work()
    self.runLock.lock()
    self.runs.remove(runId)
    self.runLock.unlock()
    promise.resolve(result)
  }
  thread.name = "CrishJsSandbox"
  thread.stackSize = 8 << 20 // 8 MiB 栈空间
  thread.qualityOfService = .userInitiated
  thread.start()
}
```

---

## 3. 安全网页下载传输层（Safe Web Page Downloader）

在发起本地网页提取前，必须经由严密的安全下载传输层获取 HTML 原始内容。该层必须刚性防御 SSRF、DNS 欺骗、协议降级与资源耗尽攻击。

```
[待抓取 URL]
     │
     ▼
[ parsePageUrl 静态门禁 ]
 ├── 协议白名单: 必须是 http: 或 https: (拦截 file:, ftp:, javascript: 等)
 ├── 凭证拦截: 严禁 url.username 或 url.password
 ├── 主机名合法性: 拦截 localhost, *.local, *.internal, 纯数字 IP 伪装
 └── IP 分类拦截: 拦截 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
                  169.254.0.0/16 (链路本地/云元数据), 100.64.0.0/10 (CGNAT),
                  ::1, fc00::/7 (ULA), fe80::/10, ::ffff:0:0/96 (IPv4 映射)
     │
     ▼ (通过)
[ 手动单跳 HTTP 请求 (redirect: manual) ] ── (超时预算: 30,000ms 滑动窗口)
     │
     ├── 收到 301/302/303/307/308 重定向
     │     │
     │     ├── 重定向计数器 >= 5 ────► 拒绝: page_redirect_limit
     │     └── 提取 Location 目标 ───► 重新循环送入 [ parsePageUrl 静态门禁 ]
     │
     └── 收到 200 OK 响应
           │
           ├── Content-Type 门禁: 必须为 text/html, application/xhtml+xml, text/plain 等
           ├── 编码校验: 必须声明为 utf-8 / ascii (不支持非 UTF-8，防解码混淆)
           ├── 尺寸硬限制: 流式检查 <= 1,024 * 1,024 (1 MiB)
           └── UTF-8 严格解码: TextDecoder('utf-8', { fatal: true }) 失败即阻断
```

### 3.1 对齐电脑端 SSRF 防护矩阵（`ip_class.rs` 对齐）
参考本仓电脑端安全实现 `crates/conex-browser-tools/src/gate/ip_class.rs`，在移动端 TypeScript 层构建全谱系 IP 拦截器 `ssrfGuard.ts`：

#### 3.1.1 IPv4 保留段与内网段拦截表
- `0.0.0.0/8`：当前网络；
- `10.0.0.0/8`：私有 A 类网段；
- `100.64.0.0/10`：运营商级 NAT（CGNAT / RFC 6598）；
- `127.0.0.0/8`：回环地址段；
- `169.254.0.0/16`：链路本地地址段（包括 AWS/GCP/阿里云等云元数据地址 `169.254.169.254`）；
- `172.16.0.0/12`：私有 B 类网段（`172.16.0.0` ~ `172.31.255.255`）；
- `192.168.0.0/16`：私有 C 类网段；
- `198.18.0.0/15`：基准测试与网络互联段；
- `224.0.0.0/4`：组播地址段；
- `240.0.0.0/4`：保留/未来使用地址段。

#### 3.1.2 IPv6 保留段与 ULA / 链路本地拦截表
- `::1`：回环地址；
- `fc00::/7`：唯一本地地址（ULA，含 `fd00::/8`）；
- `fe80::/10`：链路本地地址；
- `::ffff:0:0/96`：IPv4 映射地址（必须解包提取 IPv4 部分，重新执行 IPv4 拦截表校验）。

#### 3.1.3 域名与主机名变形防御
- 禁止非标准 IP 表达：如十进制整数表示法（`http://2130706433/` 即 `127.0.0.1`）、八进制表示法（`http://0177.0.0.1/`）、十六进制表示法等；
- 拦截特定主机名后缀：`localhost`、`*.localhost`、`*.local`、`*.internal`、`*.lan`、`*.localdomain`；
- 禁止内联凭据：严格拦截形如 `http://user:password@domain.com` 的凭证格式，防范 URL 混淆钓鱼。

### 3.2 手动重定向追踪与级联防护
标准 `fetch` 的 `redirect: 'follow'` 会静默穿透重定向，易被攻击者利用：攻击者提供公网域名，但在 302 跳转时重定向至内网 `http://192.168.1.1/admin` 或 `http://169.254.169.254/latest/meta-data/`。

**防护规则**：
1. 强制设置 `redirect: 'manual'`；
2. 最多允许 5 跳重定向（`MAX_REDIRECTS = 5`）；
3. 每一跳获取 `Location` 头后，使用 `new URL(location, currentUrl).href` 规范化为绝对地址；
4. **对每一跳的新目标 URL，必须全量重新执行 `parsePageUrl` 与 SSRF 检查**；任何一跳命中私有地址或非法协议，立即硬阻断并报错；
5. 全局设置 30,000ms 倒计时预算，跨重定向递减，防止慢速重定向攻击。

### 3.3 流式体积截断与编码严苛校验
1. **Content-Type 白名单门禁**：
   必须匹配 `text/html`、`application/xhtml+xml`、`text/plain`、`text/markdown`。任何 `application/octet-stream`、图片、视频、PDF、ZIP 等二进制类型，在 Header 解析阶段直接终止连接，不读取 Body。
2. **1MB 物理截断**：
   `MAX_PAGE_BYTES = 1024 * 1024`（1 MiB）。底层网络请求以 ArrayBuffer 读取，字节数一旦超过 1MB 立即抛出 `page_invalid_body` 错误，严禁大文件撑爆内存。
3. **UTF-8 编码严苛校验**：
   - 提取 Content-Type 中的 `charset` 字段，若显式声明且不是 UTF-8、ASCII 或 US-ASCII（例如 GBK、Shift-JIS、EUC-KR 等），立即抛出 `page_charset` 错误，避免字符集转义旁路攻击与乱码；
   - 若 Header 未声明 charset，仅读取前 4,096 字节嗅探 HTML `<meta charset="...">` 声明；
   - 最终使用 `new TextDecoder('utf-8', { fatal: true }).decode(data)` 强制解码，若存在非法 UTF-8 字节序直接报错，拒绝畸形数据。

---

## 4. 沙箱内 HTML 正文提纯与 Markdown 转换流水线

### 4.1 预打包 Vendor 资产架构设计
在 React Native / Metro 打包环境下，若直接在 JS 代码中 `import` 庞大的第三方库（`linkedom`, `@mozilla/readability`, `turndown`）到 Hermes 引擎，不仅会导致应用主 Bundle 体积剧增，而且由于这些库依赖浏览器 DOM 全局对象（`window`, `document`, `Node`），在 Hermes 无 DOM 环境下会直接触发运行时语法错误或未定义错误。

**解决方案**：采用与 Cherry Studio 一致的 **JSON 预打包资产（Vendor Bundled Assets）** 方案。
每个库在构建期预编译为独立纯净的 JS 代码字符串，并封装为 JSON 格式存储于 `apps/crish-mobile/src/services/webSearch/extraction/vendor/`：
- `core-js-bundle.json`：QuickJS 环境下的基础 ES 垫片（约 270KB）；
- `linkedom.json`：超轻量无头 DOM 解析器（约 440KB）；
- `mozilla-readability.json`：Mozilla 官方正文提取算法（约 106KB）；
- `turndown.json`：HTML 到 Markdown 转换引擎（约 27KB）；
- `turndown-plugin-gfm.json`：Turndown 的 GitHub Flavored Markdown 表格扩展插件（约 5.7KB）。

在主工程中，通过标准 JSON 导入即可获得其代码字符串，在需要提纯时将代码动态装配进 QuickJS 沙箱执行：
```ts
import coreJs from './vendor/core-js-bundle.json';
import linkedom from './vendor/linkedom.json';
import readability from './vendor/mozilla-readability.json';
import turndown from './vendor/turndown.json';
import gfm from './vendor/turndown-plugin-gfm.json';
```

### 4.2 提取代码构建机制（`createExtractionCode`）

```
[原始 HTML (<=1MB) + 目标 URL]
       │
       ▼ (安全装配: JSON.stringify 注入，杜绝模板注入)
[QuickJS 沙箱加载 Vendor 代码库]
       │
       ├── 1. core-js-bundle 垫片加载
       ├── 2. linkedom: 挂载 DOMParser，挂载 globalThis.window = { DOMParser }
       ├── 3. CommonJS 包装加载 Mozilla Readability
       └── 4. CommonJS 包装加载 Turndown + GFM 表格插件
       │
       ▼
[LinkeDOM 解析与 DOM 树结构规范化]
       ├── LinkeDOM 不自动补全 html/head/body 标签
       ├── 显式规范化: 确保 root 为 <html>，创建规范 <head> 与 <body>
       ├── 将 BASE/LINK/META/TITLE 归类挂载到 <head>，其余内容挂载到 <body>
       └── 解析 <base href> 并挂载 page.URL / page.documentURI / page.baseURI
       │
       ▼
[Mozilla Readability 正文抽取]
       ├── maxElemsToParse: 20000 (防深度膨胀 DOM 耗尽堆内存)
       ├── serializer: node => node (保留原生 DOM 树，供后续操作)
       └── 判空校验: 若抽取结果为空，触发降级文本提取流程
       │
       ▼
[DOM 深度安全清洗]
       ├── 彻底移除: script, style, iframe, object, embed, form
       ├── 属性扫描: 正则 /^on/i 剔除全部 on* 事件处理属性
       └── URL 协议过滤: a[href] 与 img[src] 必须为 http: / https: / #，剔除 javascript: 等
       │
       ▼
[LinkeDOM 表格 rows 补丁与空表剪枝 (关键架构适配)]
       ├── LinkeDOM 缺失 HTMLTableElement.rows 原生属性
       ├── 注入属性: 为所有 table 注入直接子 tr 集合的 rows 属性
       ├── 劫持 cloneNode: Turndown 内部会克隆节点，劫持并为克隆树补充 table.rows 注入
       └── 剪枝: 若 table.rows.length === 0，直接移除该空表格
       │
       ▼
[Turndown GFM 转换与预算截断]
       ├── headingStyle: 'atx', codeBlockStyle: 'fenced'
       ├── 转换输出纯净 Markdown 文本
       └── 字符硬上限: 截断至 MAX_EXTRACTED_CONTENT_CHARACTERS (24,000 字符)
       │
       ▼
[返回标准结果 JSON] ──► { status: 'ok', title: '...', content: '...', truncated: false }
```

#### 4.2.1 安全 JSON 数据注入
严禁直接使用 JS 模板字符串拼接不可信 HTML（如 `const html = "${rawHtml}";`），因为攻击者可通过包含 `*/`、反引号、未闭合脚本等特殊语法破坏沙箱解析或注入任意 JS 代码。
所有待解析的数据必须通过 `JSON.stringify` 转化为安全 JSON 字符串常量：
```ts
const inputLiteral = JSON.stringify({ html, url });
// 沙箱内部安全解析:
// const input = ${inputLiteral};
// const page = new DOMParser().parseFromString(input.html, 'text/html');
```

#### 4.2.2 LinkeDOM 规范化与 DOM 补丁
真实世界的 HTML 经常缺失标准文档骨架。LinkeDOM 是轻量级无头 DOM，不会像 Chrome/WebKit 浏览器那样自动补全 `<html>`、`<head>`、`<body>`。若直接交给 Readability，其内部的 `doc.body` getter 会在首个节点内自动创建空 body，导致正文解析丢失或崩溃。
因此在提取前必须执行结构规范化：
```javascript
let root = page.documentElement;
if (root?.tagName !== 'HTML') {
  root = page.createElement('html');
  Array.from(page.childNodes).forEach(node => {
    if (node.nodeType !== 10) root.appendChild(node);
  });
  page.appendChild(root);
}
const head = Array.from(root.children).find(node => node.tagName === 'HEAD') || page.createElement('head');
const body = Array.from(root.children).find(node => node.tagName === 'BODY') || page.createElement('body');
root.prepend(head);
root.appendChild(body);
Array.from(root.childNodes).forEach(node => {
  if (node === head || node === body) return;
  const parent = ['BASE', 'LINK', 'META', 'TITLE'].includes(node.nodeName) ? head : body;
  parent.appendChild(node);
});
```

#### 4.2.3 表格 `table.rows` 缺失与 Turndown `cloneNode` 深度适配（核心深水区）
`turndown-plugin-gfm` 依赖 W3C 标准 `table.rows` 集合判断表头与单元格对齐。由于 LinkeDOM 缺失此属性，直接转换会抛出 `TypeError: Cannot read properties of undefined (reading 'length')`。
此外，Turndown 在内部执行 `contentNode.cloneNode(true)`。普通的属性赋值在克隆后会丢失。
因此，必须在原始节点与克隆机制上进行双重注入：
```javascript
// 1. 原始 table 注入 rows 属性（排查并排除嵌套 table 的 tr）
contentNode.querySelectorAll('table').forEach(table => {
  const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table);
  Object.defineProperty(table, 'rows', { value: rows });
  if (rows.length === 0) table.remove(); // 移除没有行的空表
});

// 2. 劫持 cloneNode 保证克隆树依然具备 rows 属性
const originalCloneNode = contentNode.cloneNode.bind(contentNode);
contentNode.cloneNode = function(deep) {
  const clone = originalCloneNode(deep);
  clone.querySelectorAll('table').forEach(table => {
    Object.defineProperty(table, 'rows', {
      value: Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table),
    });
  });
  return clone;
};
```

---

## 5. 单并发插槽与 Token 预算裁剪（Concurrency & Token Budgeting）

### 5.1 移动端单并发插槽控制（`ConcurrencySlot(1)`）
移动端物理内存资源极度受限（尤其在 4GB~6GB 运行内存的中低端 Android 设备上）。若 Agent 一次性下发 5 个 URL 抓取任务并并发执行：
- 5 个 1MB HTML 字符串 ≈ 10MB；
- 5 个 LinkeDOM AST 树在 QuickJS 堆内展开 ≈ 5 × 40MB = 200MB 峰值；
- 瞬间引发系统 GC 停顿与 LMK 杀死进程。

**刚性纪律**：
整个端侧 `web_fetch` 流水线采用**全局单并发插槽（`ConcurrencySlot(1)`）**。
直接复用 `@crish/shared-utils` 中经过充分验证的 `AsyncMutex` / `AsyncSemaphore(1)`：
```ts
import { AsyncSemaphore } from '@crish/shared-utils';

/** 全局单并发插槽：在下载和提取的全生命周期内互斥排队 */
const localFetchSlots = new AsyncSemaphore(1);

export async function fetchSingleWebPage(url: string, signal?: AbortSignal) {
  const release = await localFetchSlots.acquire(signal);
  let extractionOwnsSlot = false;
  try {
    const page = await downloadWebPage(url, signal);
    if (!page.isHtml) {
      return fallbackPlainText(page.content);
    }
    extractionOwnsSlot = true;
    return await extractPage({
      html: page.content,
      url: page.url,
      signal,
      onSettled: release, // 由沙箱原生清理完毕后原子释放
    });
  } finally {
    if (!extractionOwnsSlot) {
      release();
    }
  }
}
```
**生命周期契约**：无论是在等待排队阶段被 Abort、下载阶段网络异常、沙箱超时熔断，还是正常提取完成，`onSettled` / `finally` 均能保证插槽百分之百释放，杜绝队列死锁。

### 5.2 层次化 Token 预算与裁剪矩阵
对提取产出的 Markdown 内容实施分级预算管控：

| 控制维度 | 上限阈值 | 折算规则与行为 |
| :--- | :--- | :--- |
| **单页硬字符截断** | `24,000` 字符 | 在 QuickJS 沙箱内部直接对 Turndown 结果执行 `.slice(0, 24000)`，防止超大字符串跨原生边界传输 |
| **单页 Token 预算** | `4,000` tokens | 按 `MAX_CHARS_PER_TOKEN = 6` 估算，确保单页内容塞入上下文窗口不超过 4K tokens |
| **整批 Token 预算** | `16,000` tokens | 当多 URL 组合返回时，单页限额动态调整为：`Math.min(4000, Math.floor(16000 / N))` |
| **语义截断边界保护** | `sliceContent` | 截断时不截断在 UTF-8 多字节字符中间，优先寻找行尾或标点，并标记 `truncated: true` |

---

## 6. 涉及新增/改造的文件域清单

本方案不修改现有既有业务核心，采用新增原生模块与独立服务层的扩展方式落地：

### 6.1 原生模块文件域（`apps/crish-mobile/modules/crish-js-sandbox/`）
1. `expo-module.config.json`：注册 Android 与 iOS 原生模块入口；
2. `package.json`：模块元数据与声明；
3. `index.ts`：JS/TS 契约导出，类型定义与原生模块装载；
4. `cpp/JsSandbox.h` & `cpp/JsSandbox.cpp`：QuickJS C++ 核心隔离层、内存跟踪分配器、中断处理、Promise 循环排空；
5. `cpp/QuickJs.c`：QuickJS-NG 单翻译单元包含与 `-O2` 优化配置；
6. `vendor/quickjs-ng/quickjs-amalgam.c` & `quickjs.h`：QuickJS-NG 官方引擎源码；
7. `android/build.gradle` & `CMakeLists.txt`：Android 原生构建与编译配置；
8. `android/src/main/cpp/JsSandboxJni.cpp`：JNI UTF-8 字节流传递桥接；
9. `android/src/main/java/expo/modules/jssandbox/JsSandboxModule.kt`：Kotlin 独立 8MB 栈线程调度；
10. `ios/JsSandbox.podspec`：CocoaPods 规格文件；
11. `ios/JsSandboxRunner.h` & `ios/JsSandboxRunner.mm`：Objective-C++ 桥接层；
12. `ios/JsSandboxModule.swift`：Swift 独立 8MB 栈线程调度。

### 6.2 移动端服务层文件域（`apps/crish-mobile/src/services/`）
1. `src/services/sandbox/crishJsSandbox.ts`：QuickJS 沙箱的高级包装器，实现 `run`、结果反序列化、`AbortSignal` 联动；
2. `src/services/webSearch/http/downloadWebPage.ts`：高安全 HTTP 下载器，支持 30s 预算、1MB 物理截断、UTF-8 严苛校验；
3. `src/services/webSearch/http/ssrfGuard.ts`：全谱系 IP 分类、保留段拦截、协议白名单、凭证过滤门禁；
4. `src/services/webSearch/extraction/extractPage.ts`：沙箱调用门面，注入 limits（5000ms / 64MB / 256KB）；
5. `src/services/webSearch/extraction/createExtractionCode.ts`：装配 LinkeDOM、Readability、Turndown，注入 DOM 规范化与 table.rows 补丁；
6. `src/services/webSearch/extraction/vendor/`：包含 `core-js-bundle.json`、`linkedom.json`、`mozilla-readability.json`、`turndown.json`、`turndown-plugin-gfm.json`；
7. `src/services/webSearch/postProcessing.ts`：实现 4,000 / 16,000 tokens 动态均分裁剪与 `sliceContent`。

---

## 7. 立体化测试验收断言（对齐 §7.1 立体验证纪律）

方案交付必须通过全维度自动化测试门禁，严禁单一检查冒充验收：

### 7.1 断言一：死循环中断与 UI 线程 60fps 零掉帧断言
- **测试用例**：向沙箱注入 `while(true) {}` 恶意死循环代码，设置 `timeoutMs: 1000`；
- **验收断言**：
  1. 调用在 `1000ms ~ 1100ms` 范围内确定性 resolve（不 reject），返回 `{ status: 'error', kind: 'timeout' }`；
  2. 原生 Worker 线程在超时后正常退出并销毁，零线程泄漏；
  3. 主 UI 线程渲染持续保持 60fps，手势交互动画无任何丢帧或挂起。

### 7.2 断言二：64MB 堆内存爆破与系统 OOM 免疫断言
- **测试用例**：向沙箱注入 `const arr = []; while(true) { arr.push(new Uint8Array(1024 * 1024)); }` 内存耗尽代码，设置 `memoryBytes: 32 * 1024 * 1024`（32 MiB）；
- **验收断言**：
  1. 自定义分配器成功在 `used >= 32 MiB` 时拦截分配并返回 `nullptr`；
  2. 沙箱平稳捕获 OOM 异常并返回 `{ status: 'error', kind: 'memory' }`；
  3. 宿主 App 进程物理内存（RSS）增量小于 36 MiB，系统未触发任何 SIGABRT 或 LMK 强制终止。

### 7.3 断言三：SSRF 全谱系穿透与 302 跨域重定向拦截断言
- **测试用例集**：
  - 测试 1：`http://127.0.0.1:8080/`、`http://localhost/`、`http://[::1]/`；
  - 测试 2：`http://169.254.169.254/latest/meta-data/`（云元数据）；
  - 测试 3：`http://10.0.0.1/`、`http://192.168.1.1/`、`http://172.20.0.1/`（内网网段）；
  - 测试 4：`http://100.64.0.1/`（CGNAT）；
  - 测试 5：`http://admin:secret@public-domain.com/`（URL 凭据）；
  - 测试 6：公网合法 URL 在第 2 跳 302 重定向至 `http://192.168.1.100/status`；
- **验收断言**：上述全部用例在发起或跟随请求前均被 `ssrfGuard` 拦截，抛出明确错误代码（`page_unsupported_url`、`page_redirect_invalid`），底层网络连接物理上零发出。

### 7.4 断言四：畸形对抗 HTML、深层嵌套表格与 LinkeDOM 边界断言
- **测试用例集**：
  - 测试 1：缺失 `<html><head><body>` 的裸片段 `<div><p>正文内容</p></div>`；
  - 测试 2：深层嵌套表格（外层 table 包含内层 table，内层 table 包含多行，外层 table 无直接 tr）；
  - 测试 3：注入 XSS 对抗代码 `<img src="x" onerror="alert(1)"><a href="javascript:void(0)">点击</a>`；
  - 测试 4：包含 30,000 个平铺节点的膨胀 HTML（验证 `maxElemsToParse: 20000`）；
- **验收断言**：
  1. 裸片段正常补全骨架并提取出完整正文；
  2. 嵌套表格在 Turndown GFM 转换下无报错崩溃，克隆节点上的 `rows` 属性完好；
  3. `onerror` 属性与 `javascript:` 协议链接被 100% 剥离；
  4. 膨胀 HTML 触发优雅截断，提取结果字数严格限制在 `24,000` 字符内。

### 7.5 断言五：单并发互斥排队与 Token 批量裁剪精准度断言
- **测试用例**：
  - 测试 1：同时触发 3 个网页抓取任务（分别耗时 500ms、1000ms、800ms）；
  - 测试 2：批量抓取 4 个各包含 20,000 字符的大网页；
- **验收断言**：
  1. 3 个任务严格按照 FIFO 顺序依次执行，执行时间线互不重叠，内存峰值始终保持在单任务水平；
  2. 批量 4 个网页的总 Token 配额被严格均分为单页 4,000 tokens，每页提取内容均被优雅裁切，各页均包含 `truncated: true` 标记。
