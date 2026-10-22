//! P 层排除前置（P2-P6、零尺寸）用例（自 interactive.rs 平移）。

use super::*;

/// P2：html/body 不作为交互目标。
#[test]
fn p2_root_tags_excluded() {
    let a = attrs(&[]);
    assert_eq!(
        decide(&ctx(
            "html",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0
            })
        )),
        Decision::Excluded(Excluded::P2RootTag)
    );
    assert!(matches!(
        decide(&ctx("body", &a, visible(), None)),
        Decision::Excluded(Excluded::P2RootTag)
    ));
}

/// P3：display:none / visibility:hidden / opacity=0 / 祖先隐藏 / 无 bounds。
#[test]
fn p3_hidden_variants_excluded() {
    let a = attrs(&[]);
    let mut s = visible();
    s.display = Some("none".into());
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            s,
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            })
        )),
        Decision::Excluded(Excluded::P3Hidden)
    );
    let mut s = visible();
    s.visibility = Some("hidden".into());
    assert_eq!(
        decide(&ctx("button", &a, s, None)),
        Decision::Excluded(Excluded::P3Hidden)
    );
    let mut s = visible();
    s.opacity = Some(0.0);
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            s,
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            })
        )),
        Decision::Excluded(Excluded::P3Hidden)
    );
    let mut c = ctx("button", &a, visible(), None);
    c.ancestor_hidden = true;
    assert_eq!(decide(&c), Decision::Excluded(Excluded::P3Hidden));
}

/// P3 例外：input[type=file] 常 opacity:0 包裹定制样式，强制可见。
#[test]
fn p3_file_input_forced_visible() {
    let a = attrs(&[("type", "file")]);
    let mut s = visible();
    s.opacity = Some(0.0);
    assert_eq!(
        decide(&ctx(
            "input",
            &a,
            s,
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            })
        )),
        Decision::Interactive(RuleHit::S2NativeTag),
        "隐藏 file input 是功能元素，强制可见（§2.3 例外）"
    );
}

/// P4：disabled 属性 / aria-disabled=true / AX disabled 排除。
#[test]
fn p4_disabled_excluded() {
    let a = attrs(&[("disabled", "")]);
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            })
        )),
        Decision::Excluded(Excluded::P4Disabled)
    );
    let a = attrs(&[("aria-disabled", "true")]);
    assert!(matches!(
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0
            })
        )),
        Decision::Excluded(Excluded::P4Disabled)
    ));
    let mut ax = AxInfo {
        present: true,
        ..AxInfo::default()
    };
    ax.properties.disabled = true;
    let a = attrs(&[]);
    let c = DecideCtx {
        tag: "button",
        attributes: &a,
        ax: &ax,
        bounds: Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        }),
        ..ctx("button", &a, visible(), None)
    };
    assert_eq!(decide(&c), Decision::Excluded(Excluded::P4Disabled));
}

/// P5：AX ignored 装饰性节点排除。
#[test]
fn p5_ax_ignored_excluded() {
    let ax = AxInfo {
        present: true,
        ignored: true,
        ..AxInfo::default()
    };
    let a = attrs(&[]);
    let c = DecideCtx {
        tag: "div",
        attributes: &a,
        ax: &ax,
        bounds: Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        }),
        ..ctx("div", &a, visible(), None)
    };
    assert_eq!(decide(&c), Decision::Excluded(Excluded::P5AxIgnored));
}

/// P6：SVG 子元素默认装饰；svg 根保留；S8 显式交互 SVG 放行。
#[test]
fn p6_svg_decorative_and_s8_explicit() {
    let a = attrs(&[]);
    let mut c = ctx(
        "path",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        }),
    );
    c.in_svg = true;
    assert_eq!(decide(&c), Decision::Excluded(Excluded::P6SvgChild));
    // svg 根自身（in_svg=false）不排除
    let c = ctx(
        "svg",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        }),
    );
    assert_eq!(decide(&c), Decision::NotInteractive);
    // S8：SVG 子树中带交互 data-* 放行（onclick 会被 S6 先行命中）
    let a = attrs(&[("data-action", "zoom")]);
    let mut c = ctx(
        "g",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 20.0,
        }),
    );
    c.in_svg = true;
    assert_eq!(decide(&c), Decision::Interactive(RuleHit::S8ExplicitSvg));
}

/// 零尺寸排除（§2.3；可滚动例外：有滚动内容时不作零尺寸排除，滚动容器
/// 由 W2 接管为可交互目标）。
#[test]
fn zero_size_excluded() {
    let a = attrs(&[]);
    assert_eq!(
        decide(&ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0
            })
        )),
        Decision::Excluded(Excluded::ZeroSize)
    );
    // 可滚动零尺寸：不作零尺寸排除（§2.3「且无滚动内容」），W2 命中
    let mut c = ctx(
        "div",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 10.0,
        }),
    );
    c.is_scrollable = true;
    assert_eq!(
        decide(&c),
        Decision::Interactive(RuleHit::W2ScrollContainer),
        "可滚动零尺寸由 W2 接管"
    );
}
