//! 坐标换算与缩放(18 §4 语义)。
//!
//! 纯函数模块:缩放目标选择、API↔物理双向换算、边界校验;
//! 全部输入输出为值类型,不依赖任何设备,单测覆盖见本模块 tests。
//!
//! 坐标系约定(18 §4.3):
//! - 物理坐标:以虚拟桌面左上角(`origin_x, origin_y`,可负)为原点的物理像素;
//! - API 坐标:以合成图左上角(0,0)为原点的缩放后像素空间;
//! - 换算因子:独立 X/Y(`fx = target_w / phys_w`,`fy = target_h / phys_h`),
//!   不保纵横比,容差选择下畸变 ≤2%。

/// XGA 缩放目标(4:3)
pub const XGA_W: u32 = 1024;
/// XGA 缩放目标
pub const XGA_H: u32 = 768;
/// WXGA 缩放目标(16:10)
pub const WXGA_W: u32 = 1280;
/// WXGA 缩放目标
pub const WXGA_H: u32 = 800;
/// FWXGA 缩放目标(约 16:9)
pub const FWXGA_W: u32 = 1366;
/// FWXGA 缩放目标
pub const FWXGA_H: u32 = 768;
/// 目标宽高比容差(18 §4.1:绝对值差 <0.02 视为命中)
pub const RATIO_TOLERANCE: f64 = 0.02;

/// 坐标点(物理像素或 API 像素,依语境而定)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Point {
    /// 横坐标
    pub x: i32,
    /// 纵坐标
    pub y: i32,
}

impl Point {
    /// 构造坐标点
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

/// 坐标换算错误(04 §4.4 错误码语义)
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CoordError {
    /// 坐标越界(tool.computer.coords_out_of_bounds)
    #[error("坐标越界(tool.computer.coords_out_of_bounds)")]
    CoordsOutOfBounds,
}

/// 缩放规格:虚拟桌面物理边界 + API 空间(缩放后)尺寸。
///
/// `origin_*` 为虚拟桌面左上角物理坐标(多显示器负坐标布局下可为负);
/// `target_*` 为 API 空间尺寸,未缩放时等于物理尺寸。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScaleSpec {
    /// 虚拟桌面左上角物理横坐标(可负)
    pub origin_x: i32,
    /// 虚拟桌面左上角物理纵坐标(可负)
    pub origin_y: i32,
    /// 虚拟桌面物理宽度
    pub phys_w: u32,
    /// 虚拟桌面物理高度
    pub phys_h: u32,
    /// API 空间宽度(缩放后)
    pub target_w: u32,
    /// API 空间高度(缩放后)
    pub target_h: u32,
}

impl ScaleSpec {
    /// 构造缩放规格;物理尺寸必须非零
    pub fn new(
        origin_x: i32,
        origin_y: i32,
        phys_w: u32,
        phys_h: u32,
        target_w: u32,
        target_h: u32,
    ) -> Self {
        debug_assert!(phys_w > 0 && phys_h > 0, "物理尺寸必须非零");
        Self {
            origin_x,
            origin_y,
            phys_w,
            phys_h,
            target_w,
            target_h,
        }
    }

    /// 横轴缩放因子(API 尺寸 / 物理尺寸)
    pub fn fx(&self) -> f64 {
        self.target_w as f64 / self.phys_w as f64
    }

    /// 纵轴缩放因子(API 尺寸 / 物理尺寸)
    pub fn fy(&self) -> f64 {
        self.target_h as f64 / self.phys_h as f64
    }

    /// API → 物理(注入前):`x_phys = round(x_api / fx) + origin_x`
    pub fn api_to_phys(&self, p: Point) -> Point {
        let x = (p.x as f64 / self.fx()).round() as i32 + self.origin_x;
        let y = (p.y as f64 / self.fy()).round() as i32 + self.origin_y;
        Point::new(x, y)
    }

    /// 物理 → API(cursor_position 与回显标注):`x_api = round((x_phys - origin_x) * fx)`
    pub fn phys_to_api(&self, p: Point) -> Point {
        let x = ((p.x - self.origin_x) as f64 * self.fx()).round() as i32;
        let y = ((p.y - self.origin_y) as f64 * self.fy()).round() as i32;
        Point::new(x, y)
    }

    /// API 空间边界校验(04 §4.4 校验链第 1 层):
    /// 非负整数且 `0 ≤ x ≤ target_w`、`0 ≤ y ≤ target_h`,越界返回错误
    pub fn validate_api(&self, p: Point) -> Result<Point, CoordError> {
        if p.x < 0
            || p.y < 0
            || p.x > self.target_w as i32
            || p.y > self.target_h as i32
        {
            Err(CoordError::CoordsOutOfBounds)
        } else {
            Ok(p)
        }
    }

    /// 物理空间回检钳制(04 §4.4 校验链第 2 层):
    /// 防缩放舍入越界 1px 时钳制到物理边界内(调用方负责记审计)
    pub fn clamp_phys(&self, p: Point) -> Point {
        let x = p.x.clamp(
            self.origin_x,
            self.origin_x + self.phys_w as i32,
        );
        let y = p.y.clamp(
            self.origin_y,
            self.origin_y + self.phys_h as i32,
        );
        Point::new(x, y)
    }
}

/// 缩放目标选择(18 §4.1):
/// 按序检查 [XGA, WXGA, FWXGA],取首个「宽高比差 <0.02 且目标宽 < 物理宽」;
/// 未命中返回物理尺寸(不缩放,避免超宽屏强制拉伸畸变)。
pub fn choose_target(phys_w: u32, phys_h: u32) -> (u32, u32) {
    let ratio = phys_w as f64 / phys_h as f64;
    let candidates = [
        (XGA_W, XGA_H),
        (WXGA_W, WXGA_H),
        (FWXGA_W, FWXGA_H),
    ];
    for (tw, th) in candidates {
        let target_ratio = tw as f64 / th as f64;
        if (target_ratio - ratio).abs() < RATIO_TOLERANCE && tw < phys_w {
            return (tw, th);
        }
    }
    (phys_w, phys_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 往返一致性断言:对给定 API 点做 物理→API→物理 双向换算,误差 ≤1px
    fn assert_roundtrip(scale: &ScaleSpec, api: Point) {
        let phys = scale.api_to_phys(api);
        let back = scale.phys_to_api(phys);
        assert!(
            (back.x - api.x).unsigned_abs() <= 1
                && (back.y - api.y).unsigned_abs() <= 1,
            "往返误差超 1px: api={api:?} phys={phys:?} back={back:?}"
        );
    }

    /// 网格采样:从原点起每隔 97px 采一个点(避开整除数对齐,覆盖舍入路径)
    fn assert_roundtrip_grid(scale: &ScaleSpec) {
        let mut x = 0;
        while x <= scale.target_w as i32 {
            let mut y = 0;
            while y <= scale.target_h as i32 {
                assert_roundtrip(scale, Point::new(x, y));
                y += 97;
            }
            x += 97;
        }
    }

    #[test]
    fn scale_target_4x3_chooses_xga() {
        // 1600×1200(4:3)→ XGA 1024×768
        assert_eq!(choose_target(1600, 1200), (XGA_W, XGA_H));
    }

    #[test]
    fn scale_target_16x10_chooses_wxga() {
        // 1920×1200(16:10)→ WXGA 1280×800
        assert_eq!(choose_target(1920, 1200), (WXGA_W, WXGA_H));
    }

    #[test]
    fn scale_target_16x9_chooses_fwxga() {
        // 2560×1440(≈16:9,37 报告实测环境)→ FWXGA 1366×768
        assert_eq!(choose_target(2560, 1440), (FWXGA_W, FWXGA_H));
    }

    #[test]
    fn scale_target_ultrawide_no_scale() {
        // 21:9 超宽屏:三档目标均不命中 → 不缩放
        assert_eq!(choose_target(3440, 1440), (3440, 1440));
    }

    #[test]
    fn scale_only_down_keeps_original() {
        // 只缩不升:物理分辨率不大于任何目标时保持原尺寸
        assert_eq!(choose_target(1024, 768), (1024, 768));
        assert_eq!(choose_target(1366, 768), (1366, 768));
        assert_eq!(choose_target(800, 600), (800, 600));
    }

    #[test]
    fn coord_roundtrip_dpi_100() {
        // DPI 100%:物理 1920×1080 → FWXGA
        let scale = ScaleSpec::new(0, 0, 1920, 1080, 1366, 768);
        assert_roundtrip_grid(&scale);
    }

    #[test]
    fn coord_roundtrip_dpi_125() {
        // DPI 125%:物理 2560×1440 → FWXGA(37 报告本机环境)
        let scale = ScaleSpec::new(0, 0, 2560, 1440, 1366, 768);
        assert_roundtrip_grid(&scale);
    }

    #[test]
    fn coord_roundtrip_dpi_150() {
        // DPI 150%:物理 2880×1620 → FWXGA
        let scale = ScaleSpec::new(0, 0, 2880, 1620, 1366, 768);
        assert_roundtrip_grid(&scale);
    }

    #[test]
    fn coord_roundtrip_dual_monitor_negative_origin() {
        // 双屏负坐标:[-1920,0]+[0,0] 并排,虚拟桌面左上角 (-1920,0);
        // 合成图 3840×1080 超宽 → 不缩放(fx=fy=1)
        let scale = ScaleSpec::new(-1920, 0, 3840, 1080, 3840, 1080);
        // 物理 (-100,300) → API (1820,300) → 物理 (-100,300)
        assert_eq!(scale.phys_to_api(Point::new(-100, 300)), Point::new(1820, 300));
        assert_eq!(scale.api_to_phys(Point::new(1820, 300)), Point::new(-100, 300));
        assert_roundtrip_grid(&scale);
    }

    #[test]
    fn coord_roundtrip_scaled_with_negative_origin() {
        // 缩放 + 负原点组合:原点 (-100,-50),物理 2560×1440 → FWXGA
        let scale = ScaleSpec::new(-100, -50, 2560, 1440, 1366, 768);
        assert_eq!(scale.api_to_phys(Point::new(0, 0)), Point::new(-100, -50));
        assert_eq!(scale.phys_to_api(Point::new(-100, -50)), Point::new(0, 0));
        assert_roundtrip_grid(&scale);
    }

    #[test]
    fn coord_out_of_bounds_returns_error() {
        let scale = ScaleSpec::new(0, 0, 2560, 1440, 1366, 768);
        // 越界:负坐标与超出目标宽高
        assert_eq!(
            scale.validate_api(Point::new(-1, 0)),
            Err(CoordError::CoordsOutOfBounds)
        );
        assert_eq!(
            scale.validate_api(Point::new(0, -1)),
            Err(CoordError::CoordsOutOfBounds)
        );
        assert_eq!(
            scale.validate_api(Point::new(1367, 0)),
            Err(CoordError::CoordsOutOfBounds)
        );
        assert_eq!(
            scale.validate_api(Point::new(0, 769)),
            Err(CoordError::CoordsOutOfBounds)
        );
        // 边界内合法(含右/下边界值,04 §4.4 允许 ≤)
        assert!(scale.validate_api(Point::new(0, 0)).is_ok());
        assert!(scale.validate_api(Point::new(1366, 768)).is_ok());
    }

    #[test]
    fn coord_phys_clamp() {
        // 虚拟桌面跨度 [-100, -100+2560) = [-100, 2460],钳制上下界随原点平移
        let scale = ScaleSpec::new(-100, 0, 2560, 1440, 1366, 768);
        assert_eq!(scale.clamp_phys(Point::new(3000, -20)), Point::new(2460, 0));
        assert_eq!(scale.clamp_phys(Point::new(-500, 500)), Point::new(-100, 500));
        // 边界内原样返回
        assert_eq!(scale.clamp_phys(Point::new(100, 100)), Point::new(100, 100));
    }
}
