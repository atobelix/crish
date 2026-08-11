# A-* 断言索引（W0-C · 机械摘录入口）

> **全文权威**：`round-D-stack/07-技术栈矩阵裁决.md` §5  
> **补钉**：`18-实现波前待决锁定-H1H2H3M1.md`（A-INV-09、A-MEM、A-PERF-DEG）  
> 本文件：族清单入库；**禁止**用本表缩水替代 D7 全表。

| 族                | 覆盖                                | 主责 Wave                                            |
| ----------------- | ----------------------------------- | ---------------------------------------------------- |
| A-BLK-01…14       | 块完成度                            | W6-A                                                 |
| A-SIL-01…04       | 静默                                | W3-C / W6-A                                          |
| A-IME-01…08       | IME                                 | W3-B / W6-B                                          |
| A-SEL-01…06       | 选区                                | W3-B                                                 |
| A-COL-01…08       | 协同                                | W1-F / W6-D                                          |
| A-AGT-01…08       | Agent                               | W4 / W6-E                                            |
| A-MD-*            | MD 往返                             | W2-A/B                                               |
| A-PERF-*          | 性能结构/数值                       | W3-A / W6-C                                          |
| A-PERF-DEG-01     | 退化治理                            | 18 / CI                                              |
| A-INV-01…08       | 结构不变量                          | W1                                                   |
| **A-INV-09a/b/c** | 跨引擎同批/checkpoint/删叶          | W0/W1                                                |
| A-MEM-01…04       | 热集/冷藏                           | W1-B                                                 |
| **A-HUGE-01…08**  | 超长单块（阈值/分段/V6/Agent 原子） | W1-B / W3-D；规格 `plans/specs/huge-block-policy.md` |
| A-EXT-*           | 扩展                                | W4-C                                                 |
| A-SWAP-*          | 换实现                              | 08                                                   |
| A-QRY-01…         | 受限 query                          | W2-F                                                 |

缺族 = W0-C 红。实现测试须引用 ID 字符串。

### A-HUGE 摘要（详见 huge-block-policy §7）

| ID        | 一句话                                                  |
| --------- | ------------------------------------------------------- |
| A-HUGE-01 | `< T_HUGE` 保持单 YText，无强制分段                     |
| A-HUGE-02 | split/大写入同事务全成或全败，无半树                    |
| A-HUGE-03 | 可编辑叶 ≥ `T_PM_NODE_SOFT` 必须行窗口，禁止 MB 单 node |
| A-HUGE-04 | 冷超长可读且远端 update 不丢                            |
| A-HUGE-05 | Agent 超阈写入后合法分段或只读折叠，拼接=载荷           |
| A-HUGE-06 | 只读折叠可恢复编辑（先 split/V6）                       |
| A-HUGE-07 | 分段不破 grapheme，拼接 equals                          |
| A-HUGE-08 | 超长 pin + IME 与块内窗口正确                           |
