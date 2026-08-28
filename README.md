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

### Sidebar Management

- Click the FleurAnnotation icon in the left toolbar to open the sidebar
- View all annotations, click to jump to the original text
- Delete or edit annotations as needed
- Export all annotations via the "Export Notes" button

## Configuration

In Obsidian Settings → FleurAnnotation:

- **AI Configuration**: Set AI provider (DeepSeek, OpenAI, Zhipu AI, Moonshot, etc.), API Key, Base URL, and model. API key is stored locally only.
- **Annotation Settings**: Customize default highlight color and underline style
- **Export Settings**: Set default export folder
- **Sidebar**: Choose sidebar position (left/right)

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

**侧边栏管理**
- 点击左侧工具栏的 FleurAnnotation 图标打开侧边栏
- 查看所有批注，点击跳转到原文
- 支持删除和编辑批注
- 通过"导出笔记"按钮导出所有批注

### 配置说明

在 Obsidian 设置 → FleurAnnotation 中：

- **AI 配置**：设置 AI 服务商（DeepSeek、OpenAI、智谱 AI、Moonshot 等）、API Key、Base URL 和模型。API Key 仅保存在本地。
- **标注设置**：自定义默认高亮颜色和下划线样式
- **导出设置**：设置默认导出文件夹
- **侧边栏**：选择侧边栏位置（左侧/右侧）
