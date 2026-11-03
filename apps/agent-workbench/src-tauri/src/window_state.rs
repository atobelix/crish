//! 窗口几何持久化（F3：桌面端交互审计 2026-11-02）。
//!
//! # 路线与取舍
//! 官方 `tauri-plugin-window-state` 承担存/取：状态文件落在
//! `app_config_dir()/.window-state.json`（插件默认名），内容 = 主窗口的
//! 尺寸 / 位置 / 最大化三项；插件在窗口 ready 时恢复、在 Moved/Resized
//! 事件中追踪、在 CloseRequested 时定格、RunEvent::Exit 时落盘。
//! - **只追踪主窗口**：`with_filter` 按 label 过滤。会话子窗口由前端以
//!   显式 1200×820 创建并自管显现（crish-desktop `sidebarHelpers.
//!   openSessionInNewWindow`），其几何是前端的产品口径，不得被插件按
//!   label 恢复覆盖，也不应把动态 label 写进状态文件；
//! - **StateFlags 只取 SIZE | POSITION | MAXIMIZED**：VISIBLE 入旗标时
//!   插件会在 restore 时直接 `show()`，绕过 ACT-101 首绘握手（白闪
//!   回归 + 抢焦点），故排除——显现时机仍由 window_handshake 统一
//!   裁决；DECORATIONS 排除（conf 的 `decorations: false` 恒为准，防
//!   旧存档把原生装饰带回）；FULLSCREEN 不在本批范围；
//! - **坏存档安全回退**：插件 setup 读档失败（文件损坏 / 结构不符）走
//!   `unwrap_or_default` 空缓存 → 窗口保持 conf 默认几何（1320×880），
//!   不崩；首启无存档同理，首次体验不变；
//! - **前端零接线**：插件的 JS 命令面（save/restore）不授予 capability
//!   （前端从不调用），权限维持最小集。
//!
//! # 本模块自有部分：恢复后可见性钳制
//! 插件 restore 自带的离屏防护只查「窗口四角是否有一角落在任一显示器
//! 内」——显示器拔除 / 分辨率变化后，窗口大半截在屏外仍会被原样放行。
//! 本模块在 setup 期（窗口尚未显现，钳制无闪烁）复查主窗口外接矩形与
//! 各显示器**工作区**的交叠：可见面积 < 30%，或顶部 40px 拖拽带可见
//! 宽度 < 50%（标题区抓不住 = 实际不可达）时，把窗口完整钳回主屏
//! 工作区。跨屏横跨摆放只要可见比例达标不干预；最大化窗口天然贴合
//! 所在显示器，跳过。

use tauri::{PhysicalPosition, Runtime, WebviewWindow};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use crate::window_handshake::MAIN_WINDOW_LABEL;

/// 构造 window-state 插件（注册点见 main.rs Builder 链；单实例插件仍须
/// 最先注册，本插件顺序无约束）。
pub(crate) fn register<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    WindowStateBuilder::new()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .with_filter(|label| label == MAIN_WINDOW_LABEL)
        .build()
}

/// 顶部拖拽带高度（物理 px）：自绘标题栏的抓握区，这条带须可达。
const TITLE_STRIP_HEIGHT: i32 = 40;
/// 可见面积下限（千分数：300 = 30%），低于此判为落屏外。
const MIN_VISIBLE_PERMILLE: i64 = 300;

/// 物理像素矩形（钳制纯函数面，独立于 Tauri 类型以便单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Rect {
    fn area(self) -> i64 {
        i64::from(self.width.max(0)) * i64::from(self.height.max(0))
    }

    fn intersection(self, other: Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        if right > x && bottom > y {
            Some(Rect {
                x,
                y,
                width: right - x,
                height: bottom - y,
            })
        } else {
            None
        }
    }
}

/// 窗口在全部工作区上的可见面积（工作区互不重叠，直接求和）。
fn visible_area(window: Rect, work_areas: &[Rect]) -> i64 {
    work_areas
        .iter()
        .map(|wa| window.intersection(*wa).map_or(0, Rect::area))
        .sum()
}

/// 是否需要钳制：总可见面积 < 30%，或顶部拖拽带可见宽度 < 50%。
fn needs_clamp(window: Rect, work_areas: &[Rect]) -> bool {
    if work_areas.is_empty() || window.area() == 0 {
        return false;
    }
    if visible_area(window, work_areas) * 1000 < window.area() * MIN_VISIBLE_PERMILLE {
        return true;
    }
    let strip = Rect {
        height: TITLE_STRIP_HEIGHT.min(window.height),
        ..window
    };
    let strip_visible_width: i32 = work_areas
        .iter()
        .filter_map(|wa| strip.intersection(*wa))
        .map(|r| r.width)
        .sum();
    strip_visible_width * 2 < strip.width
}

/// 把窗口位置钳进目标工作区（尺寸不变；窗口比工作区大时贴左上）。
fn clamped_position(window: Rect, work_area: Rect) -> PhysicalPosition<i32> {
    let x = if window.width >= work_area.width {
        work_area.x
    } else {
        window
            .x
            .clamp(work_area.x, work_area.x + work_area.width - window.width)
    };
    let y = if window.height >= work_area.height {
        work_area.y
    } else {
        window
            .y
            .clamp(work_area.y, work_area.y + work_area.height - window.height)
    };
    PhysicalPosition::new(x, y)
}

/// 恢复后可见性钳制（setup 期调用：插件已在 window-ready 时恢复几何，
/// 窗口尚未显现，此处钳制用户无感）。
pub(crate) fn clamp_main_window_into_view(window: &WebviewWindow) {
    match window.is_maximized() {
        Ok(true) => return, // 最大化窗口贴合所在显示器，无离屏问题
        Ok(false) => {}
        Err(error) => {
            tracing::warn!(target: "window", error = %error, "窗口几何钳制跳过：最大化状态读取失败");
            return;
        }
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        tracing::warn!(target: "window", "窗口几何钳制跳过：外接几何读取失败");
        return;
    };
    let win = Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    };
    let work_areas: Vec<Rect> = match window.available_monitors() {
        Ok(monitors) => monitors
            .iter()
            .map(|m| {
                let wa = m.work_area();
                Rect {
                    x: wa.position.x,
                    y: wa.position.y,
                    width: wa.size.width as i32,
                    height: wa.size.height as i32,
                }
            })
            .collect(),
        Err(error) => {
            tracing::warn!(target: "window", error = %error, "窗口几何钳制跳过：显示器枚举失败");
            return;
        }
    };
    if !needs_clamp(win, &work_areas) {
        return;
    }
    let primary_area = match window.primary_monitor() {
        Ok(Some(monitor)) => {
            let wa = monitor.work_area();
            Rect {
                x: wa.position.x,
                y: wa.position.y,
                width: wa.size.width as i32,
                height: wa.size.height as i32,
            }
        }
        _ => match work_areas.first() {
            Some(area) => *area,
            None => return,
        },
    };
    let target = clamped_position(win, primary_area);
    match window.set_position(target) {
        Ok(()) => tracing::info!(
            target: "window",
            from_x = win.x,
            from_y = win.y,
            to_x = target.x,
            to_y = target.y,
            "恢复几何大半落于可见区外，已钳回主屏工作区（显示器拓扑变化兜底）"
        ),
        Err(error) => {
            tracing::warn!(target: "window", error = %error, "窗口几何钳制失败：set_position 报错")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 主屏工作区（1920×1080 屏扣 40px 任务栏）。
    const PRIMARY: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    /// 右侧副屏工作区（负坐标在左侧的情形由 clamped_position 用例覆盖）。
    const SECONDARY: Rect = Rect {
        x: 1920,
        y: 0,
        width: 1600,
        height: 860,
    };

    #[test]
    fn intersection_handles_negative_coordinates() {
        let a = Rect {
            x: -100,
            y: -50,
            width: 300,
            height: 200,
        };
        let b = Rect {
            x: 0,
            y: 0,
            width: 500,
            height: 500,
        };
        assert_eq!(
            a.intersection(b),
            Some(Rect {
                x: 0,
                y: 0,
                width: 200,
                height: 150
            })
        );
        assert_eq!(a.intersection(Rect { x: 1000, y: 1000, width: 10, height: 10 }), None);
    }

    #[test]
    fn fully_visible_window_needs_no_clamp() {
        let win = Rect {
            x: 100,
            y: 80,
            width: 1320,
            height: 880,
        };
        assert!(!needs_clamp(win, &[PRIMARY, SECONDARY]));
    }

    #[test]
    fn window_on_removed_monitor_needs_clamp() {
        // 副屏已拔除：存档位置整窗落在不存在的显示器上
        let win = Rect {
            x: 2000,
            y: 100,
            width: 1320,
            height: 880,
        };
        assert!(needs_clamp(win, &[PRIMARY]));
    }

    #[test]
    fn mostly_off_right_edge_needs_clamp() {
        // 仅剩左缘约 12% 在主屏内：插件的四角检查会放行（左上角在屏内），本钳制拦截
        let win = Rect {
            x: 1760,
            y: 60,
            width: 1320,
            height: 880,
        };
        assert!(needs_clamp(win, &[PRIMARY]));
    }

    #[test]
    fn straddling_window_with_enough_visible_area_passes() {
        // 横跨双屏：可见面积 100%、拖拽带全可见 → 不干预用户的跨屏摆放
        let win = Rect {
            x: 1500,
            y: 40,
            width: 1200,
            height: 800,
        };
        assert!(!needs_clamp(win, &[PRIMARY, SECONDARY]));
    }

    #[test]
    fn title_strip_above_screen_needs_clamp_even_if_body_visible() {
        // 窗口被推到上方：主体可见约 55%，但顶部拖拽带整条在屏外（抓不住）
        let win = Rect {
            x: 100,
            y: -500,
            width: 1320,
            height: 880,
        };
        // 工作区从 y=0 起：可见 = 380/880 ≈ 43% > 30%，面积判据不触发；
        // 拖拽带（y -500..-460）可见宽度 0 → 由拖拽带判据触发
        assert!(needs_clamp(win, &[PRIMARY]));
    }

    #[test]
    fn clamped_position_fits_inside_work_area() {
        let win = Rect {
            x: 5000,
            y: 3000,
            width: 1320,
            height: 880,
        };
        let pos = clamped_position(win, PRIMARY);
        assert_eq!(pos, PhysicalPosition::new(600, 160));
    }

    #[test]
    fn clamped_position_oversized_window_aligns_top_left() {
        let win = Rect {
            x: 300,
            y: 200,
            width: 2560,
            height: 1440,
        };
        let pos = clamped_position(win, PRIMARY);
        assert_eq!(pos, PhysicalPosition::new(0, 0));
    }

    #[test]
    fn clamped_position_respects_negative_origin_monitor() {
        let left_monitor = Rect {
            x: -1600,
            y: 0,
            width: 1600,
            height: 860,
        };
        let win = Rect {
            x: -4000,
            y: 100,
            width: 1200,
            height: 800,
        };
        let pos = clamped_position(win, left_monitor);
        assert_eq!(pos, PhysicalPosition::new(-1600, 60));
    }
}
