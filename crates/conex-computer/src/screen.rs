//! 截屏感知(37 报告 Gate-A 实证落点)。
//!
//! xcap 0.9.7 截屏(WGC 优先 / GDI 兜底,feature `capture-wgc` 门控)+
//! CatmullRom 缩放档 + PNG 输出;布局表按 18 §4.3 语义(虚拟桌面原点可负)。
//!
//! 纯函数(布局构造/合成缩放编码)与设备面(截屏)分离:
//! `layout_from_raw` / `compose_scale_encode` 可注入 mock 帧单测。

use std::io::Cursor;

use xcap::image::{
    imageops, DynamicImage, ImageBuffer, ImageFormat, Rgba, RgbaImage,
};

use crate::coord::{choose_target, ScaleSpec};

/// 截屏失败重试次数(WGC 初始化/桌面合成抖动,37 报告 outlier 防护)
pub const CAPTURE_RETRY: usize = 3;
/// 重试间隔毫秒
pub const CAPTURE_RETRY_DELAY_MS: u64 = 100;

/// 布局表条目(18 §4.3 Monitors[]:物理几何 + DPI + 缩放后图像尺寸)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MonitorInfo {
    /// 显示器编号(xcap Monitor::id)
    pub id: u32,
    /// 物理横坐标(虚拟桌面原点,可负)
    pub x: i32,
    /// 物理纵坐标(虚拟桌面原点,可负)
    pub y: i32,
    /// 物理宽度
    pub w: u32,
    /// 物理高度
    pub h: u32,
    /// DPI 缩放系数(1.0/1.25/1.5...)
    pub dpi_scale: f64,
    /// 缩放后图像宽度(API 空间)
    pub image_w: u32,
    /// 缩放后图像高度(API 空间)
    pub image_h: u32,
}

/// 布局表:虚拟桌面物理边界 + 显示器清单
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DesktopLayout {
    /// 显示器清单
    pub monitors: Vec<MonitorInfo>,
    /// 虚拟桌面左上角物理横坐标(可负)
    pub origin_x: i32,
    /// 虚拟桌面左上角物理纵坐标(可负)
    pub origin_y: i32,
    /// 虚拟桌面物理宽度
    pub phys_w: u32,
    /// 虚拟桌面物理高度
    pub phys_h: u32,
}

/// 截屏产物(FrameOut 语义:字节 + 缩放后尺寸)
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    /// 帧序号(感知版本推进面)
    pub seq: u64,
    /// API 空间宽度(缩放后)
    pub width: u32,
    /// API 空间高度(缩放后)
    pub height: u32,
    /// PNG 编码字节
    pub data: Vec<u8>,
}

impl DesktopLayout {
    /// 由布局表构造坐标换算规格(目标尺寸经 choose_target 计算)
    pub fn to_scale_spec(&self) -> ScaleSpec {
        let (tw, th) = choose_target(self.phys_w, self.phys_h);
        ScaleSpec::new(
            self.origin_x,
            self.origin_y,
            self.phys_w,
            self.phys_h,
            tw,
            th,
        )
    }
}

/// 原始显示器几何(设备面查询结果的抽象输入,测试可 mock)
#[derive(Debug, Clone, Copy)]
pub struct RawMonitor {
    /// 显示器编号
    pub id: u32,
    /// 物理横坐标
    pub x: i32,
    /// 物理纵坐标
    pub y: i32,
    /// 物理宽度
    pub w: u32,
    /// 物理高度
    pub h: u32,
    /// DPI 缩放系数
    pub dpi_scale: f64,
}

/// 纯函数:由原始显示器几何构造布局表。
/// 虚拟桌面边界 = 各屏包围盒;`image_w/h` 按整体缩放因子折算。
/// 无显示器时返回 `None`。
pub fn layout_from_raw(monitors: &[RawMonitor]) -> Option<DesktopLayout> {
    if monitors.is_empty() {
        return None;
    }
    let min_x = monitors.iter().map(|m| m.x).min()?;
    let min_y = monitors.iter().map(|m| m.y).min()?;
    let max_x = monitors
        .iter()
        .map(|m| m.x + m.w as i32)
        .max()?;
    let max_y = monitors
        .iter()
        .map(|m| m.y + m.h as i32)
        .max()?;
    let phys_w = (max_x - min_x) as u32;
    let phys_h = (max_y - min_y) as u32;
    let (tw, th) = choose_target(phys_w, phys_h);
    let fx = tw as f64 / phys_w as f64;
    let fy = th as f64 / phys_h as f64;
    let monitors = monitors
        .iter()
        .map(|m| MonitorInfo {
            id: m.id,
            x: m.x,
            y: m.y,
            w: m.w,
            h: m.h,
            dpi_scale: m.dpi_scale,
            image_w: (m.w as f64 * fx).round() as u32,
            image_h: (m.h as f64 * fy).round() as u32,
        })
        .collect();
    Some(DesktopLayout {
        monitors,
        origin_x: min_x,
        origin_y: min_y,
        phys_w,
        phys_h,
    })
}

/// 纯函数:多屏帧合成 + CatmullRom 缩放 + PNG 编码。
///
/// `frames` 元素为 (物理 x, 物理 y, 帧缓冲);按物理偏移平移到合成画布
/// (画布原点 = 虚拟桌面左上角),再整体缩放到目标档位。
/// 测试可直接注入 mock 帧(任意尺寸须与布局表物理尺寸一致)。
pub fn compose_scale_encode(
    frames: &[(i32, i32, RgbaImage)],
    layout: &DesktopLayout,
) -> Result<Vec<u8>, String> {
    let (tw, th) = choose_target(layout.phys_w, layout.phys_h);
    let mut canvas = ImageBuffer::from_pixel(
        layout.phys_w,
        layout.phys_h,
        Rgba([0u8, 0u8, 0u8, 255u8]),
    );
    for (x, y, img) in frames {
        let dx = (x - layout.origin_x) as i64;
        let dy = (y - layout.origin_y) as i64;
        imageops::replace(&mut canvas, img, dx, dy);
    }
    let resized = imageops::resize(&canvas, tw, th, imageops::FilterType::CatmullRom);
    let mut buf = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(resized)
        .write_to(&mut buf, ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(buf.into_inner())
}

/// 截屏设备面(xcap 0.9.7;WGC/GDI 由 feature 门控,代码无分支)
#[cfg(windows)]
pub struct ScreenCapture {
    layout: DesktopLayout,
    seq: u64,
}

#[cfg(windows)]
impl ScreenCapture {
    /// 初始化:查询布局表
    pub fn new() -> Result<Self, String> {
        let layout = Self::query_layout()?;
        Ok(Self { layout, seq: 0 })
    }

    /// 当前布局表
    pub fn layout(&self) -> &DesktopLayout {
        &self.layout
    }

    /// 查询布局表(xcap Monitor::all,字段与 37 报告 1.3 实测一致)
    fn query_layout() -> Result<DesktopLayout, String> {
        let monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
        let raw: Vec<RawMonitor> = monitors
            .iter()
            .map(|m| {
                Ok(RawMonitor {
                    id: m.id().map_err(|e| format!("读取显示器 id 失败: {e}"))?,
                    x: m.x().map_err(|e| format!("读取显示器 x 失败: {e}"))?,
                    y: m.y().map_err(|e| format!("读取显示器 y 失败: {e}"))?,
                    w: m.width().map_err(|e| format!("读取显示器宽失败: {e}"))?,
                    h: m.height().map_err(|e| format!("读取显示器高失败: {e}"))?,
                    dpi_scale: m
                        .scale_factor()
                        .map_err(|e| format!("读取 DPI 失败: {e}"))?
                        as f64,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        layout_from_raw(&raw).ok_or_else(|| "无可用显示器".to_string())
    }

    /// 截屏(带重试):WGC 初始化/桌面合成抖动用重试吸收(37 报告 S0 遗留项 1)
    pub fn capture(&mut self) -> Result<CapturedFrame, String> {
        let mut last_err = None;
        for attempt in 0..=CAPTURE_RETRY {
            match self.capture_once() {
                Ok(frame) => return Ok(frame),
                Err(e) => {
                    tracing::warn!(attempt, error = %e, "截屏失败,重试");
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(
                        CAPTURE_RETRY_DELAY_MS,
                    ));
                }
            }
        }
        Err(format!(
            "截屏失败({} 次重试): {}",
            CAPTURE_RETRY,
            last_err.unwrap_or_default()
        ))
    }

    /// 单次截屏:刷新布局(热插拔自愈)→ 逐屏捕获 → 合成缩放编码
    fn capture_once(&mut self) -> Result<CapturedFrame, String> {
        self.layout = Self::query_layout()?;
        let monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
        let mut frames = Vec::new();
        for m in &monitors {
            let img = m
                .capture_image()
                .map_err(|e| format!("捕获显示器失败: {e}"))?;
            frames.push((m.x().map_err(|e| format!("读取显示器 x 失败: {e}"))?, 
                         m.y().map_err(|e| format!("读取显示器 y 失败: {e}"))?, img));
        }
        let png = compose_scale_encode(&frames, &self.layout)?;
        let (tw, th) = choose_target(self.layout.phys_w, self.layout.phys_h);
        self.seq += 1;
        Ok(CapturedFrame {
            seq: self.seq,
            width: tw,
            height: th,
            data: png,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_single(w: u32, h: u32, dpi: f64) -> Vec<RawMonitor> {
        vec![RawMonitor {
            id: 1,
            x: 0,
            y: 0,
            w,
            h,
            dpi_scale: dpi,
        }]
    }

    #[test]
    fn layout_single_monitor_dpi_125() {
        // 37 报告环境:单屏 2560×1440 @125% → FWXGA 1366×768
        let layout = layout_from_raw(&raw_single(2560, 1440, 1.25)).expect("布局构造失败");
        assert_eq!(layout.origin_x, 0);
        assert_eq!(layout.origin_y, 0);
        assert_eq!(layout.phys_w, 2560);
        assert_eq!(layout.phys_h, 1440);
        assert_eq!(layout.monitors.len(), 1);
        let m = &layout.monitors[0];
        assert_eq!(m.dpi_scale, 1.25);
        // 缩放后图像尺寸:Fwxga 1366×768
        assert_eq!(m.image_w, 1366);
        assert_eq!(m.image_h, 768);
        let spec = layout.to_scale_spec();
        assert_eq!(spec.target_w, 1366);
        assert_eq!(spec.target_h, 768);
    }

    #[test]
    fn layout_dual_monitor_negative_origin() {
        // 双屏负坐标:[-1920,0,1920,1080] + [0,0,1920,1080]
        let raw = vec![
            RawMonitor { id: 1, x: -1920, y: 0, w: 1920, h: 1080, dpi_scale: 1.0 },
            RawMonitor { id: 2, x: 0, y: 0, w: 1920, h: 1080, dpi_scale: 1.0 },
        ];
        let layout = layout_from_raw(&raw).expect("布局构造失败");
        assert_eq!(layout.origin_x, -1920);
        assert_eq!(layout.origin_y, 0);
        assert_eq!(layout.phys_w, 3840);
        assert_eq!(layout.phys_h, 1080);
        assert_eq!(layout.monitors.len(), 2);
        // 超宽(ratio 3.56)不缩放 → image 尺寸 = 物理尺寸
        assert_eq!(layout.monitors[0].image_w, 1920);
        assert_eq!(layout.monitors[1].x, 0);
    }

    #[test]
    fn layout_empty_monitors_none() {
        assert!(layout_from_raw(&[]).is_none());
    }

    #[test]
    fn compose_scale_encode_roundtrip() {
        // 双屏并排 800×1000(总 1600×1000,ratio 1.6 → WXGA 1280×800 缩放命中)
        let raw = vec![
            RawMonitor { id: 1, x: -800, y: 0, w: 800, h: 1000, dpi_scale: 1.0 },
            RawMonitor { id: 2, x: 0, y: 0, w: 800, h: 1000, dpi_scale: 1.0 },
        ];
        let layout = layout_from_raw(&raw).expect("布局构造失败");
        assert_eq!(layout.to_scale_spec().target_w, 1280);
        assert_eq!(layout.to_scale_spec().target_h, 800);

        // 左屏纯红、右屏纯绿(物理坐标注入)
        let red = ImageBuffer::from_pixel(800, 1000, Rgba([255u8, 0u8, 0u8, 255u8]));
        let green = ImageBuffer::from_pixel(800, 1000, Rgba([0u8, 255u8, 0u8, 255u8]));
        let frames = vec![(-800, 0, red), (0, 0, green)];
        let png = compose_scale_encode(&frames, &layout).expect("合成失败");

        // PNG 签名与可解码性
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        let decoded = image::load_from_memory(&png).expect("PNG 解码失败");
        assert_eq!(decoded.width(), 1280);
        assert_eq!(decoded.height(), 800);

        // 颜色采样:左半中心偏红、右半中心偏绿(缩放后纯色内部保持)
        let rgb = decoded.to_rgb8();
        let left = rgb.get_pixel(320, 400);
        let right = rgb.get_pixel(960, 400);
        assert!(left.0[0] > 200 && left.0[1] < 60, "左半应偏红, 实得 {left:?}");
        assert!(right.0[1] > 200 && right.0[0] < 60, "右半应偏绿, 实得 {right:?}");
    }

    #[test]
    fn compose_scale_encode_no_scale_keeps_size() {
        // 超宽不缩放:合成尺寸 = 物理尺寸
        let raw = vec![RawMonitor { id: 1, x: 0, y: 0, w: 3440, h: 1440, dpi_scale: 1.0 }];
        let layout = layout_from_raw(&raw).expect("布局构造失败");
        assert_eq!(layout.to_scale_spec().target_w, 3440);
        let img = ImageBuffer::from_pixel(3440, 1440, Rgba([10u8, 20u8, 30u8, 255u8]));
        let png = compose_scale_encode(&[(0, 0, img)], &layout).expect("合成失败");
        let decoded = image::load_from_memory(&png).expect("PNG 解码失败");
        assert_eq!((decoded.width(), decoded.height()), (3440, 1440));
    }

    #[test]
    fn tempfile_png_persist_roundtrip() {
        // 编码产物落盘(与面板/审计落盘面同构)可读回
        let raw = vec![RawMonitor { id: 1, x: 0, y: 0, w: 1600, h: 1000, dpi_scale: 1.0 }];
        let layout = layout_from_raw(&raw).expect("布局构造失败");
        let img = ImageBuffer::from_pixel(1600, 1000, Rgba([7u8, 8u8, 9u8, 255u8]));
        let png = compose_scale_encode(&[(0, 0, img)], &layout).expect("合成失败");
        let dir = tempfile::tempdir().expect("临时目录创建失败");
        let path = dir.path().join("frame.png");
        std::fs::write(&path, &png).expect("落盘失败");
        let bytes = std::fs::read(&path).expect("读回失败");
        assert_eq!(bytes, png);
        let decoded = image::load_from_memory(&bytes).expect("读回解码失败");
        assert_eq!(decoded.width(), 1280);
    }
}
