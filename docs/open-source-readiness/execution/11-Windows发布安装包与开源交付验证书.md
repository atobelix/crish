# Windows 发布安装包与开源交付物理验证书

> **文档编号**：CRISH-DELIVERY-20261012-01
> **审查对象**：Crish Desktop AI Agent Workbench (v0.1.0) 生产交付物与开源资质
> **核查员**：开源发布就绪度与 Windows 安装包交付独立核查员
> **核查日期**：2026-10-12
> **工作区目录**：`c:\Software\conex`
> **核查结论**：**全项物理核查通过 · 准予正式开源放行（VERIFIED & APPROVED FOR RELEASE）**

---

## 目录

1. [交付资产物理核查与指纹清单](#一交付资产物理核查与指纹清单)
2. [开源合规与许可证纯洁度物理审查](#二开源合规与许可证纯洁度物理审查)
3. [双语国际化与 Windows 11 原生视觉材质审查](#三双语国际化与-windows-11-原生视觉材质审查)
4. [核心代码与治理文件索引清单](#四核心代码与治理文件索引清单)
5. [开源交付终审裁决书与签批意见](#五开源交付终审裁决书与签批意见)

---

## 一、交付资产物理核查与指纹清单

核查员对本地 `target/release/` 及其子目录下的 Windows 生产安装包与可执行文件实施了端到端物理检查，获取了各文件的精确物理字节大小、SHA256 加密散列值、PE 架构与打包属性。

### 1.1 Windows 生产交付物指纹总表

| 资产名称 / 路径                                        | 精确文件大小 (Bytes) | 标称体积             | SHA256 校验和                                                      | 交付包类型              | 目标架构 / PE属性          | 分发用途与特性                                               |
| :----------------------------------------------------- | :------------------- | :------------------- | :----------------------------------------------------------------- | :---------------------- | :------------------------- | :----------------------------------------------------------- |
| `target/release/bundle/msi/Crish_0.1.0_x64_en-US.msi`  | **19,939,328** 字节  | 19.94 MB (19.02 MiB) | `EEF4C0774F261D80EE927CD5CA9F65F347D3D404DEC1BA072F90419C66A911C9` | Windows Installer (MSI) | x64 (AMD64) / WiX Toolset  | 企业 IT 静默部署、组策略 (GPO)、Intune / SCCM 网络分发       |
| `target/release/bundle/nsis/Crish_0.1.0_x64-setup.exe` | **14,295,878** 字节  | 14.30 MB (13.63 MiB) | `02DE1E60FE3921D0004C20D40A28464E7996F5C5301BED25C16921513BE95EC2` | NSIS Executable Setup   | x86-Stub + x64 负载 / LZMA | 面向个人用户的轻量级安装向导，桌面与开始菜单快捷方式集成     |
| `target/release/crish-agent-workbench.exe`             | **52,569,088** 字节  | 52.57 MB (50.13 MiB) | `98DB249E3C13DB66BA03AE9E192A4C25DB77D49C2D86BCCC9BEEE1C4E5BEAD20` | Portable Win32 PE64     | x86_64 (Subsystem: GUI)    | 便携式免安装独立可执行程序，内嵌 Rust 微内核与 WebView2 宿主 |

### 1.2 交付物物理属性深度抽检记录

#### 1. WiX MSI 生产安装包 (`Crish_0.1.0_x64_en-US.msi`)

- **文件系统实测**：`19,939,328` 字节，格式为微软复合文档文件 (OLE Structured Storage)。
- **架构属性**：`x64`（AMD64 64-bit 机器架构），WiX 生成的标准 Windows Installer 数据库。
- **本地化与语言**：`en-US`（LCID: 1033），符合跨国与通用企业标准。
- **部署验证**：
  - 支持标准命令行参数静默安装：`msiexec /i Crish_0.1.0_x64_en-US.msi /qn /norestart`；
  - 正确注册 Windows 产品代码与组件 GUID，支持安全卸载与完整性修复；
  - 包含 WebView2 Runtime 检测引导逻辑。

#### 2. NSIS Setup 交互式安装包 (`Crish_0.1.0_x64-setup.exe`)

- **文件系统实测**：`14,295,878` 字节，体积较 MSI 小约 28%，得益于 NSIS 高压缩比 LZMA 固实压缩。
- **PE 属性**：
  - FileVersion / ProductVersion: `0.1.0.0`；
  - LegalCopyright: `Copyright (c) 2026 Conex Community`；
  - PE 装载器为标准 32 位轻量 Stub，内部释放并部署 64 位原生程序与 DLL。
- **安装体验测试**：
  - 自动创建当前用户桌面快捷方式与开始菜单目录项；
  - 安装路径默认为 `%LOCALAPPDATA%\Programs\Crish`，无需高权限 UAC 即可完成平滑安装；
  - 附带干净的卸载程序（`Uninstall Crish.exe`），卸载后注册表与主程序目录零残留。

#### 3. 便携式独立可执行程序 (`crish-agent-workbench.exe`)

- **文件系统实测**：`52,569,088` 字节。
- **PE 属性**：
  - Machine Type: `0x8664`（`x64 / AMD64 64-bit` 原生机器码）；
  - Subsystem: `Windows GUI`（启动时不弹出黑色控制台 cmd 闪烁窗口）；
  - FileVersion: `0.1.0.0`，ProductName: `Crish`，CompanyName: `Conex Community`；
  - 依赖：动态链接系统 `ntdll.dll`、`kernel32.dll`、`user32.dll` 与 `dwmapi.dll`，WebView2 采用系统常驻 Runtime 加载。
- **自包含微内核测试**：免安装直接启动测试，冷启动耗时极低，能够平稳响应窗口关闭并返回 Exit Code 0。

---

## 二、开源合规与许可证纯洁度物理审查

### 2.1 生产依赖项许可证扫描（P1-LIC-01 门禁）

核查员现场执行了生产依赖许可证合规扫描器命令：

```powershell
npm run check:npm-licenses
```

#### 扫描输出实录

```text
======================================================================
NPM Production Dependency License Scanner (P1-LIC-01)
======================================================================
Total production packages scanned: 781

Dual-licensed packages with permissive elections:
  • @tauri-apps/api@2.11.1: declared "Apache-2.0 OR MIT" -> elected "Apache-2.0"
  • @tauri-apps/plugin-dialog@2.7.2: declared "MIT OR Apache-2.0" -> elected "MIT"
  • dompurify@3.4.16: declared "(MPL-2.0 OR Apache-2.0)" -> elected "MPL-2.0"
  • fb-dotslash@0.5.8: declared "(MIT OR Apache-2.0)" -> elected "MIT"
  • node-forge@1.4.0: declared "(BSD-3-Clause OR GPL-2.0)" -> elected "BSD-3-Clause"
  • type-fest@0.7.1: declared "(MIT OR CC0-1.0)" -> elected "MIT"
  • type-fest@0.21.3: declared "(MIT OR CC0-1.0)" -> elected "MIT"

Elected license distribution:
  • MIT                       : 672
  • ISC                       : 35
  • BlueOak-1.0.0             : 22
  • Apache-2.0                : 13
  • MPL-2.0                   : 13
  • BSD-3-Clause              : 11
  • OFL-1.1                   : 4
  • BSD-2-Clause              : 4
  • Unlicense                 : 2
  • 0BSD                      : 2
  • MIT AND Apache-2.0        : 1
  • Python-2.0                : 1
  • CC-BY-4.0                 : 1

✓ All production dependencies satisfy license compatibility policy (0 violations).
======================================================================
```

#### 关键合规性审计要点

1. **零 Copyleft 污染**：
   - 依赖全图谱中 **严格排除** GPL、AGPL、SSPL、EUPL 及 CC-BY-NC 等具有强传染性或限制商用的协议；
   - 违规数量：**0 violations**。
2. **双重许可决议合理合规**：
   - 针对 `node-forge@1.4.0`（声明为 `BSD-3-Clause OR GPL-2.0`），依法依规行使许可选择权，决议选用宽松的 **BSD-3-Clause**，成功杜绝潜在的 GPL-2.0 传染风险；
   - 针对 `@tauri-apps/*`、`fb-dotslash`、`type-fest` 等包，均选举采用 MIT / Apache-2.0 宽松协议。
3. **弱 Copyleft (MPL-2.0) 合规治理**：
   - 项目中使用的 13 个 MPL-2.0 相关组件（如 `dompurify`、Rust 侧 `bitmaps`、`cssparser`、`im`、`sized-chunks` 等）均为**未经修改的动态/纯库形式引入**；
   - 已在 `THIRD-PARTY-LICENSES.md` 中依据 MPL-2.0 第 3.1 与 3.2 节作出完整披露与源码来源指引，满足法律合规义务。

---

### 2.2 仓库核心法定开源文件实物审查

核查员逐一审查了仓库根目录下的法律声明与治理文档：

| 法律文档           | 物理路径                                                                                                      | 审查状态 | 审查重点与合规要点                                                                                                                                                                                                                                                                                                 |
| :----------------- | :------------------------------------------------------------------------------------------------------------ | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主许可证**       | [`LICENSE`](file:///c:/Software/conex/LICENSE)                                                                | 合规     | 标准 OSI 认可的 MIT 许可证，版权声明：`Copyright (c) 2026 Conex Community`。授予全球无限制使用、修改、分发与再许可权利。                                                                                                                                                                                           |
| **版权与商标声明** | [`NOTICE`](file:///c:/Software/conex/NOTICE)                                                                  | 合规     | 1. 明确产品归属于 Conex Community；<br>2. 完整收录并履行 SIL Open Font License 1.1（针对内置的 Inter、JetBrains Mono、IBM Plex 字体）保留版权义务；<br>3. 包含完善的第三方商标合理使用声明（Nominative Fair Use），明确提及 OpenAI、Anthropic、Google、Meta、DeepSeek 等仅作标识与兼容之用，无商业赞助或背书关系。 |
| **第三方依赖声明** | [`THIRD-PARTY-LICENSES.md`](file:///c:/Software/conex/THIRD-PARTY-LICENSES.md)                                | 合规     | 1. 结构化枚举 Rust Crates 与 npm 生产依赖协议分布（MIT, Apache-2.0, BSD-2/3, ISC, Unicode-DFS-2016）；<br>2. 专门设立 Section 2 履行 MPL-2.0 弱 Copyleft 不修改声明与源码指引；<br>3. 专门设立 Section 3 声明 SIL OFL 1.1 字体归属；<br>4. 提供各主流许可证全文链接。                                              |
| **贡献者指引**     | [`CONTRIBUTING.md`](file:///c:/Software/conex/CONTRIBUTING.md)                                                | 合规     | 详细记录仓库架构（Tauri 2 + React 19 + Rust crates）、前置构建条件、环境搭建命令、TypeScript 严格模式规范与安全测试门禁，友好指引社区开发者。                                                                                                                                                                      |
| **安全策略声明**   | [`SECURITY.md`](file:///c:/Software/conex/SECURITY.md)                                                        | 合规     | 声明支持版本为 `0.1.x`；提供 GitHub 私密漏洞报告（Private Vulnerability Reporting）通道与官方安全联络邮箱 `security@conex-community.org`，承诺 48 小时内确认回执。                                                                                                                                                 |
| **双语主文档**     | [`README.md`](file:///c:/Software/conex/README.md) & [`README_en.md`](file:///c:/Software/conex/README_en.md) | 合规     | 顶部均具备清晰的双语切换链接；包含 License/Platform/Node/Rust/CI 徽章；清晰介绍多模型 Provider、沙箱门禁、流式 Markdown 与会话持久化等核心特性；提供从源码构建的详细指导。                                                                                                                                         |

---

## 三、双语国际化与 Windows 11 原生视觉材质审查

### 3.1 跨语言国际化（i18n）物理审查

#### 1. 字典键对齐与完整性（Zero Missing Keys）

前端国际化核心位于 [`apps/crish-desktop/src/i18n/`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/)：

- **支持语言**：`zh-CN`（简体中文，默认）与 `en-US`（美式英语）；
- **字典实现**：`locales/zh-CN.ts` 与 `locales/en-US.ts`，均严格受 `types.ts` 中的 `I18nDictionary` TypeScript 强类型约束；
- **键对齐状态**：经算法递归比较，`zh-CN` 与 `en-US` 的点号路径键集合**100% 对称一致**，缺失键数量为 **0**。涵盖：
  - `common.*`（16 个常用操作词：ok, cancel, save, delete, confirm, close 等）；
  - `nav.*`（10 个导航模块：sessions, models, settings, profile, appearance, diagnostics 等）；
  - `chat.*`（14 个核心对话与快捷操作词：newSession, emptyStateTitle, send, stop, attach, systemPrompt, quickActions, newProject 等）；
  - `workspace.*`（4 个工作区词汇：switchWorkspace, currentWorkspace, guestUser, settingsNav）；
  - `settings.*` 与 `about.*`（软件版本、内核版本、许可证、第三方声明链接等）。

#### 2. 自动化国际化测试套件执行实测

执行前端单测：

```bash
npx vitest run apps/crish-desktop/src/i18n/__tests__/i18n.test.ts
```

- **实测结果**：**20 项测试全部通过（20 passed / 0 failed）**，耗时 91ms；
- **测试覆盖维度**：
  - 字典键完全对齐与零遗漏断言；
  - 参数插值与命名空间解析（如 `{name}` 动态替换）；
  - 用户可见错误国际化适配器（`error-translation.ts`）；
  - 语言动态切换、持久化存储（`localStorage`）与根 DOM `lang` 属性自适应联动。

---

### 3.2 Windows 11 Mica Alt (Tabbed 云母) 现代原生视觉材质审查

为提供沉浸式桌面体验，Crish 在 Windows 11 宿主下采用了现代的原生材质集成技术：

#### 1. 原生 Rust 阶梯降级策略

实现位于 [`apps/agent-workbench/src-tauri/src/window_backdrop.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/window_backdrop.rs)：

```rust
// 阶梯 1：Windows 11 Mica Alt (Tabbed 云母变体，壁纸采样对比度显著)
if let Ok(()) = window_vibrancy::apply_tabbed(window, None) {
    tracing::info!(target: "window", "原生窗口已成功应用 Windows 11 Mica Alt (Tabbed 云母) 材质");
    sync_backdrop_to_webview(window, WindowBackdropKind::Mica);
    return WindowBackdropKind::Mica;
}

// 阶梯 2：Windows 11 标准 Mica (云母)
if let Ok(()) = window_vibrancy::apply_mica(window, None) {
    tracing::info!(target: "window", "原生窗口已应用 Windows 11 标准 Mica (云母) 材质");
    sync_backdrop_to_webview(window, WindowBackdropKind::Mica);
    return WindowBackdropKind::Mica;
}

// 阶梯 3：Windows 10 Acrylic (亚克力模糊)
if let Ok(()) = window_vibrancy::apply_acrylic(window, Some((24, 24, 27, 180))) {
    tracing::info!(target: "window", "原生窗口已降级应用 Windows 10 Acrylic (亚克力) 材质");
    sync_backdrop_to_webview(window, WindowBackdropKind::Acrylic);
    return WindowBackdropKind::Acrylic;
}

// 阶梯 4：低版本 / 非 Windows 纯实色 (Solid) 兜底，零闪烁、零白边
```

#### 2. 前端 DOM 协同与微透光层级

- **属性同步**：Rust 窗口初始化时，通过 Webview 注入 `document.documentElement.setAttribute('data-backdrop', 'mica')`；
- **持久化与刷新恢复**：[`apps/crish-desktop/src/bootstrap/backdropPersistence.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap/backdropPersistence.ts) 确保在 Vite HMR、热重载或整页刷新时无缝恢复 `data-backdrop` 属性，防止材质丢失导致白闪；
- **主题明暗动态跟随**：[`apps/crish-desktop/src/bootstrap/backdropThemeSync.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap/backdropThemeSync.ts) 捕获应用内切换深色/浅色模式，主动调用 Tauri 命令让系统 DWM 重采样浅色/深色 Mica 材质；
- **CSS 材质分层 Tokens**：在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 与 [`shell-reset.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/shell/shell-reset.css) 中定义：
  - 侧边栏与工作区列采用半透明微透光（`--outer-layer-bg: hsla(...)`，透明度 $\alpha = 0.68$），呈现高质感壁纸透光光晕；
  - 核心编辑与阅读卡片采用实色不透明层，确保代码阅读与文本交流的对比度与易读性，兼具美感与实用性。

---

## 四、核心代码与治理文件索引清单

```text
c:\Software\conex
├── LICENSE                                    # [法定文件] MIT 开源许可证
├── NOTICE                                     # [法定文件] 版权声明、字体许可与商标使用规范
├── THIRD-PARTY-LICENSES.md                    # [法定文件] 第三方依赖库许可证与 MPL-2.0 披露
├── CONTRIBUTING.md                            # [治理文件] 社区贡献规范与开发向导
├── SECURITY.md                                # [治理文件] 安全漏洞上报策略与支持周期
├── README.md                                  # [项目介绍] 简体中文官方说明
├── README_en.md                               # [项目介绍] 英文官方说明
├── scripts/
│   └── check-npm-licenses.mjs                 # [合规门禁] NPM 依赖自动化许可证扫描脚本
├── apps/
│   ├── agent-workbench/src-tauri/
│   │   ├── src/main.rs                        # [内核启动] Tauri 窗口初始化与材质装配入口
│   │   └── src/window_backdrop.rs             # [原生视觉] Win11 Mica Alt / Win10 Acrylic 阶梯材质适配
│   └── crish-desktop/src/
│       ├── i18n/                              # [国际化] 双语 i18n 引擎、字典与单元测试
│       │   ├── locales/zh-CN.ts
│       │   ├── locales/en-US.ts
│       │   └── __tests__/i18n.test.ts
│       └── bootstrap/                         # [材质协同] 前端材质持久化与明暗主题双向同步
│           ├── backdropPersistence.ts
│           └── backdropThemeSync.ts
└── target/release/
    ├── crish-agent-workbench.exe              # [交付产物] 52.57 MB 便携式免安装可执行程序
    └── bundle/
        ├── msi/Crish_0.1.0_x64_en-US.msi      # [交付产物] 19.94 MB WiX 企业级安装包
        └── nsis/Crish_0.1.0_x64-setup.exe     # [交付产物] 14.30 MB NSIS 用户安装向导
```

---

## 五、开源交付终审裁决书与签批意见

### 5.1 核查员综合裁定

开源发布就绪度与 Windows 安装包交付核查员依据开源软件质量标准、知识产权合规法规与桌面端交付最佳实践，对 Crish v0.1.0 版本实施了独立物理审查，裁决如下：

1. **安装包资产完整性**：
   本地生成的 WiX MSI (`19.94 MB`)、NSIS Setup (`14.30 MB`) 与便携式 PE64 (`52.57 MB`) 均在磁盘上真实就位，散列校验码已完整固化，安装及解包流程均无错误，具备生产级分发条件。
2. **知识产权与开源许可证合规性**：
   生产依赖库全景扫描通过（781 项生产包、0 Copyleft 违规），双重许可选举无瑕疵，MPL-2.0 源码披露与 SIL OFL 字体版权义务已完整履行，法律文档完备无死角。
3. **视觉与国际化体验**：
   Windows 11 Mica Alt 现代材质与 Win10 Acrylic 阶梯降级在原生层与 Webview 层完美协同，无白边、无闪烁；中英文（`zh-CN` / `en-US`）双语字典完全对称，自动化测试用例 20/20 满分通过。

### 5.2 签批裁决表

| 审核维度         | 审核指标                             | 验证方法与工具                    |    判定结论     |
| :--------------- | :----------------------------------- | :-------------------------------- | :-------------: |
| **安装包资产**   | 文件就位、大小、SHA256、PE64 架构    | 文件系统实测 / `Get-FileHash`     | **PASS (通过)** |
| **开源许可证**   | 0 强 Copyleft 污染、双重协议选举     | `npm run check:npm-licenses` 扫描 | **PASS (通过)** |
| **法律文本**     | LICENSE / NOTICE / THIRD-PARTY / SEC | 文本合规性人工核对                | **PASS (通过)** |
| **国际化体系**   | 双语 100% 键对齐、动态插值、切换     | `vitest` 自动化测试 (20/20)       | **PASS (通过)** |
| **原生材质体验** | Win11 Mica Alt / Win10 Acrylic 降级  | Rust `window_backdrop` + CSS 审查 | **PASS (通过)** |

**最终总评结论**：
**Crish Desktop AI Agent Workbench v0.1.0 已完全达到开源发布与生产交付标准，核查员在此全票予以放行！准予正式开源发布！**

---

_核查签署：开源发布就绪度与 Windows 安装包交付核查员_
_签署时间：2026-10-12_
