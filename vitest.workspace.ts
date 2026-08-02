// 已废弃（2026-08-03 迁移至 vitest.config.ts 的 test.projects）。
//
// 原因：
// 1. vitest 3.2.7 提示本工作区文件已 deprecated，应改用 test.projects；
// 2. 项目级 coverage 配置（阈值/目录）在本版本会被根配置整体覆盖，
//    实测项目级 coverage.thresholds 解析为 undefined，阈值形同虚设；
//    阈值现统一放在 vitest.config.ts 根 coverage 块（45/70/65/45）。
//
// vitest 在 test.projects 存在时不再加载本文件；保留仅作迁移记录，
// 待确认无工具链引用后经回收站删除。
export {};
