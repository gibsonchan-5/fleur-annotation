import { App, PluginSettingTab, Setting, DropdownComponent, Notice } from 'obsidian';
import type FleurAnnotationPlugin from './main';
import { getFleurDictBridge } from './dict-bridge';
import { WordbookManagerModal } from './wordbook-manager-modal';
import {
  PROMPT_PRESETS,
  getPromptPreset,
  getPresetPreview,
  isCustomPresetKey,
  getCustomSlot,
  ANNOTATION_DEFAULT_BASE_LIMIT,
} from './ai-prompts';
import type { PromptPresetKey } from './ai-prompts';

/** 独立生词本词条（dictSyncWordbook = false 时写入 settings.wordbook；与 fleur-pdf / fleur-epub 同构） */
export interface WordbookItem {
  word: string;
  meaning: string;
  phonetic: string;
  context?: string;
  addedAt: string;
}

export interface FleurSettings {
  aiProvider: string;
  apiKey: string;
  /** 密钥保存位置：system=系统钥匙串（默认），vault=data.json 明文随 vault 同步。 */
  secretStorageMode: 'system' | 'vault';
  baseUrl: string;
  model: string;
  /**
   * 联网搜索（仅阿里云百炼/千问支持）：请求体带 enable_search，让模型先检索再生成。
   * 非 DashScope 接口不认这个字段，所以实际发送前还要按提供商再判一次（见 ai-service.ts）。
   */
  aiWebSearch: boolean;
  temperature: number;
  maxTokens: number;
  topP: number;

  // 提示词体系（仿 FleurPDF：预设模式 + 三个自定义槽）
  promptPreset: PromptPresetKey; // AI 提示词预设模式
  customPrompts: string[]; // 三个用户自定义提示词模版（custom-1/2/3 对应）
  annotationLimit: number; // 侧边栏 AI 批注基准字数上限（正文「询问 AI」不限）

  highlightColor: string;
  underlineStyle: 'solid' | 'dashed' | 'dotted' | 'wavy';
  underlineColor: string;

  noteFolder: string;
  exportTags: string;

  // 跨设备同步批注数据（对齐 fleurEpub「分域存储 + 合并写 + 墓碑」方案）
  syncAnnotationsToVault?: boolean; // 开启后批注写入 Vault 内普通目录，随同步器跨设备流转
  annotationsDataDir?: string; // 同步模式数据目录（Vault 内相对路径）
  annotationsSyncMigrated?: boolean; // 一次性迁移标记：配置目录存量 sidecar 已搬入同步目录

  sidebarPosition: 'right' | 'left';
  sidebarDefaultOpen: boolean;
  annotationSort: 'line' | 'time';
  annotationSortMigrated?: boolean;

  readingContextMenu: boolean;

  // ── 词典查词与生词本（移植自 fleur-pdf；桥接 FleurDict，需 FleurDict ≥ 1.5.12） ──
  /** 查词来源（fleur-annotation 内查词固定用此选项，不读取 FleurDict 的设置） */
  dictSource: 'youdao' | 'free-dict';
  /** 内置查词弹窗位置/尺寸记忆（对齐 FleurDict：拖拽/缩放后持久化，下次打开恢复） */
  dictPopupRect?: { left: number; top: number; width: number; height: number };
  /** 生词本同步：true = 写入 FleurDict 词库（联动闪卡/词高亮/欧路同步）；false = 存 fleur-annotation 独立生词本（wordbook） */
  dictSyncWordbook: boolean;
  /** 独立生词本（仅 dictSyncWordbook = false 时写入；存 data.json，跨设备随配置目录） */
  wordbook: WordbookItem[];
  /**
   * 独立生词本跨设备同步（默认关）。开启后 wordbook 双向合并到 Vault 内
   * FleurAnnotation/data/wordbook.json（随同步插件跨设备；删除走墓碑防复活），
   * data.json 保留作本机回退。
   */
  wordbookSync: boolean;
}

/** 旧版默认 System Prompt（仅用于迁移判断：与默认值相同则无需迁移） */
export const LEGACY_DEFAULT_SYSTEM_PROMPT =
  '你是一位专业的阅读助手，擅长把复杂内容解释清楚。回答要求：语言流畅自然，避免生硬的编号列表和小标题；适当分段，关键概念用加粗突出；既要有专业深度，也要通俗易懂，像一篇写得好的读书笔记。';

export const DEFAULT_SETTINGS: FleurSettings = {
  aiProvider: 'deepseek',
  apiKey: '',
  secretStorageMode: 'system',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  aiWebSearch: false,
  highlightColor: '#FFD43B',
  underlineStyle: 'solid',
  underlineColor: '#E8590C',
  noteFolder: 'FleurAnnotation',
  exportTags: 'fleur-annotation,批注导出',
  syncAnnotationsToVault: false,
  annotationsDataDir: 'FleurAnnotation/data',
  sidebarPosition: 'right',
  sidebarDefaultOpen: true,
  annotationSort: 'line',
  readingContextMenu: true,
  dictSource: 'youdao',
  dictSyncWordbook: true,
  wordbook: [],
  wordbookSync: false,
  temperature: 0.7,
  maxTokens: 8092,
  topP: 0.95,
  promptPreset: 'default',
  customPrompts: ['', '', ''],
  annotationLimit: ANNOTATION_DEFAULT_BASE_LIMIT,
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

    // 预置提供商：均为 OpenAI 兼容接口，与 fleur-epub / fleurdict 的同名条目保持一致
    const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
      moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
      // 阿里云百炼（千问 / 通义千问）：compatible-mode 是 OpenAI 兼容路径。
      // 北京/新加坡/美国/香港各区只是域名不同，路径都以 /compatible-mode/v1 结尾，
      // 用国际站密钥时把域名改成 dashscope-intl 即可。
      qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    };

    new Setting(containerEl)
      .setName('AI 提供商')
      .setDesc('选择 AI 服务提供商（均为 OpenAI 兼容接口；切换后自动填入该家的 Base URL 与默认模型）')
      .addDropdown(dropdown => dropdown
        .addOption('deepseek', 'DeepSeek')
        .addOption('openai', 'OpenAI')
        .addOption('zhipu', '智谱 AI')
        .addOption('moonshot', 'Moonshot')
        .addOption('qwen', '阿里 · 千问（通义千问 / 百炼）')
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

    // 密钥存储位置
    const secretSection = containerEl.createDiv('fleurannotation-settings-section');
    new Setting(secretSection).setHeading().setName('密钥存储');

    secretSection.createEl('p', {
      text: '决定 API Key 保存在哪里。切换后密钥会自动搬到新位置，不会丢失，也不需要重新填写。',
      cls: 'setting-item-description',
    });

    new Setting(secretSection)
      .setName('密钥保存位置')
      .setDesc(
        this.plugin.secretStorageAvailable
          ? '系统钥匙串更安全，但密钥不进 vault，因此每台设备都要各自填写一次；data.json 可随 vault 同步给多台设备共用，代价是密钥以明文保存在仓库中。'
          : '当前 Obsidian 版本不支持系统钥匙串，密钥只能明文保存在 data.json。',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('system', '系统钥匙串（推荐）');
        dropdown.addOption('vault', 'data.json（随 vault 同步）');
        dropdown.setValue(this.plugin.secretBackend);
        if (!this.plugin.secretStorageAvailable) {
          dropdown.setDisabled(true);
        }
        dropdown.onChange(async (value) => {
          const mode = value === 'vault' ? 'vault' : 'system';
          const result = await this.plugin.setSecretStorageMode(mode);
          if (!result.ok) {
            new Notice('FleurAnnotation：密钥移入系统钥匙串失败，已保持原设置');
          } else if (mode === 'vault') {
            new Notice('FleurAnnotation：密钥将以明文保存在 data.json，并随 vault 同步');
          } else {
            new Notice('FleurAnnotation：密钥已移入系统钥匙串，data.json 中不再保存明文');
          }
          // 重新渲染，让密钥说明与警告同步更新
          this.display();
        });
      });

    if (this.plugin.secretStorageAvailable && this.plugin.secretBackend === 'vault') {
      secretSection.createEl('p', {
        text: '注意：当前为明文存储。密钥会随 Obsidian Sync / iCloud / OneDrive 上传到云端，请确认你接受这一点。',
        cls: 'setting-item-description mod-warning',
      });
    }

    new Setting(containerEl)
      .setName('API Key')
      .setDesc(this.secretDesc())
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

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

    // 联网搜索：enable_search 是百炼（DashScope）的私有字段，DeepSeek / OpenAI 收到未知字段会直接 400，
    // 所以这一项只在提供商是千问、或 Base URL 指向 dashscope 时出现，发送前还会再判一次。
    const isDashScope = this.plugin.settings.aiProvider === 'qwen'
      || (this.plugin.settings.baseUrl ?? '').includes('dashscope');

    if (isDashScope) {
      new Setting(containerEl)
        .setName('联网搜索')
        .setDesc(
          '模型自带的训练知识有截止日期（千问目前最新权重停在 2026 年年中），问时政、近期事件等时效内容时建议开启：'
          + '请求会先联网检索再生成，用 turbo 策略（默认档，成本最低）。'
          + '计费 = 模型原本的 token 费 + 每次调用一笔搜索调用费，且侧边栏「AI 生成批注」和正文「询问 AI」都会走检索，按成本需要权衡。',
        )
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.aiWebSearch ?? false)
          .onChange(async (value) => {
            this.plugin.settings.aiWebSearch = value;
            await this.plugin.saveSettings();
          }));
    }

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

    // ── 提示词模式（预设选项卡，仿 FleurPDF） ──
    //
    // 切换模式时只重绘下方的「详情区」，不调用 this.display() 重建整个面板。
    // 重建会销毁当前获得焦点的 <select>，浏览器在 DOM 变动后重新定位焦点，
    // 表现为设置窗口自己滚动一下。局部重绘即可避免。
    let dropdownComp: DropdownComponent | null = null;

    new Setting(containerEl)
      .setName('提示词模式')
      .setDesc('选择 AI 生成批注与回答时的角色定位。内置 7 个阅读助手模版，另可自定义 3 个提示词模版')
      .addDropdown(dropdown => {
        dropdownComp = dropdown;
        PROMPT_PRESETS.forEach(p => dropdown.addOption(p.key, p.label));
        dropdown.setValue(this.plugin.settings.promptPreset)
          .onChange(async (value) => {
            this.plugin.settings.promptPreset = value as PromptPresetKey;
            await this.plugin.saveSettings();
            renderPromptDetail();
          });
      });

    const promptDetailEl = containerEl.createDiv();
    promptDetailEl.addClass('fleur-setting-prompt-detail');

    const renderPromptDetail = () => {
      promptDetailEl.empty();
      const preset = getPromptPreset(this.plugin.settings.promptPreset) ?? PROMPT_PRESETS[0];
      const baseLimit = this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT;

      if (isCustomPresetKey(this.plugin.settings.promptPreset)) {
        const slot = getCustomSlot(this.plugin.settings.promptPreset);
        new Setting(promptDetailEl)
          .setName(`自定义提示词 ${slot}`)
          .setDesc('留空则回落到「默认」模式。可配置 3 个自定义模版，在下拉中选择对应槽位使用')
          .setClass('fleur-setting-block')
          .addTextArea(text => text
            .setPlaceholder('在此写下你自己的系统提示词。例如：你是一位……请根据用户高亮的文本……')
            .setValue(this.plugin.settings.customPrompts[slot - 1] ?? '')
            .then(textArea => {
              textArea.inputEl.rows = 10;
            })
            .onChange(async (value) => {
              const idx = slot - 1;
              if (!this.plugin.settings.customPrompts) this.plugin.settings.customPrompts = ['', '', ''];
              this.plugin.settings.customPrompts[idx] = value;
              await this.plugin.saveSettings();
            }));
      } else {
        const previewSetting = new Setting(promptDetailEl)
          .setName('当前提示词')
          .setDesc(`仅侧边栏「AI 生成批注」受 ${baseLimit} 字限制（原文过长自动放宽），正文「询问 AI」不限。`);

        // 用一个 wrapper 包住「提示词正文」和「附注」，让 wrapper 整体占满剩余空间，
        // 避免附注和铅笔按钮跟预览框在 flex 容器里平级抢宽度。
        const previewWrap = previewSetting.controlEl.createDiv();
        previewWrap.addClass('fleur-setting-prompt-block');

        const preview = previewWrap.createDiv();
        preview.addClass('fleur-setting-prompt-preview');
        preview.textContent = getPresetPreview(preset, baseLimit);

        previewSetting.addExtraButton(btn => btn
          .setIcon('pencil')
          .setTooltip('以此为基础改为自定义')
          .onClick(async () => {
            // 当前已在自定义槽则覆写该槽，否则写入「自定义 1」并切换过去
            const current = this.plugin.settings.promptPreset;
            const slot = isCustomPresetKey(current) ? getCustomSlot(current) : 1;
            this.plugin.settings.promptPreset = (`custom-${slot}`) as PromptPresetKey;
            const idx = slot - 1;
            if (!this.plugin.settings.customPrompts) this.plugin.settings.customPrompts = ['', '', ''];
            this.plugin.settings.customPrompts[idx] = preset.body;
            await this.plugin.saveSettings();
            dropdownComp?.setValue(this.plugin.settings.promptPreset);
            renderPromptDetail();
          }));
      }
    };

    renderPromptDetail();

    // 侧边栏 AI 批注字数上限（正文「询问 AI」不受此限制）
    new Setting(containerEl)
      .setName('侧边栏批注字数上限')
      .setDesc('侧边栏「AI 生成批注」的输出基准字数。选中原文较长时上限会自动放宽；正文「询问 AI」不设字数限制')
      .addSlider(slider => slider
        .setLimits(100, 600, 10)
        .setValue(this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.annotationLimit = value;
          await this.plugin.saveSettings();
          renderPromptDetail();
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

    // 词典查词与生词本（移植自 fleur-pdf；桥接 FleurDict）
    new Setting(containerEl).setHeading().setName('词典查词');

    // FleurDict 检测状态提示（对齐 fleur-pdf：让用户知道桥接是否可用）
    new Setting(containerEl)
      .setName('FleurDict 桥接')
      .setDesc(
        getFleurDictBridge(this.app)
          ? '已检测到 FleurDict：笔记里选中单词 / 短语可查词（含 AI 详解、加入生词本），选中句子可 AI 翻译。'
          : '未检测到 FleurDict（或版本低于 1.5.12）：选中单词将使用内置词典查词，功能不缺席；安装并启用 FleurDict 后自动切换为它的查词窗。',
      );

    new Setting(containerEl)
      .setName('查词来源')
      .setDesc('内置词典查词使用的数据源（FleurDict 查词窗同样遵循此选择）')
      .addDropdown(dropdown => dropdown
        .addOption('youdao', '有道词典（中英释义）')
        .addOption('free-dict', 'Free Dictionary（英文释义）')
        .setValue(this.plugin.settings.dictSource)
        .onChange(async (value) => {
          this.plugin.settings.dictSource = value === 'free-dict' ? 'free-dict' : 'youdao';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('生词本与 FleurDict 同步')
      .setDesc('开启 = 加入生词本时写入 FleurDict 词库（闪卡复习、生词高亮、欧路同步全链路生效）；关闭 = 存入 fleur-annotation 独立生词本，与 FleurDict 互不影响')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.dictSyncWordbook)
        .onChange(async (value) => {
          this.plugin.settings.dictSyncWordbook = value;
          await this.plugin.saveSettings();
          if (wordbookEntry) wordbookEntry.setDesc(wordbookDesc());
        }));

    /** 描述文案随「生词本与 FleurDict 同步」开关状态变化（供初始渲染与原地刷新共用）。 */
    const wordbookDesc = () => {
      const count = this.plugin.settings.wordbook.length;
      return this.plugin.settings.dictSyncWordbook
        ? (count > 0
            ? `另有 ${count} 条历史词条存于本插件（开启同步前落的词，保留不动；新查的词已写入 FleurDict）`
            : '为空（开启同步中：新查的词将写入 FleurDict 词库）')
        : `当前 ${count} 词（存于本插件 data.json；勾选上方同步后新查的词将写入 FleurDict，已有词条保留不动）`;
    };
    let wordbookEntry: Setting | null = null;
    {
      const entry = new Setting(containerEl).setName('独立生词本').setDesc(wordbookDesc());
      wordbookEntry = entry;
      entry.addButton(button => button
        .setButtonText('管理')
        .setDisabled(this.plugin.settings.wordbook.length === 0)
        .onClick(() => {
          new WordbookManagerModal(this.plugin).open();
        }));
    }

    // ── 独立生词本跨设备同步（与 FleurDict 同步互不相干：只管本插件的独立词库） ──
    new Setting(containerEl)
      .setName('独立生词本跨设备同步')
      .setDesc(
        '开启后，独立生词本双向同步到 Vault 内 FleurAnnotation/data/wordbook.json，可被 Remotely Save / iCloud 等同步到其他设备（增删改全同步，删除走墓碑不会复活；data.json 保留作本机回退）。' +
          '需在每台设备上分别开启；仅「生词本与 FleurDict 同步」关闭（独立词库）时有意义。',
      )
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.wordbookSync ?? false)
        .onChange(async (value) => {
          this.plugin.settings.wordbookSync = value;
          await this.plugin.saveSettings();
          if (value) {
            const changed = await this.plugin.wordbookSync.pullAndMerge('local-change');
            if (changed) this.plugin.app.workspace.trigger('fleur-annotation:wordbook-changed');
          }
        }));

    // 笔记导出
    new Setting(containerEl).setHeading().setName('笔记导出');

    const folderSet = new Set<string>();
    folderSet.add('FleurAnnotation');
    // 直接枚举 vault 里的文件夹（含空文件夹）。不要用 getAllLoadedFiles 反推祖先目录，
    // 那样空文件夹永远不会出现在下拉里。getAllFolders() @since 1.6.6，默认不含根目录。
    for (const folder of this.app.vault.getAllFolders()) {
      folderSet.add(folder.path);
    }
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

    new Setting(containerEl)
      .setName('导出自动标签')
      .setDesc('导出笔记时自动添加到文件属性（frontmatter）的标签，多个标签用逗号或空格分隔')
      .addText(text => text
        .setPlaceholder('fleur-annotation,批注导出')
        .setValue(this.plugin.settings.exportTags)
        .onChange(async (value) => {
          this.plugin.settings.exportTags = value.trim();
          await this.plugin.saveSettings();
        }));

    // 跨设备同步
    new Setting(containerEl)
      .setName('跨设备同步批注数据')
      .setDesc('开启后批注数据写入 Vault 内普通目录（而非 .obsidian 隐藏目录），可随 iCloud、Obsidian Sync、Remotely Save 等同步器在桌面端与移动端之间同步；内置合并写与删除墓碑机制，两端同时改动不会互相覆盖丢数据。开关关闭时数据仍存配置目录，行为与旧版一致。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncAnnotationsToVault ?? false)
        .onChange(async (value) => {
          this.plugin.settings.syncAnnotationsToVault = value;
          await this.plugin.saveSettings();
          syncDirSetting.settingEl.toggleClass('fleur-setting-disabled', !value);
        }));
    const syncDirSetting = new Setting(containerEl)
      .setName('批注数据目录')
      .setDesc('同步模式下批注数据在 Vault 内的存放目录。默认放在批注导出文件夹 FleurAnnotation 下的 data 子目录（与 FleurEpub 的目录结构同款），不另建顶层文件夹。改动后立即生效，旧目录中的数据启动时自动并入新目录。')
      .addText(text => text
        .setPlaceholder('FleurAnnotation/data')
        .setValue(this.plugin.settings.annotationsDataDir ?? 'FleurAnnotation/data')
        .onChange(async (value) => {
          this.plugin.settings.annotationsDataDir = value.trim();
          await this.plugin.saveSettings();
        }));
    syncDirSetting.settingEl.toggleClass('fleur-setting-disabled', !(this.plugin.settings.syncAnnotationsToVault ?? false));

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

    new Setting(containerEl)
      .setName('批注排序')
      .setDesc('侧边栏批注的排序方式：按内文顺序（文档中出现先后）或按时间（最近创建的在前）')
      .addDropdown(dropdown => dropdown
        .addOption('line', '按内文顺序')
        .addOption('time', '按时间排序')
        .setValue(this.plugin.settings.annotationSort)
        .onChange(async (value) => {
          this.plugin.settings.annotationSort = value as 'line' | 'time';
          await this.plugin.saveSettings();
          this.plugin.refreshSidebar();
        }));
  }

  /**
   * 描述密钥当前保存在哪里，措辞与「密钥保存位置」设置保持一致。
   */
  private secretDesc(): string {
    if (!this.plugin.secretStorageAvailable) {
      return 'API Key。当前 Obsidian 版本不支持系统钥匙串，将以明文保存在 data.json。';
    }
    return this.plugin.secretBackend === 'system'
      ? 'API Key。已保存在系统钥匙串，不会写入 data.json，也不会随 vault 同步。'
      : 'API Key。当前以明文保存在 data.json，会随 vault 同步到其他设备。';
  }
}
