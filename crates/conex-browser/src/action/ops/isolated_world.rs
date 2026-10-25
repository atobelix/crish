//! 隔离世界与只读代理注入逻辑。

use serde_json::{json, Value};

use super::error::{
    CDP_PAGE_CREATE_ISOLATED_WORLD, CDP_PAGE_GET_FRAME_TREE, CDP_RUNTIME_EVALUATE, CMD_TIMEOUT,
};
use super::page_ops::BrowserPageOps;
use crate::action::{ActionError, ActionErrorKind};

/// 隔离世界命名（Page.createIsolatedWorld worldName；同名世界按帧复用）。
pub(crate) const ISOLATED_WORLD_NAME: &str = "crish-read-only";

/// `__crish_read` 只读白名单代理注入脚本（17 §3.1/§3.2；缺陷 B 修复面）：
/// 建世界成功后经**同一 world 的** Runtime.evaluate 执行，随后用户表达式在同一
/// world 执行时全局 `__crish_read` 可见（挂载于世界全局 globalThis）。
///
/// 语义（17 §3.1 白名单面）：
/// - 6 个只读方法：attr(sel,name) / text(sel) / rect(sel) / formValue(sel) /
///   all(sel) / state()——DOM 访问一律经代理，不经用户表达式直触 window/document；
/// - 返回值纯 JSON 深拷贝（deepJSON：对象/数组递归、节点/函数引用不出世界）；
/// - 只读代理面：不可写/不可配置/不可枚举（赋值/删除/改写即抛错）；
/// - constructor 链检查（17 §3.2 ②）：代理 get/has 拦截 constructor/prototype/
///   __proto__/then 访问（`[].filter.constructor` 类方法链逃逸在运行时层拒绝，
///   词法层已先拒 `constructor` 标识符）；
/// - 幂等：world 按名复用（Chrome 对同名 world 返回既有上下文）时可重入，不重复覆盖。
pub const CRISH_READ_INJECTION: &str = r#"(function () {
  'use strict';
  // __crish_read 只读白名单代理（17 §3.1）：6 个只读方法 + 纯 JSON 深拷贝返回
  if (typeof globalThis.__crish_read === 'object') return true; // 幂等：同名 world 复用
  function deepJSON(v, depth) {
    // 纯 JSON 拷贝（结构化克隆语义）：对象/数组递归、原始值透传，函数/节点不产出
    if (v === null || typeof v !== 'object') return v;
    if (depth > 12) return null; // 防御深层对象（结果层另有深度 4 预算兜底）
    if (Array.isArray(v)) return v.map(function (i) { return deepJSON(i, depth + 1); });
    var out = {};
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = deepJSON(v[k], depth + 1);
    }
    return out;
  }
  function first(sel) { return document.querySelector(sel); }
  function attr(sel, name) {
    // 读取元素属性（只读查询；写入面由词法层 + 代理只读面双重拒绝）
    var n = first(sel);
    return n ? n.getAttribute(name) : null;
  }
  function text(sel) {
    // 读取元素文本（DOM 只读查询）
    var n = first(sel);
    return n ? n.textContent : null;
  }
  function rect(sel) {
    // 几何信息（纯 JSON：x/y/width/height，单位 px）
    var n = first(sel);
    if (!n) return null;
    var r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  function formValue(sel) {
    // 表单值读取（只读；密码字段脱敏属工具层 redact 面，17 §6.2）
    var n = first(sel);
    return n ? (n.value !== undefined ? n.value : null) : null;
  }
  function all(sel) {
    // 集合查询：纯 JSON 数组（标签/文本/值；节点引用不外泄）
    var list = document.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      out.push({
        tag: list[i].tagName,
        id: list[i].id || null,
        text: list[i].textContent,
        value: list[i].value !== undefined ? list[i].value : null
      });
    }
    return out;
  }
  function state() {
    // 页面状态（纯 JSON）
    return { url: location.href, title: document.title };
  }
  var api = { attr: attr, text: text, rect: rect, formValue: formValue, all: all, state: state };
  var handler = {
    get: function (target, prop) {
      // constructor 链检查（17 §3.2）：取构造器/原型/__proto__ 即拒绝
      if (prop === 'constructor' || prop === 'prototype' || prop === '__proto__' || prop === 'then') {
        throw new Error('__crish_read: forbidden member access');
      }
      return Object.prototype.hasOwnProperty.call(target, prop) ? target[prop] : undefined;
    },
    has: function (target, prop) {
      // in 探询同样遮蔽构造面成员
      if (prop === 'constructor' || prop === 'prototype' || prop === '__proto__') return false;
      return Object.prototype.hasOwnProperty.call(target, prop);
    },
    set: function () { throw new Error('__crish_read is read-only'); },
    deleteProperty: function () { throw new Error('__crish_read is read-only'); }
  };
  // 全局挂载（世界全局）：不可写/不可配置/不可枚举——表达式可读不可改
  Object.defineProperty(globalThis, '__crish_read', {
    value: new Proxy(api, handler),
    writable: false,
    configurable: false,
    enumerable: false
  });
  return true;
})()"#;

impl BrowserPageOps {
    pub(crate) async fn create_isolated_world_impl(&self) -> Result<String, ActionError> {
        // 缺陷 A（K7 e2e，Chrome 151）：Runtime.createIsolatedWorld 已移除（-32601）；
        // Page.createIsolatedWorld 需要 frameId——先经 Page.getFrameTree 取主 frame。
        let tree_value = self
            .send(CDP_PAGE_GET_FRAME_TREE, json!({}), CMD_TIMEOUT)
            .await?;
        let tree: crate::cdp::domains::GetFrameTreeResult = serde_json::from_value(tree_value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("getFrameTree 结果解析失败：{e}"),
                )
            })?;
        let frame_id = tree.frame_tree.frame.id;
        // grantUniversalAccess 缺省（协议键名为 grantUniveralAccess 错拼形态，Chrome
        // 对未知参数回 -32602——直接省略，缺省 false 即「不授予 universal access」）
        let value = self
            .send(
                CDP_PAGE_CREATE_ISOLATED_WORLD,
                json!({ "frameId": frame_id, "worldName": ISOLATED_WORLD_NAME }),
                CMD_TIMEOUT,
            )
            .await?;
        let world: crate::cdp::domains::CreateIsolatedWorldResult = serde_json::from_value(value)
            .map_err(|e| {
            ActionError::new(
                ActionErrorKind::Unsupported,
                format!("createIsolatedWorld 结果解析失败：{e}"),
            )
        })?;
        let context_id = world.execution_context_id;

        // 缺陷 B（17 §3.2 与 §3.1 断裂面）：建世界后先注入只读白名单代理——
        // 注入脚本在**同一 world**（contextId）执行，用户表达式随后在同一 world
        // 的 Runtime.evaluate 中即可见全局 `__crish_read`；注入失败视同世界不可用。
        let injected = self
            .send(
                CDP_RUNTIME_EVALUATE,
                json!({
                    "expression": CRISH_READ_INJECTION,
                    "contextId": context_id,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": false,
                    "timeout": 2000,
                    "generatePreview": false,
                }),
                CMD_TIMEOUT,
            )
            .await?;
        let evaluated: crate::cdp::domains::EvaluateResult = serde_json::from_value(injected)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("代理注入结果解析失败：{e}"),
                )
            })?;
        if evaluated.exception_details.is_some() {
            return Err(ActionError::new(
                ActionErrorKind::Unsupported,
                "隔离世界代理注入失败",
            ));
        }
        Ok(context_id.to_string())
    }

    pub(crate) async fn evaluate_isolated_impl(
        &self,
        world_id: &str,
        expression: &str,
    ) -> Result<Value, ActionError> {
        let context_id: i64 = world_id
            .parse()
            .map_err(|_| ActionError::new(ActionErrorKind::Unsupported, "非法隔离世界标识"))?;
        let value = self
            .send(
                CDP_RUNTIME_EVALUATE,
                json!({
                    "expression": expression,
                    "contextId": context_id,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": false,
                    "timeout": 2000,
                    "generatePreview": false,
                }),
                CMD_TIMEOUT,
            )
            .await?;
        let evaluated: crate::cdp::domains::EvaluateResult = serde_json::from_value(value)
            .map_err(|e| {
                ActionError::new(
                    ActionErrorKind::Unsupported,
                    format!("evaluate_isolated 结果解析失败：{e}"),
                )
            })?;
        if evaluated.exception_details.is_some() {
            return Err(ActionError::new(
                ActionErrorKind::InvalidInput,
                "受限求值执行异常",
            ));
        }
        Ok(evaluated.result.value.unwrap_or(Value::Null))
    }
}
