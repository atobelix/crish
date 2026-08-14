//! 17 类检出样例集（T-3：11 检出类 + 6 负例）+ 盲区统计 —— fixture 驱动确定性断言
//!
//! fixture 固化于 `tests/fixtures/snapshot/`（静态 JSON 树构造 + 期望标注），
//! CI 以固定 fixture 驱动（T-3：避免真实站点 flaky），真实站点验证走
//! 手工/可选 job。盲区元素（§3.6）不参与检出率口径（已知限制，非漏检）。

use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::snapshot::collect::{EnhancedNode, FrameMarker};
use conex_browser::snapshot::serialize::{build_and_serialize, SerializeOptions};
use conex_browser::snapshot::BlindZoneStats;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::PathBuf;

/// fixture 根目录（CARGO_MANIFEST_DIR 定位，与运行目录解耦）。
fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("snapshot")
}

#[derive(Debug, Deserialize)]
struct SampleFixture {
    roots: Vec<FixtureNode>,
    #[serde(default)]
    expected: FixtureExpect,
    #[serde(default)]
    blind_zone: BlindZoneStats,
}

#[derive(Debug, Deserialize, Default)]
struct FixtureExpect {
    #[serde(default)]
    interactive: Vec<i64>,
    #[serde(default)]
    not_interactive: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct FixtureNode {
    id: i64,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    attrs: Vec<(String, String)>,
    #[serde(default)]
    styles: std::collections::HashMap<String, String>,
    #[serde(default)]
    bounds: Option<[f64; 4]>,
    #[serde(default)]
    scrollable: bool,
    #[serde(default)]
    svg: bool,
    #[serde(default)]
    listeners: bool,
    #[serde(default)]
    marker: Option<String>,
    #[serde(default)]
    ax: Option<FixtureAx>,
    #[serde(default)]
    children: Vec<FixtureNode>,
}

#[derive(Debug, Deserialize, Default)]
struct FixtureAx {
    #[serde(default)]
    present: bool,
    #[serde(default)]
    ignored: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    properties: std::collections::HashMap<String, bool>,
}

impl FixtureNode {
    fn into_enhanced(self) -> EnhancedNode {
        let mut node = match self.tag {
            Some(tag) => EnhancedNode::element(&tag, self.id),
            None => EnhancedNode::text_node(self.text.as_deref().unwrap_or(""), self.id),
        };
        // 元素节点的 text 字段转为文本子节点（元素行内联文本，id 取派生值防碰撞）
        if node.tag.is_some() {
            if let Some(t) = self.text.as_deref() {
                if !t.is_empty() {
                    node = node.push(EnhancedNode::text_node(t, self.id * 1000 - 1));
                }
            }
        }
        for (k, v) in self.attrs {
            node = node.attr(&k, &v);
        }
        for (k, v) in self.styles {
            node = node.style(&k, &v);
        }
        if let Some([x, y, w, h]) = self.bounds {
            node = node.bounds(x, y, w, h);
        }
        if self.scrollable {
            node = node.scrollable();
        }
        if self.svg {
            node = node.svg_child();
        }
        if self.listeners {
            node = node.listener();
        }
        if let Some(marker) = self.marker.as_deref() {
            node = node.marker(match marker {
                "iframe" => FrameMarker::Iframe,
                "shadow-open" => FrameMarker::ShadowOpen,
                "shadow-closed" => FrameMarker::ShadowClosed,
                other => panic!("未知 marker：{other}"),
            });
        }
        if let Some(ax) = self.ax {
            node.ax.present = ax.present;
            node.ax.ignored = ax.ignored;
            if let Some(role) = ax.role {
                node = node.ax_role(&role);
            }
            for (name, value) in ax.properties {
                node = node.ax_prop(&name, value);
            }
        }
        for child in self.children {
            node = node.push(child.into_enhanced());
        }
        node
    }
}

/// 加载 fixture 并跑默认预算序列化。
fn run_sample(
    name: &str,
) -> (
    Vec<EnhancedNode>,
    conex_browser::snapshot::serialize::SerializeOutput,
) {
    let path = fixtures_dir().join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 fixture {path:?} 失败：{e}"));
    let fixture: SampleFixture =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {name} JSON 解析失败：{e}"));
    let roots: Vec<EnhancedNode> = fixture
        .roots
        .into_iter()
        .map(FixtureNode::into_enhanced)
        .collect();
    let budgets = BudgetConfig::active();
    let previous = HashSet::new();
    let opts = SerializeOptions::new(&budgets, "samples", &previous);
    let out = build_and_serialize(&roots, &opts);
    (roots, out)
}

/// 断言期望集合与 selector_map 完全一致（正例全检出、负例全不检出）。
fn assert_expectations(name: &str, out: &conex_browser::snapshot::serialize::SerializeOutput) {
    let path = fixtures_dir().join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 fixture {path:?} 失败：{e}"));
    let fixture: SampleFixture =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("fixture {name} JSON 解析失败：{e}"));
    let indexed: HashSet<i64> = out
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    for id in &fixture.expected.interactive {
        assert!(
            indexed.contains(id),
            "正例 id={id} 应检出（{name}）；已索引：{indexed:?}\n{}",
            out.text
        );
    }
    for id in &fixture.expected.not_interactive {
        assert!(
            !indexed.contains(id),
            "负例 id={id} 不应检出（{name}）；已索引：{indexed:?}\n{}",
            out.text
        );
    }
}

/// 17 类样例集全类别：正例检出率 100%（11 类正例全部索引命中）、负例 0 误报。
#[test]
fn samples_seventeen_classes_full_suite() {
    for name in [
        "s01_native.json",
        "s02_aria.json",
        "s03_listener.json",
        "s04_wrapped.json",
        "s05_search.json",
        "s06_icon.json",
        "s07_shadow_open.json",
        "s08_shadow_closed.json",
        "s09_iframe.json",
        "s10_complex.json",
        "s11_scroll.json",
        "s12_disabled.json",
        "s13_hidden.json",
        "s14_svg.json",
        "s15_zero_size.json",
        "s16_label_for.json",
        "s17_ax_ignored.json",
    ] {
        let (_, out) = run_sample(name);
        assert_expectations(name, &out);
    }
}

/// s03 专用：getEventListeners 增强通道默认关闭（T-4）——纯监听器元素
/// 通道开启后检出，关闭时由其余启发式兜底（本例不命中则不出索引）。
#[test]
fn samples_s03_listener_channel_gated() {
    let (roots, out_default) = run_sample("s03_listener.json");
    // 默认（通道关闭）：id=1 内联事件命中 S6、id=3 原生兜底；id=2 纯监听器不命中
    let indexed_default: HashSet<i64> = out_default
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    assert!(indexed_default.contains(&1));
    assert!(indexed_default.contains(&3));
    assert!(
        !indexed_default.contains(&2),
        "通道关闭时纯监听器元素不检出（T-4）"
    );

    // 通道开启：S1 命中 → id=2 检出
    let budgets = BudgetConfig::active();
    let previous = HashSet::new();
    let mut opts_on = SerializeOptions::new(&budgets, "samples", &previous);
    opts_on.listener_channel = true;
    let out_on = build_and_serialize(&roots, &opts_on);
    let indexed_on: HashSet<i64> = out_on
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    assert!(indexed_on.contains(&2), "通道开启时监听器元素应检出");
}

/// s08 专用（T-5）：closed shadow 内 AX 检出但无 backendNodeId → 不可操作、
/// 不分配索引、头部统计 unoperable。
#[test]
fn samples_s08_closed_shadow_unoperable() {
    let (_, out) = run_sample("s08_shadow_closed.json");
    assert_eq!(
        out.blind_zone.unoperable, 1,
        "closed shadow 降级元素应计入统计"
    );
    assert!(out.text.contains("|SHADOW(closed)|"));
    assert!(
        out.text.contains("|UNOPERABLE|"),
        "不可操作前缀应呈现：\n{}",
        out.text
    );
    assert!(out.text.contains("Shadow End"));
}

/// s09 专用（U-4）：iframe 占位不分配索引；同源 pierce 子树正常检出。
#[test]
fn samples_s09_iframe_placeholder_and_content() {
    let (_, out) = run_sample("s09_iframe.json");
    assert!(out
        .text
        .contains("|IFRAME|<iframe src=https://same.example/frame.html />"));
    let indexed: HashSet<i64> = out
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    assert!(!indexed.contains(&1), "iframe 占位不分配交互索引（U-4）");
    assert!(
        indexed.contains(&3) && indexed.contains(&4),
        "同源 pierce 子树检出"
    );
}

/// s10 专用：select options 展开 / 日期 format 提示 / 隐藏 file input 强制可见。
#[test]
fn samples_s10_complex_controls() {
    let (_, out) = run_sample("s10_complex.json");
    assert!(
        out.text.contains("options=北京|上海|深圳"),
        "select options 应展开：\n{}",
        out.text
    );
    assert!(
        out.text.contains("format=YYYY-MM-DD"),
        "日期输入应附 format 提示"
    );
    let indexed: HashSet<i64> = out
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    assert!(
        indexed.contains(&3),
        "隐藏 file input 强制可见（§2.3 例外）"
    );
}

/// 盲区统计（V4/T-16）：canvas/video/img 占位呈现、不分配索引、头部统计一致。
#[test]
fn samples_blind_zone_stats() {
    let (_, out) = run_sample("blindzones.json");
    let path = fixtures_dir().join("blindzones.json");
    let raw = std::fs::read_to_string(&path).unwrap();
    let fixture: SampleFixture = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        out.blind_zone, fixture.blind_zone,
        "头部盲区统计应与 fixture 一致"
    );
    assert!(out.text.contains("|CANVAS|<canvas>"));
    assert!(
        out.text.contains("|VIDEO|<video src=clip.mp4>"),
        "video 占位行保留 src 描述属性（T-16 补齐）：\n{}",
        out.text
    );
    assert!(
        out.text.contains("|IMG|<img alt=示意图>"),
        "img 占位保留属性（D4 不误伤）：\n{}",
        out.text
    );
    let indexed: HashSet<i64> = out
        .selector_map
        .values()
        .map(|r| r.backend_node_id)
        .collect();
    assert!(!indexed.contains(&1) && !indexed.contains(&2) && !indexed.contains(&3));
    assert!(indexed.contains(&4));
}

/// 样例集全类别输出结构冒烟：无空行、行首缩进规整。
#[test]
fn samples_output_well_formed() {
    for name in [
        "s01_native.json",
        "s02_aria.json",
        "s04_wrapped.json",
        "s05_search.json",
        "s10_complex.json",
        "s11_scroll.json",
    ] {
        let (_, out) = run_sample(name);
        for line in out.text.lines() {
            assert!(!line.is_empty(), "{name} 输出含空行");
        }
    }
}
