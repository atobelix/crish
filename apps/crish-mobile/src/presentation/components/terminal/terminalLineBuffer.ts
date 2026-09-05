// 终端行缓冲（表现层兼容层）：实现已下沉至 domain/pure/terminalLineBuffer（零 UI 依赖纯算法）
// 本模块保留为向后兼容 re-export，消除 store/reducers 对 presentation 的反向依赖。
export * from '@/domain/pure/terminalLineBuffer';
