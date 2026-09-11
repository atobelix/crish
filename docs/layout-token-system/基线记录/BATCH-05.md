# BATCH-05 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **前置**：BATCH-01 ~ 04 已落地

## 落地内容

1. **planProgressBar 舌头废除**：`-10px` / `calc(100%-36px)` / `margin-left:18px` → 独立闭合卡；`margin-bottom:2px`；圆角 8px；collapsed 垫高补偿删除。
2. **pad-x 锁 12px**：单行 `6px 12px`；多行 `8px 12px`。
3. **圆角 20/24**：tokens 已有，消费侧确认一致。
4. **184 行重复块**：第二份整删；`.sendBtn` 保留恰好一份；文件 1918→1735 行。

## 验收

```
layout + fused + sendControls + planProgress + field.stop
# 31/31 all passed
```

## 改动文件

- `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`

## 真机待验

- 进度条独立卡与输入卡 2px 间距观感
- pad-x 12px 后单多行切换抖动
- field 模式发送钮仍正常

## 明确未做（有意）

- 权限槽位全量 SSOT / PermissionModeMenu API 扩展
- `--composer-pad-x` 落 tokens.css
- planProgressBar 顶侧遗留 box-shadow 弱化
