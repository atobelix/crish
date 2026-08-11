# crish-mobile（移动端远程伴侣）

Crish 多端互通的移动端工程（R2 阶段重建，Expo SDK 57 / RN 0.86 / React 19.2.3）。
技术选型与架构详见 `docs/multi-device/plans/D4-mobile-tech.md`、`M5-mobile-engineering.md`、`M4-mobile-ui-architecture.md`。

## 工程形态

- **导航**：expo-router 文件路由（根 `app/` = 深链命名空间）；AuthGuard 未配对强制进配对流程。
- **分层**：`src/presentation`（表现层）→ `src/adapters`（适配层）→ `src/domain`（领域层，vanilla zustand 零 UI 依赖）；`src/network` / `src/pairing` / `src/notifications` 为领域服务域。
- **契约**：全部复用 `@crish/shared-types`（file: 引用，禁止复制事件/命令类型）。

## 常用命令

```bash
npm run typecheck -w @crish/crish-mobile   # tsc --noEmit（strict）
npm test -w @crish/crish-mobile            # jest-expo 单测
npm run start -w @crish/crish-mobile       # expo start（真机需 dev client）
```

## 状态

工程骨架（R2-01）：路由骨架 + AuthGuard + 目录占位 + 纯逻辑单测已就绪；
连接层（R2-02）、配对（R2-03）、审批（R2-04）等按 Z0 主方案 §9.4 逐步落地。
