# 高性能 Markdown 渲染引擎全面压力测试

> 当前文档作为基准测试用例，涵盖 Markdown 所有基础语法、极端嵌套以及组合场景，用于严苛的 AST 渲染性能与边缘情况压测。

---

## 核心交互测试区块 1

### 1. 标题边缘测试 (Headings)
# 一级标题 H1
## 二级标题 H2
### 三级标题 H3
#### 四级标题 H4
##### 五级标题 H5
###### 六级标题 H6
####### 非法七级标题（应被解析为普通文本）
#紧凑无效标题（无空格）
##   多空格标题测试

### 2. 文本格式化极端组合 (Emphasis & Inline Styles)
基础样式：**加粗**，*斜体*，~~删除线~~，==高亮==，`行内代码`。
变态重叠组合：***加粗斜体***，**加粗内的*斜体*测试**，*斜体内的**加粗**测试*。
深度嵌套组合：**~~*==高亮斜体删除线加粗==*~~**。
空标签测试：** **、**  **、****、**、* *、~~ ~~、====。
单边未闭合测试：**未闭合的加粗、*未闭合的斜体、~~未闭合的删除线。
带中英文混合：Testing **Bold English** and *Italic English* and ~~Strike English~~ mixed with 中文。
行内代码逃逸测试：`包含 反引号 \` 的代码`，``包含 两个 反引号 `` 的代码``，`包含 *特殊符号* 的代码`。
长文本测试：这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的大段文字，用来测试如果超过容器宽度，会不会发生正确的换行，并且在输入法输入和光标上下跳动的时候能不能正确的进行物理位置和逻辑字串索引的计算映射。

### 3. 多媒体、超链接与转义 (Links, Images & Escaping)
基础链接：[普通链接文本](https://google.com)
无地址链接：[空链接文本]()
特殊字符链接：[包含空格 的链接](https://google.com?q=hello world)
带括号的链接：[带括号的链接](https://google.com/test(1))
图片加载：![这是一个占位图](https://via.placeholder.com/150)
图片链接嵌套：[![点击图片跳转](https://via.placeholder.com/150)](https://google.com)
转义字符测试：\*这不是斜体\*，\*\*这不是加粗\*\*，\[这不是链接\]，\# 这不是标题。
脚注引用测试：这是一段包含脚注引用的文字[^1]和另一处引用[^footnote2]。

### 4. 复杂列表结构 (Complex Lists)
#### 4.1 无序列表与任务列表混合
- [x] 顶层已完成任务
- [ ] 顶层未完成任务
  - 普通嵌套列表 1
  - [x] 嵌套已完成任务
    - [ ] 二级嵌套未完成任务
    - [X] 大写X任务
    - [ ]    多空格任务
* 使用星号的无序列表
+ 使用加号的无序列表

#### 4.2 有序列表与混合缩进
1. 有序列表第一步
2. 有序列表第二步
999. 超大数字的有序列表
0. 零开头的有序列表
   1. 嵌套的有序列表 1
   2. 嵌套的有序列表 2
      - 混合嵌套无序列表
      - 混合嵌套无序列表

### 5. 引用块深层嵌套 (Deep Blockquotes)
> 第一层引用
> > 第二层嵌套引用
> > > 第三层深层引用
> 
> 第一层引用继续，中间带有空引用行
> 引用内包含列表：
> - [x] 引用内的任务
> - [ ] 引用内的任务 2
> 
> 引用内包含代码块：
> ```json
> { "key": "value" }
> ```

### 6. 代码块与 HTML (Code & HTML)
```javascript
// 真实的复杂代码块测试 (React Component)
import React, { useState, useEffect } from 'react';

export function ExampleComponent({ title }) {
    const [count, setCount] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setCount(c => c + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    return (
        <div className="example-component">
            <h1>{title}</h1>
            <p>Count: {count}</p>
            <button onClick={() => setCount(0)}>Reset</button>
        </div>
    );
}
```

```rust
// 真实的 Rust 核心逻辑
pub struct MarkdownEngine {
    pub name: String,
    pub is_fast: bool,
}

impl MarkdownEngine {
    pub fn parse(&self, content: &str) -> AST {
        println!("Parsing {} bytes...", content.len());
        // 复杂嵌套逻辑...
        AST::new()
    }
}
```

```
无指定语言代码块
Plain text code block test.
```

```html
<!-- 包含HTML语法的代码块 -->
<div>
  <span style="color: red;">内联HTML解析逃逸测试</span>
</div>
```

内联 HTML 标签解析逃逸：<span style="color: blue">这是蓝色文字吗？</span>还是作为纯文本显示？

### 7. 表格高级排版 (Tables)
这是一个极限压测的宽表格：

| 功能模块 | 修复状态 | 性能开销 (ms) | 负责团队 | 测试覆盖率 | 边缘用例 | 上线时间 | 备注信息 |
| :--- | :---: | ---: | :--- | :--- | :--- | :--- | :--- |
| 虚拟列表滚动 | 🟢 已完成 | < 2ms | 核心渲染组 | 95% | 频繁重排、尺寸跳动 | 2026-08-01 | 无 |
| AST 增量解析 | 🟢 已完成 | ~5ms | 解析引擎组 | 88% | 不闭合标签、非法字符 | 2026-08-02 | 需持续关注 |
| 表格内 **加粗** | *斜体* 测试 | ~~删除线~~ | [链接测试](#) | N/A | 空单元格 | 2026-08-03 | 排版对齐 |
| 超长行打字跳动 | 🟢 修复 | 0.5ms | 交互组 | 100% | 拼音输入宽度挤压 | 2026-08-08 | 防倒退脚本已加 |
| 上下键导航失灵 | 🟢 修复 | 0.1ms | 交互组 | 100% | 虚拟化首尾节点寻找 | 2026-08-08 | `data-index`修正 |
| 极简表格测试 | 自动对齐 | 空单元格 | | | | | |
| | | | | | | | |

### 8. 水平分割线异形结构 (Horizontal Rules)
下面是各种合法与非法的分割线测试：
---
***
___
- - -
* * *

### 9. 扩展语法 (Math, Kbd, Spoiler, Sub/Sup)
数学公式: 质能等价公式 $E = mc^2$，复数解析 $e^{i\pi} + 1 = 0$。
独立块公式：
$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$
按键标记: 终止任务请按 <kbd>Ctrl</kbd> + <kbd>C</kbd>，清屏按 <kbd>Cmd</kbd> + <kbd>K</kbd>。
上下标: H<sub>2</sub>O 是水，2<sup>10</sup> = 1024。以及简写水 H~2~O 和次方 2^10^。
剧透警告: 杀手其实是 ||那个一直在微笑的管家||。

=== 核心交互测试区块 1 结束 ===

## 核心交互测试区块 2：极端布局与嵌套 (Extreme Layouts)

### 10. 极端表格排版 (Extreme Tables)
测试表格内的单元格复杂内容、超长内容、以及虚拟化对表格行列的裁剪表现。

| 复杂单元格 A | 极宽单元格 B | 极长跨行单元格 C |
| :--- | :--- | :--- |
| **嵌套列表：**<br>1. 第一项<br>2. 第二项 | 极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极长极宽文本不应该把表格撑爆，应该具有换行或者溢出隐藏能力 | ![小图](https://via.placeholder.com/20)<br>带图片和 `inline code` 的单元格 |
| $$ e^{i\pi}+1=0 $$ | > 单元格内的引用<br>> 必须支持换行显示 | <span style="color:red">带样式的文本</span> 和 ~~删除线~~ |
| 连续空行测试<br><br><br>三行之后 | 极短 | 结束 |

### 11. 列表内的深层表格嵌套 (Tables in Lists)
1. 列表项一包含表格：
   | Header 1 | Header 2 |
   | -------- | -------- |
   | A1       | B1       |
   | A2       | B2       |
2. 列表项二包含代码块：
   ```python
   def foo():
       print("Tables in lists are evil.")
   ```
3. 列表项三恢复正常文本。

=== 核心交互测试区块 2 结束 ===
