//! M/W 层信号、四层优先级、判定缓存与子树探测用例（自 interactive.rs 平移）。

use super::*;

/// M1：label/span 包裹表单控件通过；label[for]（M0）跳过。
#[test]
fn m1_wrapped_control() {
    let a = attrs(&[]);
    let mut c = ctx(
        "label",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 30.0,
        }),
    );
    c.wrapped_control = true;
    assert_eq!(decide(&c), Decision::Interactive(RuleHit::M1Wrapped));
    // M0：label[for] 不判可交互（点击代理到目标控件）
    let a = attrs(&[("for", "target")]);
    let mut c = ctx(
        "label",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 30.0,
        }),
    );
    c.wrapped_control = true;
    c.wrapped_by_label_for = true;
    assert_eq!(
        decide(&c),
        Decision::NotInteractive,
        "label[for] 防双激活（M0）"
    );
}

/// M2：搜索类模式（class/id/data-* 子串匹配）。
#[test]
fn m2_search_pattern() {
    for (k, v) in [
        ("class", "search-btn"),
        ("id", "searchBox"),
        ("data-action", "search"),
    ] {
        let a = attrs(&[(k, v)]);
        assert_eq!(
            decide(&ctx(
                "div",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 80.0,
                    height: 30.0
                })
            )),
            Decision::Interactive(RuleHit::M2SearchPattern),
            "{k}={v} 应命中 M2"
        );
    }
}

/// M3：图标尺寸元素（20×20）且含 aria-label；大元素不命中。
#[test]
fn m3_icon_button() {
    let a = attrs(&[("aria-label", "搜索图标")]);
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::S2NativeTag),
        "button 走 S2；M3 面向 div/span 形态"
    );
    let a = attrs(&[("aria-label", "搜索图标")]);
    assert_eq!(
        decide(&ctx(
            "span",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::M3IconButton)
    );
    // 无交互类属性不命中
    let a = attrs(&[]);
    assert_eq!(
        decide(&ctx(
            "span",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0
            })
        )),
        Decision::NotInteractive
    );
    // 超出图标尺寸不命中
    let a = attrs(&[("aria-label", "x")]);
    assert_eq!(
        decide(&ctx(
            "span",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 200.0
            })
        )),
        Decision::NotInteractive
    );
}

/// W1：cursor:pointer。
#[test]
fn w1_cursor_pointer() {
    let mut s = visible();
    s.cursor = Some("pointer".into());
    let a = attrs(&[]);
    assert_eq!(
        decide(&ctx(
            "div",
            &a,
            s,
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 80.0,
                height: 30.0
            })
        )),
        Decision::Interactive(RuleHit::W1CursorPointer)
    );
}

/// W2：可滚动容器无交互后代通过；有交互后代不通过；dropdown 无条件。
#[test]
fn w2_scroll_container() {
    let a = attrs(&[]);
    let mut c = ctx(
        "div",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        }),
    );
    c.is_scrollable = true;
    assert_eq!(
        decide(&c),
        Decision::Interactive(RuleHit::W2ScrollContainer)
    );
    c.subtree_has_interactive = true;
    assert_eq!(
        decide(&c),
        Decision::NotInteractive,
        "有交互后代时 W2 不命中"
    );
    // dropdown 容器无条件可交互（role=listbox 会被 S3 先行命中，此处以
    // class 模式验证 W2 dropdown 路径）
    let a = attrs(&[("class", "dropdown-menu")]);
    let c = ctx(
        "div",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        }),
    );
    assert_eq!(
        decide(&c),
        Decision::Interactive(RuleHit::W2ScrollContainer)
    );
    // role=listbox：S3 优先级高于 W2（S 层任一命中即通过）
    let a = attrs(&[("role", "listbox")]);
    let c = ctx(
        "div",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 300.0,
        }),
    );
    assert_eq!(decide(&c), Decision::Interactive(RuleHit::S3RoleAttr));
}

/// 优先级语义：P 否决 > S 通过 > M/W（disabled button 即使有搜索 class 也不检出）。
#[test]
fn priority_p_over_s_over_mw() {
    let a = attrs(&[("disabled", ""), ("class", "search-btn")]);
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0
            })
        )),
        Decision::Excluded(Excluded::P4Disabled),
        "P 层否决优先于一切正信号"
    );
    // S2 命中时不再看 M/W
    let a = attrs(&[("class", "search-btn")]);
    assert_eq!(
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::S2NativeTag)
    );
}

/// 判定缓存：同键重复判定走缓存（命中率上升）。
#[test]
fn decision_cache_reuses() {
    let mut cache = DecisionCache::new();
    let a = attrs(&[]);
    let r1 = cache.get_or_else("s1", 42, || {
        decide(&ctx(
            "button",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            }),
        ))
    });
    assert!(matches!(r1, Decision::Interactive(_)));
    let r2 = cache.get_or_else("s1", 42, || panic!("不应重复计算"));
    assert_eq!(r1, r2);
    assert!(cache.hit_ratio() > 0.0, "同键重复判定应命中缓存");
    let hits_before = cache.hit_ratio();
    // 不同会话（跨域 id 复用防护）不命中：结果应为本次闭包计算结果
    let other = cache.get_or_else("s2", 42, || Decision::NotInteractive);
    assert_eq!(
        other,
        Decision::NotInteractive,
        "跨会话应各自计算（不命中缓存）"
    );
    assert!(
        cache.hit_ratio() < hits_before || cache.hit_ratio() < 1.0,
        "跨会话不命中缓存"
    );
}

/// 子树探测：≤ max_depth 层内查找（M1/W2 探测语义）。
#[test]
fn subtree_probe_depth_limited() {
    struct T {
        id: i32,
        kids: Vec<T>,
    }
    let tree = T {
        id: 1,
        kids: vec![T {
            id: 2,
            kids: vec![T {
                id: 3,
                kids: vec![],
            }],
        }],
    };
    // 闭包输出生命周期无法与输入绑定（elision 推断为新生命周期），
    // 探测以函数项提供正确的生命周期约束
    fn kids_of(n: &T) -> &[T] {
        n.kids.as_slice()
    }
    assert!(
        subtree_probe(&tree, 3, &kids_of, &|n| n.id == 3),
        "3 层内应探测到 id=3"
    );
    // 深度不足时探测不到（max_depth=0 只查根）
    assert!(!subtree_probe(&tree, 0, &kids_of, &|n| n.id == 3));
    assert!(!subtree_probe(&tree, 1, &kids_of, &|n| n.id == 3));
}
