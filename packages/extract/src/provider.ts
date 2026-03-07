import type { LLMClient } from './llm-client'
import { AnthropicClient } from './anthropic-client'
import { OpenAIClient } from './openai-client'

export type ProviderConfig = {
  provider: 'anthropic' | 'openai' | 'openai-compatible'
  apiKey: string
  baseURL?: string
  fastModel?: string
  qualityModel?: string
}

export function createLLMClient(config: ProviderConfig): LLMClient {
  const modelMap: Record<string, string> = {}

  if (config.fastModel) modelMap.haiku = config.fastModel
  if (config.qualityModel) modelMap.sonnet = config.qualityModel

  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient(config.apiKey, modelMap)

    case 'openai':
    case 'openai-compatible':
      return new OpenAIClient({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        modelMap,
      })

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`)
  }
}

export function resolveProviderConfig(): ProviderConfig {
  const provider = (process.env.FORGE_LLM_PROVIDER ?? detectProvider()) as ProviderConfig['provider']
  const fastModel = process.env.FORGE_FAST_MODEL
  const qualityModel = process.env.FORGE_QUALITY_MODEL

  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when using the Anthropic provider')
      return { provider, apiKey, fastModel, qualityModel }
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('OPENAI_API_KEY is required when using the OpenAI provider')
      return { provider, apiKey, fastModel, qualityModel }
    }

    case 'openai-compatible': {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('OPENAI_API_KEY is required when using the OpenAI-compatible provider')
      const baseURL = process.env.OPENAI_BASE_URL
      if (!baseURL) throw new Error('OPENAI_BASE_URL is required when using the OpenAI-compatible provider')
      return { provider, apiKey, baseURL, fastModel, qualityModel }
    }

    default:
      throw new Error(
        `No LLM provider configured. Set FORGE_LLM_PROVIDER and the corresponding API key.\n` +
        `See .env.example for configuration options.`
      )
  }
}

function detectProvider(): string {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) return 'openai-compatible'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return ''
}
