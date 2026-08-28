import { App, PluginSettingTab, Setting } from 'obsidian';
import type FleurAnnotationPlugin from './main';

export interface FleurSettings {
  aiProvider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  systemPrompt: string;

  highlightColor: string;
  underlineStyle: 'solid' | 'dashed' | 'dotted' | 'wavy';
  underlineColor: string;

  noteFolder: string;

  sidebarPosition: 'right' | 'left';
  sidebarDefaultOpen: boolean;

  readingContextMenu: boolean;
}

export const DEFAULT_SETTINGS: FleurSettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  highlightColor: '#FFD43B',
  underlineStyle: 'solid',
  underlineColor: '#E8590C',
  noteFolder: 'FleurAnnotation',
  sidebarPosition: 'right',
  sidebarDefaultOpen: true,
  readingContextMenu: true,
  temperature: 0.7,
  maxTokens: 8092,
  topP: 0.95,
  systemPrompt: '你是一位专业的阅读助手，擅长把复杂内容解释清楚。回答要求：语言流畅自然，避免生硬的编号列表和小标题；适当分段，关键概念用加粗突出；既要有专业深度，也要通俗易懂，像一篇写得好的读书笔记。',
};

export class FleurSettingTab extends PluginSettingTab {
  plugin: FleurAnnotationPlugin;

  constructor(app: App, plugin: FleurAnnotationPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // AI 配置
    new Setting(containerEl).setHeading().setName('AI 配置');

    const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
      moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    };

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择 AI 服务提供商')
      .addDropdown(dropdown => dropdown
        .addOption('deepseek', 'DeepSeek')
        .addOption('openai', 'OpenAI')
        .addOption('zhipu', '智谱 AI')
        .addOption('moonshot', 'Moonshot')
        .setValue(this.plugin.settings.aiProvider)
        .onChange(async (value) => {
          this.plugin.settings.aiProvider = value;
          const defaults = PROVIDER_DEFAULTS[value];
          if (defaults) {
            this.plugin.settings.baseUrl = defaults.baseUrl;
            this.plugin.settings.model = defaults.model;
          }
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('仅保存在本地')
      .addText(text => text
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('API 基础 URL')
      .addText(text => text
        .setPlaceholder('https://api.deepseek.com/v1')
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('模型')
      .setDesc('使用的 AI 模型')
      .addText(text => text
        .setPlaceholder('deepseek-chat')
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        }));

    // AI 生成参数
    new Setting(containerEl)
      .setName('Temperature（温度）')
      .setDesc('控制输出的随机性，0 最确定，1 最随机，默认 0.7')
      .addSlider(slider => slider
        .setLimits(0, 1, 0.1)
        .setValue(this.plugin.settings.temperature)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.temperature = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max Tokens（最大输出长度）')
      .setDesc('单次回复的最大 token 数，默认 8092')
      .addText(text => text
        .setPlaceholder('8092')
        .setValue(String(this.plugin.settings.maxTokens))
        .onChange(async (value) => {
          const n = parseInt(value);
          if (!isNaN(n) && n > 0 && n <= 128000) {
            this.plugin.settings.maxTokens = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Top P（核采样）')
      .setDesc('从概率最高的词中按比例选取，0.0 最集中，1.0 最多样，默认 0.95')
      .addSlider(slider => slider
        .setLimits(0, 1, 0.05)
        .setValue(this.plugin.settings.topP)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.topP = value;
          await this.plugin.saveSettings();
        }));

    // 自定义 System Prompt
    new Setting(containerEl)
      .setName('System Prompt')
      .setDesc('定义 AI 助手的回答风格，留空则使用默认 prompt')
      .addTextArea(text => text
        .setPlaceholder('输入自定义 prompt…')
        .setValue(this.plugin.settings.systemPrompt)
        .then(textArea => {
          textArea.inputEl.rows = 6;
          textArea.inputEl.addClass('fleur-setting-textarea');
        })
        .onChange(async (value) => {
          this.plugin.settings.systemPrompt = value.trim();
          await this.plugin.saveSettings();
        }));

    // 测试连接按钮
    const testSetting = new Setting(containerEl);
    testSetting.setName('测试连接');
    testSetting.setDesc('验证 API 配置是否正确');
    testSetting.addButton(btn => {
      btn
        .setButtonText('测试')
        .onClick(async () => {
          btn.setButtonText('测试中...');
          btn.setDisabled(true);
          try {
            const { baseUrl, apiKey, model } = this.plugin.settings;
            const response = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 5,
              }),
            });
            if (response.ok) {
              btn.setButtonText('✓ 连接成功');
              btn.buttonEl.addClass('fleur-test-success');
            } else {
              const body = await response.text();
              btn.setButtonText(`✗ 失败 (${response.status})`);
              btn.buttonEl.addClass('fleur-test-error');
            }
          } catch (e) {
            btn.setButtonText('✗ 网络错误');
            btn.buttonEl.addClass('fleur-test-error');
          }
          setTimeout(() => {
            btn.setButtonText('测试');
            btn.setDisabled(false);
            btn.buttonEl.removeClass('fleur-test-success', 'fleur-test-error');
          }, 3000);
        });
    });

    // 标注设置
    new Setting(containerEl).setHeading().setName('标注设置');

    new Setting(containerEl)
      .setName('默认高亮颜色')
      .setDesc('右键高亮时使用的颜色')
      .addColorPicker(color => color
        .setValue(this.plugin.settings.highlightColor)
        .onChange(async (value) => {
          this.plugin.settings.highlightColor = value;
          await this.plugin.saveSettings();
          this.display();
        }))
      .addText(text => text
        .setPlaceholder('#FFD43B')
        .setValue(this.plugin.settings.highlightColor)
        .onChange(async (value) => {
          if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
            this.plugin.settings.highlightColor = value;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    new Setting(containerEl)
      .setName('默认下划线样式')
      .setDesc('右键划线时使用的样式')
      .addDropdown(dropdown => dropdown
        .addOption('solid', '直线')
        .addOption('dashed', '虚线')
        .addOption('dotted', '点线')
        .addOption('wavy', '波浪')
        .setValue(this.plugin.settings.underlineStyle)
        .onChange(async (value) => {
          this.plugin.settings.underlineStyle = value as any;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认下划线颜色')
      .setDesc('右键划线时使用的颜色')
      .addColorPicker(color => color
        .setValue(this.plugin.settings.underlineColor)
        .onChange(async (value) => {
          this.plugin.settings.underlineColor = value;
          await this.plugin.saveSettings();
          this.display();
        }))
      .addText(text => text
        .setPlaceholder('#E8590C')
        .setValue(this.plugin.settings.underlineColor)
        .onChange(async (value) => {
          if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
            this.plugin.settings.underlineColor = value;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    // 笔记导出
    new Setting(containerEl).setHeading().setName('笔记导出');

    const folderSet = new Set<string>();
    folderSet.add('FleurAnnotation');
    this.app.vault.getAllLoadedFiles().forEach(file => {
      if (file.path.includes('/')) {
        const parts = file.path.split('/');
        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          folderSet.add(current);
        }
      }
    });
    const folders = Array.from(folderSet).sort();

    new Setting(containerEl)
      .setName('导出文件夹')
      .setDesc('选择笔记导出的存放文件夹，默认为 Vault 根目录下的 FleurAnnotation 文件夹')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'Vault 根目录');
        folders.forEach(folder => {
          if (folder) dropdown.addOption(folder, folder);
        });
        dropdown.setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value;
            await this.plugin.saveSettings();
          });
      });

    // 菜单设置
    new Setting(containerEl).setHeading().setName('菜单设置');

    new Setting(containerEl)
      .setName('阅读模式右键菜单')
      .setDesc('开启后在阅读模式下右键选中文本会显示 FleurAnnotation 菜单；关闭则不拦截，避免与其他插件冲突')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.readingContextMenu)
        .onChange(async (value) => {
          this.plugin.settings.readingContextMenu = value;
          await this.plugin.saveSettings();
        }));

    // 侧边栏配置
    new Setting(containerEl).setHeading().setName('侧边栏配置');

    new Setting(containerEl)
      .setName('侧边栏位置')
      .setDesc('选择侧边栏显示位置')
      .addDropdown(dropdown => dropdown
        .addOption('right', '右侧')
        .addOption('left', '左侧')
        .setValue(this.plugin.settings.sidebarPosition)
        .onChange(async (value) => {
          this.plugin.settings.sidebarPosition = value as 'right' | 'left';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认打开侧边栏')
      .setDesc('打开 Markdown 文件时自动显示侧边栏')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.sidebarDefaultOpen)
        .onChange(async (value) => {
          this.plugin.settings.sidebarDefaultOpen = value;
          await this.plugin.saveSettings();
        }));
  }
}
