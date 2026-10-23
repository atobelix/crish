//! 主机打开器与应用程序系统自带图标提取模块。
//!
//! 在 Windows 系统上利用 Shell 原生 API (`SHGetFileInfoW`) 提取可执行文件、快捷方式
//! (`.lnk`) 及系统文件资源管理器 (`explorer.exe`) 的真实图标。
//! 针对快捷方式解析真实 TargetPath 剔除快捷方式小箭头，并利用纯 Rust 输出标准的
//! 32 位 RGBA 透明 PNG Data URL，确保零黑色背景、平滑圆角反走样，与系统开始菜单/任务栏完全一致。
//! 非 Windows 平台安全平滑降级（返回 `None`）。

use std::path::Path;

#[cfg(windows)]
mod platform {
    #![allow(unsafe_code)] // 受控 Win32 Shell & GDI FFI：获取 HICON 提取位图像素并保证句柄即时释放

    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::RwLock;

    use base64::Engine;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    // 全局内存级图标缓存（路径规范化 -> Data URL），避免打开菜单时重复 Win32 I/O
    static ICON_CACHE: RwLock<Option<HashMap<PathBuf, String>>> = RwLock::new(None);

    pub(crate) fn extract_icon_data_url(path: &Path) -> Option<String> {
        let canonical_key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // 读缓存
        if let Ok(guard) = ICON_CACHE.read() {
            if let Some(cache) = guard.as_ref() {
                if let Some(url) = cache.get(&canonical_key) {
                    return Some(url.clone());
                }
            }
        }

        // 解析最佳目标路径（如解析 .lnk 指向的真实 exe，或向上查找 .cmd 包装器背后的主程序）
        let target_path = resolve_best_icon_target(path);

        let data_url = extract_icon_from_target(&target_path)?;

        // 写缓存
        if let Ok(mut guard) = ICON_CACHE.write() {
            let cache = guard.get_or_insert_with(HashMap::new);
            cache.insert(canonical_key, data_url.clone());
        }

        Some(data_url)
    }

    /// 解析最佳目标路径：
    /// 1. 若为 .lnk 快捷方式，解析出实际 TargetPath（避免合成快捷方式小箭头，直接拿原生程序图标）；
    /// 2. 若为 .cmd/.bat（如 PATH 中的 cursor.cmd），递归向上祖先目录查找同名或主程序 .exe。
    fn resolve_best_icon_target(path: &Path) -> PathBuf {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        // 1. 若为 .lnk 快捷方式，解析实际 TargetPath
        if ext == "lnk" {
            if let Some(target) = resolve_lnk_target(path) {
                if target.is_file() {
                    return target;
                }
            }
        }

        // 2. 若为 .cmd 或 .bat 脚本包装器（如 cursor.cmd / code.cmd）
        if ext == "cmd" || ext == "bat" {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            // 2.1 同目录下是否存在同名 exe
            let same_dir_exe = path.with_extension("exe");
            if same_dir_exe.is_file() {
                return same_dir_exe;
            }
            // 2.2 向上逐级（最多 4 级）在祖先目录中查找主程序 exe
            let mut curr = path.parent();
            for _ in 0..4 {
                let Some(dir) = curr else { break };
                let candidate_exe = dir.join(format!("{stem}.exe"));
                if candidate_exe.is_file() {
                    return candidate_exe;
                }
                // 尝试首字母大写（如 Cursor.exe, Code.exe, Zed.exe）
                let mut capitalized = stem.to_string();
                if let Some(first) = capitalized.get_mut(0..1) {
                    first.make_ascii_uppercase();
                }
                let cap_exe = dir.join(format!("{capitalized}.exe"));
                if cap_exe.is_file() {
                    return cap_exe;
                }
                curr = dir.parent();
            }
        }

        path.to_path_buf()
    }

    /// 纯内存二进制解析 Windows .lnk 快捷方式中的真实目标路径（零 COM 依赖，纳秒级解析）
    fn resolve_lnk_target(path: &Path) -> Option<PathBuf> {
        let data = std::fs::read(path).ok()?;
        if data.len() < 76 || data[0..4] != [0x4c, 0x00, 0x00, 0x00] {
            return None;
        }
        let flags = u32::from_le_bytes(data[0x14..0x18].try_into().ok()?);
        let mut offset = 76usize;
        if (flags & 0x01) != 0 {
            // HasLinkTargetIDList
            if offset + 2 > data.len() {
                return None;
            }
            let id_list_size =
                u16::from_le_bytes(data[offset..offset + 2].try_into().ok()?) as usize;
            offset += 2 + id_list_size;
        }
        if (flags & 0x02) != 0 {
            // HasLinkInfo
            if offset + 28 > data.len() {
                return None;
            }
            let link_info = &data[offset..];
            let link_info_size = u32::from_le_bytes(link_info[0..4].try_into().ok()?) as usize;
            if link_info.len() < link_info_size {
                return None;
            }
            let header_size = u32::from_le_bytes(link_info[4..8].try_into().ok()?) as usize;
            // 优先读取 Unicode 绝对路径 (Offset 0x1C)
            if header_size >= 36 {
                let unicode_offset =
                    u32::from_le_bytes(link_info[28..32].try_into().ok()?) as usize;
                if unicode_offset < link_info_size {
                    let bytes = &link_info[unicode_offset..link_info_size];
                    let u16s: Vec<u16> = bytes
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .take_while(|&c| c != 0)
                        .collect();
                    if let Ok(s) = String::from_utf16(&u16s) {
                        if !s.is_empty() {
                            return Some(PathBuf::from(s));
                        }
                    }
                }
            }
            // 回退到 LocalBasePath (ANSI / ASCII, Offset 0x10)
            let base_offset = u32::from_le_bytes(link_info[16..20].try_into().ok()?) as usize;
            if base_offset < link_info_size {
                let bytes = &link_info[base_offset..link_info_size];
                let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
                if let Ok(s) = std::str::from_utf8(&bytes[..end]) {
                    if !s.is_empty() {
                        return Some(PathBuf::from(s));
                    }
                }
            }
        }
        None
    }

    fn extract_icon_from_target(path: &Path) -> Option<String> {
        let wide_path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut shfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let flags = SHGFI_ICON | SHGFI_SMALLICON;

        let res = unsafe {
            SHGetFileInfoW(
                wide_path.as_ptr(),
                0,
                &mut shfi,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                flags,
            )
        };

        if res == 0 || shfi.hIcon.is_null() {
            return None;
        }

        let hicon = shfi.hIcon;
        icon_to_data_url(hicon)
    }

    fn icon_to_data_url(hicon: HICON) -> Option<String> {
        let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
        let info_ok = unsafe { GetIconInfo(hicon, &mut icon_info) };
        if info_ok == 0 {
            unsafe { DestroyIcon(hicon) };
            return None;
        }

        let hbm_color = icon_info.hbmColor;
        let hbm_mask = icon_info.hbmMask;

        if hbm_color.is_null() {
            unsafe {
                if !hbm_mask.is_null() {
                    DeleteObject(hbm_mask as _);
                }
                DestroyIcon(hicon);
            }
            return None;
        }

        // 读取位图尺寸
        let mut bm: BITMAP = unsafe { std::mem::zeroed() };
        let obj_res = unsafe {
            GetObjectW(
                hbm_color as _,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bm as *mut _ as *mut _,
            )
        };
        let width = if obj_res > 0 && bm.bmWidth > 0 {
            bm.bmWidth
        } else {
            16
        };
        let height = if obj_res > 0 && bm.bmHeight > 0 {
            bm.bmHeight
        } else {
            16
        };

        let hdc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if hdc.is_null() {
            unsafe {
                DeleteObject(hbm_color as _);
                if !hbm_mask.is_null() {
                    DeleteObject(hbm_mask as _);
                }
                DestroyIcon(hicon);
            }
            return None;
        }

        // biHeight 设为负数代表 top-down 扫描线，直接按自然顺序输出
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        let pixel_count = (width * height) as usize;
        let mut pixels = vec![0u8; pixel_count * 4];

        let dib_res = unsafe {
            GetDIBits(
                hdc,
                hbm_color,
                0,
                height as u32,
                pixels.as_mut_ptr() as *mut _,
                &mut bmi,
                DIB_RGB_COLORS,
            )
        };

        if dib_res == 0 {
            unsafe {
                DeleteDC(hdc);
                DeleteObject(hbm_color as _);
                if !hbm_mask.is_null() {
                    DeleteObject(hbm_mask as _);
                }
                DestroyIcon(hicon);
            }
            return None;
        }

        // 检测是否存在真实的 Alpha 通道（现代 32 位 ARGB 图标）
        let has_alpha = pixels.as_chunks::<4>().0.iter().any(|p| p[3] != 0);

        if !has_alpha && !hbm_mask.is_null() {
            // 旧版 24 位位图无 Alpha，需借助 hbmMask（1 位单色掩码）补齐透明通道
            let mut mask_bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            mask_bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            mask_bmi.bmiHeader.biWidth = width;
            mask_bmi.bmiHeader.biHeight = -height;
            mask_bmi.bmiHeader.biPlanes = 1;
            mask_bmi.bmiHeader.biBitCount = 1;
            mask_bmi.bmiHeader.biCompression = BI_RGB;

            let mask_row_bytes = ((width + 31) / 32 * 4) as usize;
            let mut mask_bytes = vec![0u8; mask_row_bytes * height as usize];

            let mask_res = unsafe {
                GetDIBits(
                    hdc,
                    hbm_mask,
                    0,
                    height as u32,
                    mask_bytes.as_mut_ptr() as *mut _,
                    &mut mask_bmi,
                    DIB_RGB_COLORS,
                )
            };

            if mask_res > 0 {
                for y in 0..height as usize {
                    let row_offset = y * mask_row_bytes;
                    for x in 0..width as usize {
                        let byte_val = mask_bytes[row_offset + (x / 8)];
                        let bit = (byte_val >> (7 - (x % 8))) & 1;
                        let pixel_idx = (y * width as usize + x) * 4;
                        // Windows 图标掩码：bit 为 0 代表不透明，bit 为 1 代表透明
                        pixels[pixel_idx + 3] = if bit == 0 { 255 } else { 0 };
                    }
                }
            } else {
                for p in pixels.as_chunks_mut::<4>().0 {
                    p[3] = 255;
                }
            }
        }

        // 严格释放全部 Win32 GDI 资源，防止句柄泄露
        unsafe {
            DeleteDC(hdc);
            DeleteObject(hbm_color as _);
            if !hbm_mask.is_null() {
                DeleteObject(hbm_mask as _);
            }
            DestroyIcon(hicon);
        }

        // 编码为标准的 32 位透明 PNG（彻底杜绝 BMP 的黑底/夜色背景问题）
        let png_bytes = build_png(width, height, &pixels)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        Some(format!("data:image/png;base64,{encoded}"))
    }

    /// 标准 CRC32 计算
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                if (crc & 1) != 0 {
                    crc = (crc >> 1) ^ 0xEDB8_8320;
                } else {
                    crc >>= 1;
                }
            }
        }
        !crc
    }

    /// 写入单个 PNG Chunk
    fn write_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(chunk_type);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(chunk_type);
        crc_input.extend_from_slice(data);
        let c = crc32(&crc_input);
        out.extend_from_slice(&c.to_be_bytes());
    }

    /// 纯内存组装标准 32 位 RGBA 透明 PNG 字节流
    fn build_png(width: i32, height: i32, bgra_pixels: &[u8]) -> Option<Vec<u8>> {
        if width <= 0 || height <= 0 {
            return None;
        }
        let w = width as usize;
        let h = height as usize;
        if bgra_pixels.len() < w * h * 4 {
            return None;
        }

        let mut out = Vec::new();
        // 1. PNG Signature
        out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

        // 2. IHDR Chunk
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&(w as u32).to_be_bytes());
        ihdr.extend_from_slice(&(h as u32).to_be_bytes());
        ihdr.push(8); // bit depth: 8
        ihdr.push(6); // color type: 6 (RGBA)
        ihdr.push(0); // compression: 0 (deflate)
        ihdr.push(0); // filter: 0
        ihdr.push(0); // interlace: 0
        write_chunk(&mut out, b"IHDR", &ihdr);

        // 3. IDAT Chunk: 扫描线转换为 RGBA 并附加 filter byte (0)
        let row_len = 1 + w * 4;
        let mut raw_scanlines = Vec::with_capacity(h * row_len);
        for y in 0..h {
            raw_scanlines.push(0); // Filter type 0 (None)
            let row_offset = y * w * 4;
            for x in 0..w {
                let px = row_offset + x * 4;
                let b = bgra_pixels[px];
                let g = bgra_pixels[px + 1];
                let r = bgra_pixels[px + 2];
                let a = bgra_pixels[px + 3];
                raw_scanlines.extend_from_slice(&[r, g, b, a]);
            }
        }

        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&raw_scanlines, 6);
        write_chunk(&mut out, b"IDAT", &compressed);

        // 4. IEND Chunk
        write_chunk(&mut out, b"IEND", &[]);

        Some(out)
    }
}

/// 提取给定路径（可执行程序、快捷方式或系统文件）的系统自带原生图标，返回 Base64 PNG Data URL。
pub(crate) fn extract_icon_data_url(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        platform::extract_icon_data_url(path)
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}
