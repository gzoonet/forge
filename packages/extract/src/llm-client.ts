export type LLMRequest = {
  system: string
  prompt: string
  model?: string
  maxTokens?: number
}

export type LLMResponse = {
  text: string
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>
}
