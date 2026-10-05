// AI 服务层 - 流式 API 调用
import type FleurAnnotationPlugin from './main';

export class AIService {
  private plugin: FleurAnnotationPlugin;

  constructor(plugin: FleurAnnotationPlugin) {
    this.plugin = plugin;
  }

  async streamChat(
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    onDone?: () => void,
    onError?: (error: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { baseUrl, apiKey, model, temperature, maxTokens, topP, aiProvider, aiWebSearch } = this.plugin.settings;

    if (!baseUrl || !apiKey) {
      onError?.('请先配置 API 地址和密钥');
      return;
    }

    // 联网搜索只在百炼（DashScope）下发：enable_search 是它的私有字段，
    // DeepSeek / OpenAI 这类接口遇到未知顶层字段会返回 400，所以按提供商再兜一层。
    // baseUrl 也判一次，覆盖「提供商选 OpenAI、Base URL 手填 dashscope」的用法。
    const enableWebSearch = !!aiWebSearch
      && (aiProvider === 'qwen' || baseUrl.includes('dashscope'));

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
          // turbo = 官方默认策略，单次检索，附加费最低。
          // 兼容协议下 enable_source / enable_citation 不生效，故只传策略本身。
          ...(enableWebSearch
            ? { enable_search: true, search_options: { search_strategy: 'turbo' } }
            : {}),
        }),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        onError?.(`API 请求失败 (${response.status}): ${errorText}`);
        return;
      }

      if (!response.body) {
        onError?.('响应体为空');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            onDone?.();
            return;
          }

          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              onChunk(content);
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      }

      onDone?.();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return; // 用户取消，不报错
      }
      onError?.(error instanceof Error ? error.message : '未知错误');
    }
  }
}
