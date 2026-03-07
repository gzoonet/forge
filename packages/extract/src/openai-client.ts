import type { LLMClient, LLMRequest, LLMResponse } from './llm-client'

const DEFAULT_MODELS: Record<string, string> = {
  haiku: 'gpt-4o-mini',
  sonnet: 'gpt-4o',
}

export type OpenAIClientOptions = {
  apiKey: string
  baseURL?: string
  modelMap?: Record<string, string>
}

export class OpenAIClient implements LLMClient {
  private apiKey: string
  private baseURL: string
  private modelMap: Record<string, string>

  constructor(options: OpenAIClientOptions) {
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.modelMap = { ...DEFAULT_MODELS, ...options.modelMap }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const model = this.modelMap[request.model ?? 'sonnet'] ?? request.model ?? this.modelMap.sonnet

    const body = {
      model,
      max_tokens: request.maxTokens ?? 500,
      messages: [
        { role: 'system' as const, content: request.system },
        { role: 'user' as const, content: request.prompt },
      ],
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM API error (${response.status}): ${errorText}`)
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[]
    }

    return { text: data.choices?.[0]?.message?.content ?? '' }
  }
}
