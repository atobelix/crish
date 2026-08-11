# 流式直刷覆盖率语料（W2-2 落盘，R-4 语料定义）

> 本文件与 `src/assets/test-document.md`（压力测试文档）合并作为 S-T-2-02
> 覆盖率基线的语料来源：本文件聚焦「真实 LLM 流式正文」形态——中文/英文
> 混合、日期、编号、句点缩写、数字统计、算式、符号混排等；test-document.md
> 聚焦语法密集的压力形态。两者互补，合计构成直刷判定的现实语料集。

## 一、中文正文（日期与数字统计形态）

今天是 2026 年 8 月 11 日，项目进入第 2 阶段验收。

截至本季度末，累计完成需求 128 项，整体完成率 87.5%，比上季度提升 6.3 个百分点。

本次发布包含 3 个新特性与 12 项缺陷修复，回归测试共 986 例全部通过。

服务器集群共 24 台，平均响应时间 0.45 秒，P99 延迟 1.2 秒，均优于目标值。

版本迭代记录：v1.0 初始版本、v2.5 流式渲染、v3.1 表格定型，当前主线为 v3.2。

订单号 ORD-2026-0811-0042 已完成支付，金额 328.50 元，预计 3-5 个工作日送达。

温度 25 摄氏度，湿度 60%，降水概率 20%，风力 3 级，适宜外出活动。

会议定于 2026-08-12 14:00 举行，时长约 90 分钟，地点为三楼 304 会议室。

统计数据显示，移动端占比 68.2%，桌面端占比 31.8%，移动端同比增长 12.4%。

库存水位 1250 件，低于安全库存线 30%，建议补充采购 400 件。

## 二、英文正文（句点缩写与数字混排形态）

The quick brown fox jumps over the lazy dog, and then it returns to sleep.

According to the report, 87.5% of the users completed the survey within 3 days.

Dr. Smith will give a lecture on modern web rendering at 2 p.m. tomorrow.

The package costs $12.50 per unit, with a 10% discount for bulk orders.

Use version 2.5.1 or later; the earlier release 1.9.8 has known issues.

For example, e.g. the term "streaming render" refers to incremental updates.

The meeting starts at 10:30 a.m. and ends around 12:00 p.m. sharp.

Project Phoenix, launched in Aug. 2026, covers 48 regions across 19 countries.

The latency dropped from 320 ms to 96 ms, a 70% improvement year over year.

IP address 192.168.1.1 and port 8080 are used by the local dev server.

## 三、中英混合与符号（算式/括号/叹号/连字符/上标单字符形态）

x=1 时公式成立，y = x + 2 的结果为 3，这与预期完全一致。

质能方程 E=mc^2 是物理学中最著名的公式之一，其中 c 表示光速。

a+b 的结果取决于输入，例如 1+2=3，而 2+3=5，依此类推。

用户反馈（N=256）显示：满意度 4.2 分（满分 5 分），推荐意愿 78%。

注意！更新前请备份数据，重要文件将保存至 backup 目录（路径可自定义）。

任务 ID user-001 与 user-002 已完成合并，剩余 user-003 待处理。

该函数接受两个参数：first-name（必填）与 last-name（选填）。

中文-英文混排示例：streaming 直刷渲染支持 500 token/s 的注入速率。

电话号码 +86 138-0013-8000 已绑定账户，验证码 6 位数字 428913。

错误率 0.5% 处于可控范围，阈值设定为 1.0%，暂无触发告警。

## 四、正文风格段落（多句连排形态）

流式渲染引擎在保持行级渲染的前提下，将直刷覆盖范围扩展至含数字与标点的正文行。

The engine renders each line incrementally while keeping the document fully editable.

验证结论如下：含日期、编号与英文句点的正文行均可直刷，语法行保持常规路径。

This approach keeps the direct-stream path safe, simple, and remarkably fast.

以上语料由人工整理，覆盖真实流式文本中最高频的二十余种正文形态。

## 五、语法密集对照段（应拒绝的形态，保持语料真实性）

> 引用行属于语法形态，必须拒绝直刷。

- 无序列表项同样必须拒绝直刷。

1. 有序列表项通过行首模式黑名单拒绝。

---

**加粗文本** 与 `行内代码` 属于既有禁集，仍拒绝直刷。

| 列 A | 列 B |
| ---- | ---- |

数学公式 $x^2$ 与上下标 2^10^ 均拒绝直刷。

### 标题行拒绝直刷，正文行照常直刷。

```text
围栏代码块内的行不属于正文形态。
```

## 六、流式逐 chunk 形态（同一行按到达顺序切分，模拟真实 token 流）

2026-08-11 流式会话中，逐 chunk 到达的行先经判定再决定直刷或常规路径。

The final answer is 42, computed from the equation 6 x 7 = 42.

本段用于验证行在多个 chunk 中渐进增长时判定的一致性（判定对象是合并后的完整行）。

Conclusion: the direct-stream coverage increased by more than 20 percentage points.
