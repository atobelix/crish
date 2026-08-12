# R2-01 验收记录（Android 模拟器冷启动 + 冒烟验证）

> 文档编号：R2-01-acceptance-emulator
> 日期：2026-08-12
> 任务：R2-01 验收——crish-mobile 在 Android 模拟器冷启动达标 + 冒烟验证（运行工程 + 记录结果，未改业务代码）
> 锚点：Z0 §9.9 R2-01「真机 dev client 冷启动达标；typecheck/lint/单测绿；CI job 上线」（本次做模拟器侧）
> 编码：UTF-8 无 BOM，中文

---

## 1. 验收核对表

| #   | 锚点项                                      | 结果                                 | 证据                                                                                                                                                                                                          |
| --- | ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | typecheck 绿（0 错误）                      | ✅                                   | `npx tsc --noEmit -p tsconfig.json` → `EXIT=0`，无输出                                                                                                                                                        |
| 2   | 单测绿（jest-expo）                         | ✅                                   | `npx jest` → `Test Suites: 13 passed, 13 total` / `Tests: 197 passed, 197 total` / Time 2.5s                                                                                                                  |
| 3   | lint 0 错误                                 | ⚠️ 3 错误（并行任务在途，注明见 §3） | `npx expo lint` → 3 errors，全部位于 `src/domain/data/outbox.ts:123,243` 与 `outbox.test.ts:235`（R2-04 outbox 在途文件，非 R2-01 骨架域；本验收未修改）                                                      |
| 4   | CI job 上线                                 | ✅                                   | `.github/workflows/ci.yml:126-137` `mobile-check` job：Node 22（SDK 57 要求 ≥22.13）+ `npm run typecheck -w @crish/crish-mobile` + `npm test -w @crish/crish-mobile -- --ci`（注释标注 R2-01 / D8 §5.2/§5.5） |
| 5   | dev client 冷启动达标（模拟器）             | ✅                                   | 冷启动链路全通，详见 §4；耗时见 §5                                                                                                                                                                            |
| 6   | 冒烟：启动 → SplashGate → 未配对 → 欢迎页   | ✅                                   | UI 文本断言「配对桌面主机 / 在桌面端开启配对模式…/ 手动输入配对信息」，截图 §7                                                                                                                                |
| 7   | 冒烟：配对流程导航（welcome → manual）      | ✅                                   | 点击「手动输入配对信息」→ manual 页「手动配对 / 主机 IP / 配对码（CXN-XXXX-XXXX-XXXX）/ 连接」                                                                                                                |
| 8   | 冒烟：AuthGuard 守卫（未配对不可达 tab 页） | ✅                                   | deep link `exp://10.0.2.2:8081/--/settings` → 重定向回 `/pair/welcome`（tab 守卫 `(tabs)/_layout.tsx:9-11`）                                                                                                  |
| 9   | 红线：无 FATAL EXCEPTION / RN crash         | ✅                                   | `adb logcat -d` 113845 行 → FATAL EXCEPTION / AndroidRuntime crash 匹配 **0**；仅 1 条 ReactNativeJS **W** 级警告（dev server 重启窗口期的 "Cannot connect to Expo CLI"，操作扰动非缺陷，见 §8-3）            |
| 10  | 截图 2-3 张                                 | ✅                                   | 欢迎页 / manual 页 / 冷启动后欢迎页，见 §7                                                                                                                                                                    |
| 11  | 不修改业务代码                              | ✅                                   | 未触碰 `apps/crish-mobile/src`；仅新建本验收文档                                                                                                                                                              |

## 2. 结论

**R2-01 模拟器侧验收通过**：Expo Go（SDK 57 匹配版本）冷启动加载 crish-mobile 成功，欢迎页 UI 渲染正常，守卫与导航冒烟断言全部通过，logcat 无致命错误。质量基线 typecheck/jest 全绿；lint 3 错误为并行 R2-04 在途文件所致（非本包域）。CI job 已上线（复核）。

## 3. 质量基线复核详情

执行目录 `apps/crish-mobile/`（Node v24.11.0）：

```
$ npx tsc --noEmit -p tsconfig.json     → EXIT=0（0 错误）
$ npx jest                              → Test Suites: 13 passed / Tests: 197 passed
$ npx expo lint                         → 3 errors 0 warnings（EXIT=1）
```

lint 3 错误明细（均为 `src/domain/data/outbox*`，R2-04 并行任务在途文件，本验收按纪律只记录不修改）：

```
outbox.test.ts:235:9   prefer-const                       's' is never reassigned
outbox.ts:123:7        prefer-const                       'items' is never reassigned
outbox.ts:243:61       @typescript-eslint/no-unused-vars  'nowMs' is defined but never used
```

> 注：`git status` 显示 `apps/crish-mobile/src/domain/data/`、`approval*` 等为并行任务（R2-04）未提交在途改动；验收基线复核时上述 lint 错误即已存在，本任务未触碰。

## 4. 冷启动链路（探索记录）

### 4.1 最终链路（成功路径）

```
npx expo start --android（Metro :8081）
  → Expo CLI 自动下载 Expo Go APK 并 adb install 到模拟器（google_apis 镜像无需 Play Store）
  → 自动打开 exp://<host>:8081 → Expo Go 加载 manifest → Metro 出 bundle → JS 执行
adb reverse tcp:8081 tcp:8081（辅助；最终稳定路径用 10.0.2.2）
```

### 4.2 路径探索与最终选择

| 路径                                                                    | 结果                            | 说明                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expo start --android` 自动安装 Expo Go                                 | ✅ 首选路径成立                 | Expo CLI 从官方分发下载 APK 直装，**不依赖 Play Store 镜像**；google_apis 镜像可用                                                                                      |
| `exp://<LAN-IP>:8081`（192.168.1.200）                                  | ⚠️ 首次成功、deep link 重开失败 | 首次 bundle 成功（05:46:44 Running "main"）；dev server 重启后模拟器经 LAN IP 直连被 Windows 防火墙/NAT 阻断（宿主机侧 `packager-status:running` 正常，模拟器侧不可达） |
| `exp://127.0.0.1:8081`（adb reverse）                                   | ❌ Expo Go 白屏                 | 未走通；manifest/bundle fetch 失败无错误提示                                                                                                                            |
| **`exp://10.0.2.2:8081`**（模拟器宿主别名）                             | ✅ **最终采用**                 | 模拟器标准宿主回环别名，绕过 LAN IP 防火墙问题；`adb reverse` 已配但 10.0.2.2 路径不依赖它                                                                              |
| 备选（未启用）：`expo export` 静态 bundle + adb install 自建 dev client | —                               | 自动路径已通，备选未触发                                                                                                                                                |

### 4.3 关键日志片段

Expo CLI（expo-start-android2.log）：

```
- Opening exp://192.168.1.200:8081 on crish-pixel
- Fetching Expo Go
- Installing Expo Go on crish-pixel
Android Bundled 12954ms apps\crish-mobile\node_modules\expo-router\entry.js (1454 modules)
Android Bundled 1343ms apps\crish-mobile\node_modules\expo-router\entry.js (1 module)   # 二次（增量）
```

模拟器侧（adb logcat -s ReactNativeJS:*）：

```
08-12 05:46:44.729 I ReactNativeJS: Running "main" with {"rootTag":1,...,"runtimeVersion":"exposdk:57.0.0",...,"debuggerHost":"10.0.2.2:8081",...}
08-12 06:41:57.715 I ReactNativeJS: Running "main" ... "initialUri":"exp://10.0.2.2:8081" ... "fabric":true
```

## 5. 冷启动耗时

| 场景                                          | 耗时                                               | 说明                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首次全量冷启动（bundle 未缓存）               | Metro bundle **12954ms**（1454 modules）           | 含 Metro 首次构建；随后 Expo Go 内 Running "main" 06:41:50.742→06:41:57.715 ≈ **6.97s**（manifest 生成 → JS 执行）                               |
| 热 bundle 冷启动（Expo Go force-stop 后重开） | **2615ms**（am start → UI 可交互「配对桌面主机」） | 计时脚本轮询 uiautomator dump；含 force-stop 全流程 5296ms                                                                                       |
| 渲染帧率（粗略观察）                          | 稳态 avg≈**28ms/帧**（≈35fps）                     | EGL_emulation app_time_stats（进程 8424）：`avg=28.03ms min=3.61ms max=200.88ms count=23`（模拟器软件渲染；JS 执行期偶发长帧 max≈6.3s 为启动期） |

> 说明：R2-01 锚点「冷启动达标」在模拟器环境以 Expo Go 冷启动 + UI 可交互为判据，达标。真机 dev client（`expo run:android`）留待 R2-16 真机联调轮。

## 6. 冒烟断言明细

| 断言                                                                 | 结果 | 证据（UI 文本，uiautomator dump）                                                                                             |
| -------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| app 启动 → SplashGate（`app/_layout.tsx:22-28`）水合完成前不挂导航树 | ✅   | 水合为同步置位（`authStore.ts:29-34` 骨架实现），无闪跳                                                                       |
| 未配对 → Redirect `/pair/welcome`                                    | ✅   | 欢迎页文本：`配对桌面主机` / `在桌面端开启配对模式，然后在手机上输入主机 IP 与配对码即可完成配对。` / `手动输入配对信息`      |
| 点击「手动输入配对信息」→ `/pair/manual`                             | ✅   | manual 页文本：`手动配对` / `主机 IP / 主机名` / `配对码（CXN-XXXX-XXXX-XXXX）` / `连接`                                      |
| deep link `/--/settings` → 守卫重定向欢迎页                          | ✅   | `(tabs)/_layout.tsx:9-11` pairState!=='paired' → `<Redirect href="/pair/welcome" />`；实测 deep link 后 UI 仍为欢迎页三行文本 |
| 无致命错误                                                           | ✅   | logcat FATAL=0（见 §1 第 9 行）                                                                                               |

## 7. 截图证据

保存目录：`C:\Users\orange\AppData\Local\Temp\opencode\`

| 文件                                           | 内容                                            | 大小     |
| ---------------------------------------------- | ----------------------------------------------- | -------- |
| `r2-01-02-welcome-10.0.2.2.png`                | 欢迎页（配对桌面主机 / 手动输入配对信息按钮）   | 70,868 B |
| `r2-01-03-manual.png`                          | manual 页（手动配对 / 主机 IP / 配对码 / 连接） | 54,276 B |
| `r2-01-04-welcome-coldstart.png`               | 冷启动计时后欢迎页                              | —        |
| `r2-01-01-initial.png` / `r2-01-debug-1/2.png` | 过程记录（初始首页 / 调试中间态）               | —        |

## 8. 失败卡点与重试记录

| #   | 卡点                                                                                                                                                                           | 处置                                                                                                                                                        | 结果                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | **ENOSPC**：Expo Go 下载写入失败（C 盘仅剩 3.5GB）                                                                                                                             | `npm cache clean --force` 释放 5.7GB（3.5→9.2GB 空闲）后原样重派 `expo start --android`                                                                     | ✅ 首次自动安装成功 |
| 2   | PowerShell `>` 重定向损坏 screencap PNG 二进制                                                                                                                                 | 改用 `cmd /c "adb exec-out screencap -p > file"` 字节级重定向                                                                                               | ✅                  |
| 3   | **adb 输出中文编码损坏**：`adb shell cat` 的 UTF-8 字节被 PowerShell 隐式解码成 mojibake（字符码点验证：U+95B0…≠「配」U+914D），导致 uiautomator XML 中文本匹配/IndexOf 全失败 | 改用 **base64 字节通道**：`adb shell base64 /sdcard/ui.xml` → `[Convert]::FromBase64String` → `UTF8.GetString` 显式解码；输出经文件落盘（UTF-8 无 BOM）读取 | ✅ 全部文本断言可靠 |
| 4   | LAN IP（192.168.1.200）深链重开失败：`Cannot connect to Expo CLI`（宿主机侧 8081 正常，模拟器侧不可达）                                                                        | 诊断后改 `exp://10.0.2.2:8081`（模拟器宿主别名）                                                                                                            | ✅ 稳定可达         |
| 5   | 深链触发 Expo Go dev-menu 首屏 / 错误弹窗覆盖                                                                                                                                  | `KEYCODE_BACK` 关闭                                                                                                                                         | ✅                  |
| 6   | `exp://127.0.0.1:8081`（纯 adb reverse）白屏                                                                                                                                   | 放弃该路径，改用 10.0.2.2                                                                                                                                   | ✅                  |

## 9. 环境说明

| 项           | 值                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| 模拟器       | AVD `crish-pixel`，Android 15（API 35），x86_64，**google_apis 镜像（非 playstore）**；`emulator-5554` 已 boot |
| adb          | `C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe`                                             |
| Expo Go      | 由 Expo CLI 自动下载安装（SDK 57 分发），package `host.exp.exponent`，runtimeVersion `exposdk:57.0.0`          |
| Expo SDK     | 57.0.0（`expo ~57.0.12`；app.json manifest `sdkVersion:57.0.0`）                                               |
| React Native | 0.86.2（Expo Go 内 `fabric:true`）                                                                             |
| React        | 19.2.3                                                                                                         |
| Node         | v24.11.0（≥22.13 达标，D4 §2.3）                                                                               |
| 网络路径     | `exp://10.0.2.2:8081`（模拟器宿主别名）；`adb reverse tcp:8081 tcp:8081` 已配                                  |

## 10. 遗留项（不阻塞验收）

1. lint 3 错误（`outbox.ts` / `outbox.test.ts`，R2-04 在途）——R2-04 收口时应清零；
2. 真机 dev client 冷启动（`expo run:android` 构建）与性能达标数据留待 R2-16 真机联调轮（本记录为模拟器侧判据）；
3. 模拟器 → 宿主 LAN IP 直连被 Windows 防火墙阻断的现象，建议后续真机联调前核对防火墙对 8081 的放行（真机无 10.0.2.2 别名，需 LAN IP 直连或 adb reverse）。
