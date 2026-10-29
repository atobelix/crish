// 设置词典拆分部分：模型与服务商（models.*）的子域词条，由 settings.ts 通过 spread 聚合。
// 须与 en-US/settingsModels.ts 保持键集合与插值参数一致。

export const settingsPartModels = {
  // ── 模型厂商展示名（models.vendor.*；ModelVendorMeta.nameKey 引用）──
  'models.vendor.deepseek': 'DeepSeek (深度求索)',
  'models.vendor.qwen': '通义千问 (Qwen)',
  'models.vendor.moonshot': '月之暗面 (Kimi)',
  'models.vendor.zhipu': '智谱 AI (GLM)',
  'models.vendor.minimax': 'MiniMax (海螺)',
  'models.vendor.bytedance': '字节跳动 (豆包)',
  'models.vendor.stepfun': '阶跃星辰 (StepFun)',
  'models.vendor.baichuan': '百川智能 (Baichuan)',
  'models.vendor.zeroone': '零一万物 (01.AI)',
  'models.vendor.baidu': '百度 (文心一言)',
  'models.vendor.tencent': '腾讯 (混元)',
  'models.vendor.iflytek': '科大讯飞 (星火)',
  'models.vendor.sensetime': '商汤科技 (日日新)',
  'models.vendor.kling': '快手 (可灵 Kling)',
  'models.vendor.siliconflow': 'SiliconFlow (硅基流动)',

  // ── 模型设置页总览与全局默认模型（models.*）──
  'models.addProvider': '添加服务商',
  'models.globalDefaultModel': '全局默认模型',
  'models.globalDefaultModelDesc': '可选。不指定时，在对话里选择模型即可',

  // ── 模型配置文件 models.yaml 直达菜单（models.yaml.*）──
  'models.yaml.configFile': '模型配置文件 (models.yaml)',
  'models.yaml.editAria': '在内置编辑器中编辑模型配置文件 (models.yaml)',
  'models.yaml.moreAria': '配置文件直达与打开方式',
  'models.yaml.menuAria': '模型配置文件直达选项',
  'models.yaml.openBuiltin': '内置编辑器打开',
  'models.yaml.externalEditors': '外部编辑器',
  'models.yaml.openDefault': '系统默认程序打开',
  'models.yaml.fileActions': '文件操作',
  'models.yaml.reveal': '在文件资源管理器中定位',
  'models.yaml.copyPath': '复制绝对路径',
  'models.yaml.pathCopied': '已复制配置文件绝对路径',
  'models.yaml.openFailed': '打开失败',
  'models.yaml.revealFailed': '定位失败',

  // ── 全局默认模型停用后的同厂商自愈提示（models.selfHeal.*）──
  'models.selfHeal.switched':
    '当前模型已停用，已自动切换至同厂商模型: {modelId}',
  'models.selfHeal.noModelLeft': '当前服务商已无可用模型，请手动选择',

  // ── 全局默认模型级联选择器（models.cascade.*）──
  'models.cascade.fallbackTrigger': '暂无已启用模型（请前往开启）',
  'models.cascade.fallbackEmptyMenu': '暂无已启用的可用模型',
  'models.cascade.modelListAria': '{name} 模型列表',
  'models.cascade.chooseModel': '选择模型...',
  'models.cascade.unspecified': '不指定',
  'models.cascade.title': '选择服务商与模型',

  // ── 左侧服务商导航轨栏（models.profileList.*）──
  'models.profileList.ariaList': '服务商列表',
  'models.profileList.empty': '还没有服务商',
  'models.profileList.missingKey': '缺少密钥',
  'models.profileList.disabled': '已停用',
  'models.profileList.ready': '已配置并启用',
  // ── 连通探活与表单校验（models.probe.*）──
  'models.probe.vendorNameEmpty': '厂商名称不能为空',
  'models.probe.vendorNameSaveFailed': '保存厂商名称失败',
  'models.probe.handshakeOk':
    '服务商握手正常（已验证服务地址与凭据有效，可点击右侧「自动获取」添加模型）',
  'models.probe.checkFailed': '连通检查失败：{error}',
  'models.probe.contextWindowWriteFailed':
    '扫描到的上下文长度写入统一树失败：{error}',
};
