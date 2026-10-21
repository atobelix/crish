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
};
