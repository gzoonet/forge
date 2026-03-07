import type { LLMClient, LLMRequest, LLMResponse } from '../llm-client'

export type MockResponse = {
  match: (request: LLMRequest) => boolean
  response: string
}

export class MockLLMClient implements LLMClient {
  private responses: MockResponse[] = []
  public calls: LLMRequest[] = []

  addResponse(match: (req: LLMRequest) => boolean, response: string): void {
    this.responses.push({ match, response })
  }

  /**
   * Add a classifier response that triggers on any classifier call
   */
  addClassifyResponse(primary: string, confidence: string = 'high', additional?: string[]): void {
    this.addResponse(
      (req) => req.system.includes('turn classifier'),
      JSON.stringify({ primary, confidence, additional })
    )
  }

  /**
   * Add an extractor response that triggers on a specific extractor system prompt
   */
  addExtractResponse(extractorKeyword: string, data: Record<string, unknown>): void {
    this.addResponse(
      (req) => req.system.includes(extractorKeyword) && !req.system.includes('turn classifier'),
      JSON.stringify(data)
    )
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request)

    for (const r of this.responses) {
      if (r.match(request)) {
        return { text: r.response }
      }
    }

    // Default: return exploration classification for classifier, empty for extractors
    if (request.system.includes('turn classifier')) {
      return { text: JSON.stringify({ primary: 'exploration', confidence: 'low' }) }
    }
    return { text: '{}' }
  }

  reset(): void {
    this.responses = []
    this.calls = []
  }
}
