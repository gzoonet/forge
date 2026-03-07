import type { TurnType } from '@gzoo/forge-core'
import type { LLMClient } from './llm-client'
import { CLASSIFY_SYSTEM_PROMPT, buildClassifyPrompt } from './prompts/classify'

export type ClassificationResult = {
  primary: TurnType
  confidence: 'high' | 'medium' | 'low'
  additional?: TurnType[]
}

const VALID_TURN_TYPES: TurnType[] = [
  'goal_statement', 'decision', 'constraint_stated', 'rejection',
  'exploration', 'approval', 'correction', 'question', 'elaboration', 'meta',
]

export async function classify(
  turn: string,
  recentContext: string,
  llmClient: LLMClient
): Promise<ClassificationResult> {
  const prompt = buildClassifyPrompt(turn, recentContext)

  const response = await llmClient.complete({
    system: CLASSIFY_SYSTEM_PROMPT,
    prompt,
    model: 'haiku',
    maxTokens: 200,
  })

  const parsed = parseClassificationResponse(response.text)
  return parsed
}

function parseClassificationResponse(text: string): ClassificationResult {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const primary = validateTurnType(parsed.primary)
    const confidence = validateConfidence(parsed.confidence)
    const additional = parsed.additional
      ? (parsed.additional as string[]).map(validateTurnType).filter((t): t is TurnType => t !== null)
      : undefined

    return {
      primary: primary ?? 'exploration', // Default to exploration if invalid
      confidence: confidence ?? 'low',
      additional: additional && additional.length > 0 ? additional : undefined,
    }
  } catch {
    // If parsing fails entirely, default to exploration with low confidence
    return { primary: 'exploration', confidence: 'low' }
  }
}

function validateTurnType(type: string): TurnType | null {
  if (VALID_TURN_TYPES.includes(type as TurnType)) {
    return type as TurnType
  }
  return null
}

function validateConfidence(conf: string): 'high' | 'medium' | 'low' | null {
  if (conf === 'high' || conf === 'medium' || conf === 'low') return conf
  return null
}
