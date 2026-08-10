/**
 * Tauri 插件动态 import 测试 stub（R2-4 P3-1 配套）：
 * vitest 解析不到 @tauri-apps/plugin-*（浏览器构建 external），
 * 经 vitest.config resolve.alias 指向本文件。非 Tauri 测试环境
 * 下这些模块被 import 后返回 stub 对象（skillsApi 的 catch 回退覆盖）。
 */
export const readFile = undefined;
export const writeFile = undefined;
export const exists = undefined;
export const readDir = undefined;
export const mkdir = undefined;
export const remove = undefined;
export const rename = undefined;
export const stat = undefined;
export const openPath = undefined;
export const revealItemInDir = undefined;
export const open = undefined;
