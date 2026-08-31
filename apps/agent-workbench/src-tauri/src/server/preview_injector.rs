//! 应用预览 HTML 注入引擎（透明代理管道第三段）
//!
//! 职责：对已抓取到目标站点响应体的 HTML 做两种注入——
//! 1. `<base href="[target_url]">`：校准页面内相对路径与绝对根路径的解析基准
//!    （代理响应源 = 代理自身 Origin，若不注入 base，`/style.css` 等资源会
//!    解析到代理服务而非目标站点）；
//! 2. `PREVIEW_BRIDGE_SCRIPT`：轻量 postMessage 桥接脚本（协同捕获
//!    error / unhandledrejection / 链接点击 / 就绪上报，供前端预览窗格消费）。
//!
//! 纯字符串处理、无网络 IO、无副作用，便于独立单元测试。

/// 注入到 HTML 中的轻量 postMessage 桥接脚本
///
/// 以 IIFE 幂等安装（`window.__CONEX_PREVIEW_BRIDGE_INSTALLED__` 防重复），
/// 事件经 `window.parent.postMessage` 上报，消息契约：
/// - `preview:error`：页面错误协同捕获；
/// - `preview:unhandledrejection`：未处理 Promise 拒绝；
/// - `preview:navigate`：链接点击协同（含 target）；
/// - `preview:ready`：DOMContentLoaded / 已就绪上报。
pub const PREVIEW_BRIDGE_SCRIPT: &str = r#"<script id="__conex_preview_bridge">
(function() {
  if (window.__CONEX_PREVIEW_BRIDGE_INSTALLED__) return;
  window.__CONEX_PREVIEW_BRIDGE_INSTALLED__ = true;

  // 错误与未处理 Promise 协同捕获
  window.addEventListener('error', function(e) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'preview:error',
          message: e.message || 'Script error',
          filename: e.filename || '',
          lineno: e.lineno || 0,
          colno: e.colno || 0
        }, '*');
      }
    } catch (_) {}
  });

  window.addEventListener('unhandledrejection', function(e) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'preview:unhandledrejection',
          reason: e.reason ? String(e.reason) : 'Unhandled promise rejection'
        }, '*');
      }
    } catch (_) {}
  });

  // 链接点击协同
  document.addEventListener('click', function(e) {
    try {
      var target = e.target;
      while (target && target.tagName !== 'A') {
        target = target.parentElement;
      }
      if (target && target.href && window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'preview:navigate',
          href: target.href,
          target: target.target || '_self'
        }, '*');
      }
    } catch (_) {}
  }, true);

  // 就绪状态上报
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    reportReady();
  } else {
    document.addEventListener('DOMContentLoaded', reportReady);
  }

  function reportReady() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'preview:ready',
          url: window.location.href,
          title: document.title || ''
        }, '*');
      }
    } catch (_) {}
  }
})();
</script>"#;

/// 在 HTML 内容中注入 `<base href="...">` 和 postMessage 协同脚本
///
/// 注入顺序（与注入目标页面的渲染语义对齐）：
/// 1. 优先匹配 `<head...>` 起始标签并在其后注入；
/// 2. 无 `<head>` 时匹配 `<html...>` 起始标签，在其后包裹 `<head>` 注入；
/// 3. 两者皆无时直接前置注入（仍保证 base 与桥接脚本在文档首部）。
pub fn inject_html_preview_bridge(html: &str, target_url: &str) -> String {
    let base_tag = format!(r#"<base href="{}">"#, escape_html_attribute(target_url));
    let injection = format!("\n{}\n{}\n", base_tag, PREVIEW_BRIDGE_SCRIPT);

    // 1. 尝试匹配 <head...> 标签并在其后注入
    if let Some(pos) = find_tag_end_case_insensitive(html, "<head") {
        let mut res = String::with_capacity(html.len() + injection.len());
        res.push_str(&html[..pos]);
        res.push_str(&injection);
        res.push_str(&html[pos..]);
        return res;
    }

    // 2. 尝试匹配 <html...> 标签并在其后包裹 <head> 注入
    if let Some(pos) = find_tag_end_case_insensitive(html, "<html") {
        let mut res = String::with_capacity(html.len() + injection.len() + 16);
        res.push_str(&html[..pos]);
        res.push_str("<head>");
        res.push_str(&injection);
        res.push_str("</head>");
        res.push_str(&html[pos..]);
        return res;
    }

    // 3. 无 head/html 标签，直接前置注入
    let mut res = String::with_capacity(html.len() + injection.len());
    res.push_str(&injection);
    res.push_str(html);
    res
}

/// 转义 HTML 属性中的敏感字符
fn escape_html_attribute(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#39;")
}

/// 大小写不敏感地寻找特定 HTML 起始标签的闭合位置（避免误匹配 <header> 等）
fn find_tag_end_case_insensitive(html: &str, tag_prefix: &str) -> Option<usize> {
    let lower_html = html.to_ascii_lowercase();
    let prefix_lower = tag_prefix.to_ascii_lowercase();
    let prefix_len = prefix_lower.len();

    let mut search_from = 0;
    while let Some(idx) = lower_html[search_from..].find(&prefix_lower) {
        let tag_start = search_from + idx;
        let next_char = lower_html[tag_start + prefix_len..].chars().next();
        let is_valid_tag = matches!(next_char, Some('>' | ' ' | '\t' | '\r' | '\n' | '/') | None);

        if is_valid_tag {
            if let Some(close_rel) = html[tag_start..].find('>') {
                return Some(tag_start + close_rel + 1);
            }
        }
        search_from = tag_start + prefix_len;
    }
    None
}
