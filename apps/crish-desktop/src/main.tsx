/**
 * main.tsx — 前端物理唯一入口（index.html 引用契约，文件名不可改）。
 *
 * 直接转发至 entry-core.tsx（单拍装配 · ACT-301），消除四阶动态 import 瀑布。
 * 首屏不再顶层静态导入 @xterm 样式（下沉至 TerminalCard 惰性链路）。
 */
// 必须先于 entry-core：整页刷新后恢复 data-backdrop（云母分层规则的开关），见 bootstrap/backdropPersistence.ts
import './bootstrap/backdropPersistence';
// 材质跟随应用主题（通知 Rust 重设 Mica/Acrylic），见 bootstrap/backdropThemeSync.ts
import './bootstrap/backdropThemeSync';
import './entry-core';
