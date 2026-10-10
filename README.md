# FleurAnnotation

An Obsidian plugin that brings intelligent reading and annotation features to Markdown files. Highlight text, add underlines, attach comments, and leverage AI to explain, translate, and annotate your content — all directly within Obsidian.

## Features

- 📝 **Highlight**: Right-click to highlight selected text with customizable colors
- 📏 **Underline**: Multiple underline styles (solid, dashed, dotted, wavy)
- 💬 **Annotations**: Add personal comments to selected text
- 🤖 **AI Assistance**:
  - Smart Explanation: AI explains selected text content
  - Smart Translation: One-click translation
  - AI Annotations: Automatically generate valuable annotations
- 📋 **Sidebar Management**: View all annotations in one place with quick navigation
- 📤 **Export**: Export all annotations as a separate Markdown note
- 🌍 **Multi-language Support**: Chinese-friendly interface and interactions

## Why FleurAnnotation?

Compared to PDF annotation plugins, FleurAnnotation focuses specifically on Markdown files:

1. **Native Markdown Integration**: Highlights and annotations display directly in Markdown files without view switching
2. **AI-Powered Reading**: Not just an annotation tool, but an intelligent reading assistant
3. **One-Click Export**: Easily organize annotations into separate note files
4. **Lightweight**: Minimal configuration, works out of the box

## Installation

### Via Community Plugins (Recommended)

1. Open Obsidian Settings → Community Plugins
2. Search for "FleurAnnotation"
3. Click Install, then Enable

### Via BRAT

1. Install [BRAT](https://github.com/tfthacker/obsidian42-brat) plugin in Obsidian
2. Add this repository: `https://github.com/gibsonchan-5/fleur-annotation`
3. Enable FleurAnnotation plugin

### Manual Installation

1. Download the latest version from [Releases](https://github.com/gibsonchan-5/fleur-annotation/releases)
2. Extract to `.obsidian/plugins/fleur-annotation/` in your vault
3. Enable FleurAnnotation plugin in Obsidian settings

## Usage

### Basic Operations

**Highlight Text**
- Select text in a Markdown file
- Right-click and choose "Highlight"
- Customize the highlight color in settings

**Add Underline**
- Select text and right-click
- Choose "Underline"
- Customize underline style and color

**Add Annotation**
- Select text and right-click
- Choose "Annotation"
- Enter your annotation content

### AI Features

**AI Explanation**: Select text → Right-click → "AI Explanation"

**AI Translation**: Select text → Right-click → "AI Translation"

**AI Annotation**: Click the "AI Annotation" button in the sidebar annotation card

### Dictionary Lookup

- Select a word or short phrase (≤ 4 words) → right-click → "查词 + 详解": with FleurDict installed the FleurDict lookup window opens (dictionary definitions, pronunciation, AI detail, vocabulary book); without it, a built-in popup queries Youdao and the Free Dictionary API directly.
- Select a sentence or paragraph → "AI Translation" as before.
- New words can go to the FleurDict wordbook (full sync pipeline) or to a local wordbook file kept inside the plugin's data folder.

### Sidebar Management

- Click the FleurAnnotation icon in the left toolbar to open the sidebar
- View all annotations, click to jump to the original text
- Delete or edit annotations as needed
- Export all annotations via the "Export Notes" button

## Configuration

In Obsidian Settings → FleurAnnotation:

- **AI Configuration**: Set AI provider (DeepSeek, OpenAI, Zhipu AI, Moonshot, Alibaba Qwen / DashScope, etc.), API Key, Base URL, and model. Switching provider auto-fills its Base URL and recommended model. API key is stored locally only.
- **Annotation Settings**: Customize default highlight color and underline style
- **Export Settings**: Set default export folder
- **Sidebar**: Choose sidebar position (left/right)

## Privacy & Network Use

FleurAnnotation is offline by default. Highlights, underlines, comments, the sidebar and note export touch nothing but your own vault — annotation data is stored as plain JSON files inside your vault (`.obsidian/plugins/fleur-annotation/data/`, or a folder you choose for cross-device sync).

The plugin makes network requests only when you trigger them:

- **AI requests you initiate.** "AI Explanation", "AI Translation" and "AI Annotation" POST the text you have selected, plus the prompt, to the OpenAI-compatible `chat/completions` endpoint you configure under Settings → Base URL — for example `api.deepseek.com`, `api.openai.com`, `open.bigmodel.cn`, `api.moonshot.cn` or `dashscope.aliyuncs.com` (Alibaba Qwen). Nothing is sent unless you invoke an AI action, and only the selected passage goes out, never the whole document.
- **Dictionary lookups you initiate.** Selecting a word/phrase and choosing "查词 + 详解" queries public dictionary services: Youdao (`dict.youdao.com`, JSON API) and the Free Dictionary API (`api.dictionaryapi.dev`). Only the queried word goes out — never the surrounding text or context. If FleurDict is installed and enabled, lookups are handed to the FleurDict plugin instead, whose own network behavior is documented in its repository.
- **Optional web search (Qwen only).** If you turn on "Web search" while the provider is Alibaba Qwen / DashScope, the request sets `enable_search` and Alibaba's service retrieves public web pages server-side so it can answer time-sensitive questions. This adds a per-call search fee on your Alibaba bill.

There is no telemetry, no analytics, no usage tracking, no ads, no remote code or assets, and no self-update mechanism. The plugin never contacts the author's servers, and it does not read or write anything outside your vault.

Your API key stays on your device. By default it is kept in the system keychain through Obsidian's SecretStorage, which means it is not written to `data.json` and does not travel with your vault. If you switch the storage location to `data.json`, it is stored in clear text inside the vault and will sync with it — that tradeoff is your explicit choice, and the settings page warns you about it. The key is only ever transmitted as a `Bearer` token to the Base URL you configured.

One local detail worth knowing: exported annotation notes carry a `source:` field in their frontmatter with the vault-relative path of the annotated note. That file is written into your own vault and is never uploaded anywhere. The optional local wordbook lives in `FleurAnnotation/data/` inside your vault (or syncs through FleurDict if you enable that), and never leaves your device.

## Development

```bash
git clone https://github.com/gibsonchan-5/fleur-annotation.git
cd fleur-annotation
npm install
npm run build
```

## Tech Stack

- TypeScript
- Obsidian API
- OpenAI-compatible AI Integration

## License

MIT License

---

## 中文说明

FleurAnnotation 是一个 Obsidian 插件，为 Markdown 文件提供智能阅读和批注功能。

### 主要特性

- 📝 **高亮标注**：右键选中文本添加高亮，支持自定义颜色
- 📏 **下划线标注**：多种样式（直线、虚线、点线、波浪线）
- 💬 **批注功能**：为选中文本添加个人批注
- 🤖 **AI 辅助**：
  - 智能解释：AI 解释选中的文本内容
  - 智能翻译：一键翻译选中文本
  - AI 批注：自动生成有价值的批注
- 📖 **词典查词**：选中单词/短语（≤4 词）一键查词——装有 FleurDict 时走 FleurDict 查词窗（词典释义、发音、AI 详解、生词本），未装时用内置词典弹窗（有道 + Free Dictionary API）；选中句子则走 AI 翻译
- 📋 **侧边栏管理**：集中查看所有批注，支持快速跳转
- 📤 **导出功能**：一键导出所有批注为独立的 Markdown 笔记

### 安装方法

**社区插件安装（推荐）**
1. 打开 Obsidian 设置 → 社区插件
2. 搜索 "FleurAnnotation"
3. 点击安装并启用

**手动安装**
1. 从 [Releases](https://github.com/gibsonchan-5/fleur-annotation/releases) 下载最新版本
2. 解压到 vault 的 `.obsidian/plugins/fleur-annotation/` 目录
3. 在 Obsidian 设置中启用 FleurAnnotation 插件

### 使用方法

**基本操作**
- 选中文本 → 右键 → 选择"高亮"/"划线"/"批注"
- 在设置中自定义颜色和样式

**AI 功能**
- AI 解释：选中文本 → 右键 → "AI 解释"
- AI 翻译：选中文本 → 右键 → "AI 翻译"
- AI 批注：点击侧边栏批注卡片的"AI 批注"按钮

**词典查词**
- 选中单词/短语 → 右键 → "查词 + 详解"（装有 FleurDict 时走 FleurDict 查词窗，未装时走内置词典弹窗）
- 选中句子/段落 → 右键 → "AI 翻译"
- 生词可加入 FleurDict 生词本（全管线同步）或本插件数据目录内的本地生词本

**侧边栏管理**
- 点击左侧工具栏的 FleurAnnotation 图标打开侧边栏
- 查看所有批注，点击跳转到原文
- 支持删除和编辑批注
- 通过"导出笔记"按钮导出所有批注

### 配置说明

在 Obsidian 设置 → FleurAnnotation 中：

- **AI 配置**：选择 AI 服务商（DeepSeek、OpenAI、智谱 AI、Moonshot、阿里千问/百炼 等）、API Key、Base URL 和模型。切换服务商会自动填入对应的 Base URL 与推荐模型。API Key 仅保存在本地。
- **标注设置**：自定义默认高亮颜色和下划线样式
- **导出设置**：设置默认导出文件夹
- **侧边栏**：选择侧边栏位置（左侧/右侧）

### 隐私与网络使用说明

插件默认完全离线。高亮、划线、批注、侧边栏与导出笔记只读写你自己的 vault——批注数据以普通 JSON 文件形式保存在 vault 内（默认 `.obsidian/plugins/fleur-annotation/data/`，也可在设置里改到用于跨设备同步的目录）。

插件只在你手动触发时发出网络请求：

- **你主动发起的 AI 请求。**「AI 解释」「AI 翻译」和侧边栏的「AI 批注」会把**你选中的那段文字**加上提示词，POST 到你在设置里填的 Base URL 对应的 OpenAI 兼容 `chat/completions` 接口，例如 `api.deepseek.com`、`api.openai.com`、`open.bigmodel.cn`、`api.moonshot.cn`、`dashscope.aliyuncs.com`（阿里千问）。不点 AI 就不会有任何外发，且只发送选中文本，不会上传整篇文档。
- **你主动发起的词典查词。**选中单词/短语后点「查词 + 详解」会请求公开词典服务：有道（`dict.youdao.com` JSON API）与 Free Dictionary API（`api.dictionaryapi.dev`）。外发的只有被查询的单词本身，不会带上前后文或任何笔记内容。如果安装并启用了 FleurDict，查词会转交给 FleurDict 插件完成，其自身的网络行为以其仓库文档为准。
- **可选的联网搜索（仅千问）。** 提供商为阿里千问 / 百炼且开启「联网搜索」时，请求会带上 `enable_search`，由阿里云在服务端检索公开网页以回答时政等时效性问题；这会在你的阿里云账单里额外产生每次调用的搜索费用。

没有遥测、没有数据统计、没有广告、没有远程代码或资源加载、也没有自我更新机制。插件不会连接作者的任何服务器，读写范围不超出你的 vault。

API Key 始终留在你自己的设备上。默认通过 Obsidian 的 SecretStorage 存进系统钥匙串，因此不写入 `data.json`，也不会随 vault 同步；如果你把「密钥保存位置」改成 `data.json`，密钥将以明文存在 vault 内并随其同步——这是你主动选择的取舍，设置页也会给出提示。密钥只会作为 `Bearer` 令牌发往你填写的那个 Base URL。

另外一点本地细节：导出的批注笔记，其 frontmatter 里会有 `source:` 字段，记录被批注笔记在 vault 内的相对路径。这个文件只写进你自己的 vault，不会上传到任何地方。可选的本地生词本保存在 vault 内的 `FleurAnnotation/data/` 目录（或在设置里交给 FleurDict 同步），同样不会离开你的设备。
