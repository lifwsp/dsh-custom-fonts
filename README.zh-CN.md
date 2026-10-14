# dsh-custom-fonts

在 DeepSeek Harness Web 界面自定义**中文字体**、**英文字体**、**代码字体**与**全局字号偏移** —— 设置页直接操作，实时预览。

[English](README.md)

> **Note (fork):** This Chinese README is kept from the upstream project and describes version 1.1. Since 1.2.0 the settings page is in English, settings are saved automatically, and the plugin has a host half that needs a DSH restart after installation. See [README.md](README.md) for the current documentation.
>
> **说明（分支）：** 本中文说明保留自上游项目，描述的是 1.1 版。自 1.2.0 起，设置页界面为英文，设置会自动保存，并新增宿主端（安装后需重启 DSH）。最新说明请参阅 [README.md](README.md)。

## 功能

纯客户端插件（无宿主端，无需重启）。安装后在 **设置 → 字体** 新增设置页：

- **UI 字体 · 英文**：用于拉丁字符（Segoe UI、Arial、Georgia、Consolas 等）。
- **UI 字体 · 中文**：用于汉字（微软雅黑 / 宋体 / 黑体 / 楷体 / 仿宋 / 思源黑体 / 苹方等）。
- **代码字体**：代码块与行内代码（`pre`/`code`/`kbd`/`samp`）独立使用等宽字体（Consolas、JetBrains Mono、Fira Code、Cascadia Code、等距更纱黑体等）。
- **字体大小偏移**：-4 ~ +8px 全局滑条，平级偏移不叠加（见原理）。
- **实时预览**：中英混排 UI 示例 + 代码字体示例随输入即时渲染；支持逗号分隔的多个候选字体与任意字体名。
- **恢复默认**：一键清空全部设置并移除所有注入样式。

## 原理

插件注入一段全局样式：

```css
:root { --dsh-custom-fonts-en: '英文字体'; --dsh-custom-fonts-zh: '中文字体'; }
body, body * { font-family: '英文字体', '中文字体' !important; }
pre, code, kbd, samp { font-family: '代码字体' !important; }
body, body * { font-size: calc(1em + 2px) !important; }  /* 偏移非 0 时 */
```

- font-family 回退链实现按文字的字体分流：拉丁字符优先匹配英文字体，中文字符因英文字体缺少字形而自动回退到中文字体——无需语言检测、不操作 DOM。
- 代码字体规则排在后面，仅在代码区域内胜出。
- 字号偏移用 `calc(1em ± Npx)` **相对每个元素自身字号**计算，每层只偏移一次 N，不会指数级放大；归零即恢复。

修改即时全局生效（消息正文、侧边栏、输入框等所有界面文本）。

## 安装

市场发布后可从 **设置 → 插件市场** 一键安装，或：

```sh
dsh plugin --profile web add dsh-custom-fonts
```

或直接从仓库安装：

```sh
dsh plugin --profile web add github:lsh2002/dsh-custom-fonts
```

纯客户端插件：刷新页面即生效，无需重启。

## 卸载

在 **设置 → 插件 → 插件配置** 中移除（或 `dsh plugin --profile web remove dsh-custom-fonts`），刷新页面后字体自动还原。

## 许可证

MIT