import Anthropic from '@anthropic-ai/sdk'
import type { LLMClient, LLMRequest, LLMResponse } from './llm-client'

const DEFAULT_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

export class AnthropicClient implements LLMClient {
  private client: Anthropic
  private modelMap: Record<string, string>

  constructor(apiKey?: string, modelOverrides?: Record<string, string>) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined)
    this.modelMap = { ...DEFAULT_MODELS, ...modelOverrides }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = this.modelMap[request.model ?? 'sonnet'] ?? request.model ?? this.modelMap.sonnet

    const response = await this.client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 500,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    })

    const textBlock = response.content.find(b => b.type === 'text')
    return { text: textBlock?.text ?? '' }
  }
}
