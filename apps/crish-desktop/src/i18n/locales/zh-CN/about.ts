import type { AboutTranslations } from '../../types';

export const about: AboutTranslations = {
  // 品牌与应用标题
  pageTitle: '关于',
  title: '关于',
  appName: 'Crish Desktop',
  appDescription: '现代化本地优先自主 Agent 桌面工作台与多模型协作开发环境',
  description: '现代化本地优先自主 Agent 桌面工作台与多模型协作开发环境',
  appInfo: '应用信息',
  appVersion: '应用版本',
  appVersionLabel: '应用版本',
  kernelVersion: '内核版本',
  kernelVersionLabel: 'Conex 内核版本',
  kernelDesc: 'Rust 内核会话引擎与调度编排核心',
  systemArch: '系统与运行架构',

  // 系统信息
  systemSectionTitle: '应用与系统信息',
  systemInfo: '系统信息',
  osLabel: '操作系统',
  osVersion: '操作系统版本',
  archLabel: '系统架构',
  architecture: '系统架构',
  runtimeLabel: '运行时环境',
  copySysInfo: '复制系统信息',
  copySysInfoBtn: '复制系统信息',
  copySysInfoTooltip: '复制操作系统、应用版本与内核架构信息',
  copySysInfoSuccess: '系统信息已复制到剪贴板',
  sysInfoCopied: '系统信息已复制',
  sysInfoCopiedToast: '系统信息已复制到剪贴板',

  // 主许可证
  mainLicenseSectionTitle: '软件主许可证',
  openSourceLicense: '开源许可证',
  primaryLicense: '主许可证 (Primary License)',
  mainLicenseName: 'MIT 许可证 (MIT License)',
  mainLicenseCopyright: '版权所有 (c) 2026 Conex 开源社区',
  viewMainLicenseAction: '查看 LICENSE 完整文本',
  viewLicense: '查看许可证',
  mitLicenseText:
    '本软件基于 MIT 许可证开放源代码。允许任何人免费获得本软件及其相关文档的副本，不受限制地处理本软件，包括但不限于使用、复制、修改、合并、发布、分发、再许可和/或出售本软件副本的权利。',

  // 第三方协议披露
  thirdPartySectionTitle: '第三方开源许可与合规披露',
  thirdPartyTitle: '第三方开源协议与披露',
  thirdPartySubtitle:
    'Crish Desktop 与 Conex Kernel 依赖优秀的开源社区组件，谨此致谢。',
  thirdPartyNotices: '第三方开源依赖与许可证',
  thirdPartyDesc:
    '包含宽松协议依赖、MPL-2.0 弱互惠组件披露、SIL OFL-1.1 字体授权与商业模型商标使用声明',
  toggleViewThirdParty: '查看第三方许可证列表',
  toggleCollapseThirdParty: '收起第三方许可证列表',
  viewThirdParty: '查看第三方声明',
  viewFullLicenseModal: '弹窗查看完整协议',
  modalViewAction: '弹窗查看完整协议明细',
  modalTitle: '第三方开源许可证完整披露',
  modalCloseBtn: '关闭',
  thirdPartyModalTitle: '第三方开源许可证与版权披露',

  // 协议分类说明
  permissiveTitle: '宽松开源依赖 (Permissive Open-Source Libraries)',
  permissiveDesc:
    'Crish Desktop 使用并包含了众多遵循宽松开源协议（Permissive Open-Source Licenses）的优秀依赖项。这些项目以其各自协议授权分发，完整的版权声明与许可条款均保留在各自源代码及分发包中：',
  mplTitle: 'Mozilla Public License 2.0 (MPL-2.0) 弱互惠合规披露',
  mplDisclosureNotice:
    '依照 MPL-2.0 第 3.1 条与第 3.2 条要求，本项目对直接依赖的 MPL 库（及修改）履行源码分发与告知义务。下述组件均保持独立动态/静态链接，用户可通过官方仓库获取对应源码副本。',
  mplViewSourceAction: '获取源码',
  weakCopyleftTitle:
    '弱互惠型依赖开源披露 (Weak Copyleft — MPL-2.0 Section 3.1 & 3.2)',
  weakCopyleftDesc:
    '根据 Mozilla Public License 2.0 (MPL-2.0) 第 3.1 条与第 3.2 条要求，本项目特此公开以下以未修改库形式（Unmodified library form）直接引用的第三方组件。您可通过下述链接直接访问并获取其完整源代码：',
  weakCopyleftSourceNotice:
    '根据 Mozilla Public License 2.0 (MPL-2.0) 第 3.1 条与第 3.2 条要求，本项目履行源码告知义务。',
  unmodifiedForm: '未修改库形式 (Unmodified)',
  fontsTitle: '随附字体许可声明 (Bundled Fonts — SIL OFL-1.1)',
  fontsOflNotice:
    '界面集成的 Inter、JetBrains Mono 及 IBM Plex 字体依据 SIL OFL-1.1 授权分发，允许在数字化产品中免费嵌入与呈现。',
  fontsDesc:
    '本项目随附并使用了以下开源字体家族，均遵循 SIL Open Font License 1.1 (SIL OFL-1.1) 协议分发：',
  trademarkTitle:
    '商业模型商标合理使用声明 (Commercial LLM Trademark Fair Use)',
  trademarkFairUseNotice:
    'OpenAI、Anthropic、Google Gemini、DeepSeek 等商标及其相关标识均为其各自所有者的财产。Crish Desktop 与 Conex Kernel 为独立开发的开源软件客户端，仅在模型连接、协议适配与兼容性说明的合理使用（Fair Use）范围内使用上述商标，不代表与各商标所有者存在从属、赞助、授权或许可关联关系。',
  trademarkDesc:
    'OpenAI、Anthropic、Google Gemini、DeepSeek 等商标及其相关标识均为其各自所有者的财产。Crish Desktop 与 Conex Kernel 为独立开发的开源软件客户端，仅在模型连接、协议适配与兼容性说明的合理使用（Fair Use）范围内使用上述商标，不代表与各商标所有者存在从属、赞助、授权或许可关联关系。',

  // 依赖项描述 (树形对象 + 扁平键双支持)
  dependencyDesc: {
    bitmaps: '固定容量的高效位图数据结构',
    cssparser: '符合 CSS Syntax Level 3 规范的解析器',
    cssparserMacros: 'cssparser 过程宏支持库',
    im: '不可变集合与持久化数据结构库',
    sizedChunks: '不可变集合底层定长分块缓冲区',
    lightningcss: '极速 CSS 转换、压缩与 AST 解析工具',
    parcelWatcher: '跨平台原生文件系统监听组件',
    interFont: '现代高效屏幕显示无衬线字体',
    jetbrainsMonoFont: '专为代码编写与字符对齐优化的等宽字体',
    ibmPlexFont: 'IBM 官方高可读性开源字体族',
  } as unknown as string,
  'dependencyDesc.bitmaps': '固定容量的高效位图数据结构',
  'dependencyDesc.cssparser': '符合 CSS Syntax Level 3 规范的解析器',
  'dependencyDesc.cssparserMacros': 'cssparser 过程宏支持库',
  'dependencyDesc.im': '不可变集合与持久化数据结构库',
  'dependencyDesc.sizedChunks': '不可变集合底层定长分块缓冲区',
  'dependencyDesc.lightningcss': '极速 CSS 转换、压缩与 AST 解析工具',
  'dependencyDesc.parcelWatcher': '跨平台原生文件系统监听组件',
  'dependencyDesc.interFont': '现代高效屏幕显示无衬线字体',
  'dependencyDesc.jetbrainsMonoFont': '专为代码编写与字符对齐优化的等宽字体',
  'dependencyDesc.ibmPlexFont': 'IBM 官方高可读性开源字体族',

  // 社区与外链
  communityTitle: '社区与支持',
  repoLinkText: 'GitHub 源代码仓库',
  githubRepo: 'GitHub 源码仓库',
  visitRepo: '访问仓库',
  securityReport: '安全漏洞报告',
  securityReportText: '安全漏洞与敏感问题报告通道',
  securityReportDesc:
    '如发现安全隐患或漏洞，请通过 GitHub Security Advisory 或 security@conex.dev 报告',
  submitVulnerability: '提交漏洞',

  // 历史基础词条保持兼容
  noticeTitle: '声明',
  checkUpdates: '检查更新',
  checkUpdatesDesc:
    '通过 Minisign 签名验证的更新通道检查新版本，发现后可在侧栏一键安装',
  checkingUpdates: '正在检查更新...',
  // 更新链路 (updateStore · RUN-03/GAP-01)
  noUpdateAvailable: '当前没有可用更新',
  tasksRunningBlockUpdate: '仍有任务在运行，请结束后再更新',
  applyUpdateFailed: '更新失败',
  applyUpdateFailedDetail: '更新失败：{error}',
  updateChannelUnavailable: '更新通道不可用',
  updateInstalledRestart: '更新包已安装，请重启应用完成更新',
  checkUpdateFailedDetail: '检查更新失败：{error}',
  upToDate: '已是最新版本',
  updateAvailable: '发现新版本',
  newVersionAvailable: '发现新版本：{version}',
  updateFailed: '检查更新失败',
  webviewVersion: 'WebView 版本',
  rustVersion: 'Rust 内核版本',
  nodeVersion: 'Node.js 版本',
  releaseNotes: '发行说明',
  privacyPolicy: '隐私政策',
  termsOfService: '服务条款',
  acknowledgements: '致谢',
  copyright: '© {year} Conex. 保留所有权利。',
};

export default about;
