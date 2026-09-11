# BATCH-04 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **前置**：BATCH-01 ~ 03 已落地

## 落地内容

1. **.listInner 纵向 padding 归零**：`padding: 0 var(--chat-stream-pad-x, 20px)`；几何归 `chatScrollGeometry.ts` 单轨。
2. **searchHit ΔH≡0**：废除负 margin / width calc / padding-top；改 `box-shadow` 纯 Paint 扩散。
3. **FAB transform**：`margin-top: -46px` → `translateY(-46px)`；hover/active 保持 1px 抬升关系；floorSlot pad-x → 20px。
4. **pinnedBar 僵尸样式清退**：约 100 行 CSS 删除；保留 `.pinnedList`（测试契约占用）；未动 PagingAnchor 查询。
5. **气泡圆角**：已绑 `--chat-bubble-radius`，无需再改。

## 验收

```
npx vitest run \
  VirtualScrollGeometryContract + chatScrollGeometry + useScrollAnchor + PagingAnchor
# 4 files, 28 tests, all passed
```

## 改动文件

- `apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css`
- `apps/crish-desktop/src/components/chat-message-list/ChatScrollFloorSlot.module.css`
- `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`

## 真机待验

- searchHit 6px box-shadow 在 `contain: layout paint` 下是否被裁切
- FAB 位移与 hover 反馈
