//! 跨平台资源采样原语（resource.rs 拆分）：Windows Job 对象 / Unix proc。

use super::*;

/// FFI 风格对齐 `process.rs:391-443`（每处 unsafe 有 SAFETY 说明，经评审后允许）。
#[cfg(windows)]
#[allow(unsafe_code)] // Windows Job Objects FFI（QueryInformationJobObject × 2），
                      // SAFETY 见函数内注释，经评审后允许
pub(super) fn sample_windows(
    job: windows_sys::Win32::Foundation::HANDLE,
) -> Result<RawUsage, String> {
    use core::mem;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };

    let mut basic: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: basic 为栈分配结构（尺寸传真实大小），失败仅返回 FALSE 不写内存；
    // 查询类 API 无句柄所有权转移，job 句柄生命周期与进程一致
    let ret = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &mut basic as *mut _ as *mut core::ffi::c_void,
            mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            core::ptr::null_mut(),
        )
    };
    if ret == 0 {
        return Err(format!(
            "QueryInformationJobObject(BasicAccounting) failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: 同上（栈分配 + 查询类 API，无所有权转移）
    let ret = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut extended as *mut _ as *mut core::ffi::c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            core::ptr::null_mut(),
        )
    };
    if ret == 0 {
        return Err(format!(
            "QueryInformationJobObject(ExtendedLimit) failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    // FILETIME 100ns → 毫秒：除以 10_000；u64 转换取低 63 位（CPU 时间单调非负，
    // 符号位恒 0），saturating 防溢出
    let cpu_ms = (basic.TotalUserTime as u64).saturating_add(basic.TotalKernelTime as u64) / 10_000;
    let rss_bytes = extended.PeakJobMemoryUsed as u64;
    Ok(RawUsage { cpu_ms, rss_bytes })
}

/// Unix：`/proc/<pid>/stat`（utime+stime，sysconf(clk_tck) 换算毫秒）+ 主进程
/// rss（pages × 页大小）+ `getrusage(RUSAGE_CHILDREN)` 已回收子进程近似
/// （ru_utime+ru_stime 差值口径 + ru_maxrss 峰值）。
///
/// 诚实边界（方案 §8.3 1）：进程树累加退化为「主进程 + 已回收子进程」近似，
/// 未回收孙进程不计入——与 Windows Job 树聚合存在数值口径差异。
#[cfg(not(windows))]
#[allow(unsafe_code)] // POSIX libc FFI（sysconf / getrusage），参数为整数或栈指针，
                      // SAFETY 见函数内注释，经评审后允许
pub(super) fn sample_unix(pid: u32) -> Result<RawUsage, String> {
    use core::mem;

    // /proc/<pid>/stat：字段 14=utime、15=stime（ticks）、24=rss（pages）。
    // comm 可能含空格/括号（进程名带空格），先取最后一个 ')' 再按空白拆段——
    // 段 0 = state（字段 3），故 utime = 段 11、stime = 段 12、rss = 段 21
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|e| format!("读取 /proc/{pid}/stat 失败：{e}"))?;
    let close = stat
        .rfind(')')
        .ok_or_else(|| format!("stat 格式异常（缺 comm 收尾）：/proc/{pid}/stat"))?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let utime: u64 = fields
        .get(11)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "utime 字段解析失败".to_string())?;
    let stime: u64 = fields
        .get(12)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "stime 字段解析失败".to_string())?;
    let rss_pages: u64 = fields
        .get(21)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "rss 字段解析失败".to_string())?;

    // SAFETY: sysconf 为纯查询 API，参数为标准 POSIX 常量，无内存操作
    let clk_tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
    // SAFETY: 同上
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
    let cpu_ms = utime.saturating_add(stime).saturating_mul(1000) / clk_tck.max(1);

    // 已回收子进程近似（RUSAGE_CHILDREN）：累计值差值由采样循环按周期差值模型
    // 处理（本函数只读当前值）；ru_utime/ru_stime 为 timeval（秒+微秒）
    let mut usage: libc::rusage = unsafe { mem::zeroed() };
    // SAFETY: usage 为栈分配结构（libc::rusage 完整尺寸由 libc 保证），
    // getrusage 成功返回 0 并填充结构，失败（rc != 0）不写内容
    let rc = unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) };
    let child_cpu_ms = if rc == 0 {
        let secs = usage.ru_utime.tv_sec.saturating_add(usage.ru_stime.tv_sec) as u64;
        let usecs = usage
            .ru_utime
            .tv_usec
            .saturating_add(usage.ru_stime.tv_usec) as u64;
        secs.saturating_mul(1000).saturating_add(usecs / 1000)
    } else {
        0
    };

    // rss = 主进程当前 pages × 页大小 + 已回收子进程峰值（ru_maxrss 单位 KB）
    let rss_bytes = rss_pages
        .saturating_mul(page_size.max(1))
        .saturating_add((usage.ru_maxrss.max(0) as u64).saturating_mul(1024));

    Ok(RawUsage {
        cpu_ms: cpu_ms.saturating_add(child_cpu_ms),
        rss_bytes,
    })
}
