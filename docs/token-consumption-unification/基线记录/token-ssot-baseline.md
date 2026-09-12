# token-ssot 棘轮基线（T1 · 真源唯一化门禁）

> 载体：scripts/check-token-ssot.mjs
> 纪律：**棘轮只降不升**。`--update` 仅在指标下降后运行；提升基线必须在提交信息中显式说明理由。
> 硬失败指标（multi_file_defs / js_inject_a_class / b_class_no_default / b_class_drift / namespace_overlap）目标恒为 0。
> 生成时间：2026-09-12T05:51:52.905Z

<!-- BASELINE_START -->
multi_file_defs 0
documented_api_defs 26
js_inject_a_class 23
a_class_multi_writer 0
b_class_no_default 0
b_class_drift 0
namespace_overlap 5
whitelist_size 15
<!-- BASELINE_END -->
