// 环境变量类型（EXPO_PUBLIC_*，D8 §6.2：连接地址解析优先级 1）
export interface AppEnv {
  /** 引擎网关地址（wss://host:8765）；未配置时走平台默认（Android 模拟器 10.0.2.2） */
  EXPO_PUBLIC_ENGINE_URL?: string;
}
