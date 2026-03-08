import type { TurnType, Provenance } from '@gzoo/forge-core'
import type { LLMClient } from './llm-client'
import { DECISION_EXTRACT_SYSTEM_PROMPT } from './prompts/decision'
import { CONSTRAINT_EXTRACT_SYSTEM_PROMPT } from './prompts/constraint'
import { REJECTION_EXTRACT_SYSTEM_PROMPT } from './prompts/rejection'
import { EXPLORATION_EXTRACT_SYSTEM_PROMPT } from './prompts/exploration'
import { CORRECTION_EXTRACT_SYSTEM_PROMPT } from './prompts/correction'
import { GOAL_EXTRACT_SYSTEM_PROMPT } from './prompts/goal'
import { APPROVAL_EXTRACT_SYSTEM_PROMPT } from './prompts/approval'
import { ELABORATION_EXTRACT_SYSTEM_PROMPT } from './prompts/elaboration'

export type ExtractedDecision = {
  statement: string
  rationale: string
  alternatives: string[]
  commitment: 'decided' | 'leaning'
  certainty: 'assumed' | 'uncertain' | 'evidenced' | 'validated'
  category: 'market' | 'product' | 'technical' | 'business' | 'operational' | 'brand'
}

export type ExtractedConstraint = {
  statement: string
  hardness: 'hard' | 'soft'
  type: 'technical' | 'financial' | 'market' | 'timeline' | 'operational' | 'aesthetic' | 'ethical' | 'regulatory' | 'strategic'
  certainty: 'assumed' | 'uncertain' | 'evidenced'
}

export type ExtractedRejection = {
  statement: string
  rejectionType: 'categorical' | 'conditional' | 'deferred'
  reason: string
  category: 'market' | 'product' | 'technical' | 'business' | 'operational' | 'brand'
  revivalCondition: string | null
  revealsPreference: string | null
  contributesToValues: boolean
}

export type ExtractedExploration = {
  topic: string
  direction: string
  openQuestions: string[]
  consideredOptions: string[]
  resolutionCondition: string | null
}

export type ExtractedCorrection = {
  correcting: string
  correction: string
  isPermanent: boolean
  reason: string | null
  targetType: 'decision' | 'constraint' | 'exploration' | null
}

export type ExtractedGoal = {
  statement: string
  successCriteria: string[]
  commitment: 'exploring' | 'leaning' | 'decided'
}

export type ExtractedApproval = {
  targetDescription: string
  scope: 'full' | 'partial'
  promotionIntent: boolean
  comment: string | null
}

export type ExtractedElaboration = {
  targetDescription: string
  additions: string[]
  modifies: Record<string, string> | null
}

export type ExtractedNode =
  | { turnType: 'decision'; data: ExtractedDecision }
  | { turnType: 'constraint_stated'; data: ExtractedConstraint }
  | { turnType: 'rejection'; data: ExtractedRejection }
  | { turnType: 'exploration'; data: ExtractedExploration }
  | { turnType: 'correction'; data: ExtractedCorrection }
  | { turnType: 'goal_statement'; data: ExtractedGoal }
  | { turnType: 'approval'; data: ExtractedApproval }
  | { turnType: 'elaboration'; data: ExtractedElaboration }

const SYSTEM_PROMPTS: Partial<Record<TurnType, string>> = {
  decision: DECISION_EXTRACT_SYSTEM_PROMPT,
  constraint_stated: CONSTRAINT_EXTRACT_SYSTEM_PROMPT,
  rejection: REJECTION_EXTRACT_SYSTEM_PROMPT,
  exploration: EXPLORATION_EXTRACT_SYSTEM_PROMPT,
  correction: CORRECTION_EXTRACT_SYSTEM_PROMPT,
  goal_statement: GOAL_EXTRACT_SYSTEM_PROMPT,
  approval: APPROVAL_EXTRACT_SYSTEM_PROMPT,
  elaboration: ELABORATION_EXTRACT_SYSTEM_PROMPT,
}

// Turn types that produce extractable nodes
const EXTRACTABLE_TYPES: TurnType[] = [
  'decision', 'constraint_stated', 'rejection',
  'exploration', 'correction', 'goal_statement', 'approval', 'elaboration',
]

export function isExtractable(turnType: TurnType): boolean {
  return EXTRACTABLE_TYPES.includes(turnType)
}

export async function extract(
  turnType: TurnType,
  turn: string,
  recentContext: string,
  llmClient: LLMClient
): Promise<ExtractedNode | null> {
  const systemPrompt = SYSTEM_PROMPTS[turnType]
  if (!systemPrompt) return null

  const prompt = recentContext
    ? `Recent conversation context:\n${recentContext}\n\nTurn to extract from:\n"${turn}"`
    : `Turn to extract from:\n"${turn}"`

  const response = await llmClient.complete({
    system: systemPrompt,
    prompt,
    model: 'sonnet',
    maxTokens: 500,
  })

  try {
    const cleaned = response.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const data = JSON.parse(cleaned)

    return { turnType, data } as ExtractedNode
  } catch {
    // First attempt failed — retry with explicit JSON instruction
    console.warn(`[forge-extract] JSON parse failed for ${turnType} extraction, retrying. Raw: ${response.text.slice(0, 200)}`)

    try {
      const retryResponse = await llmClient.complete({
        system: systemPrompt,
        prompt: `${prompt}\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY the JSON object, no markdown fences, no explanation.`,
        model: 'sonnet',
        maxTokens: 500,
      })

      const retryCleaned = retryResponse.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
      const retryData = JSON.parse(retryCleaned)
      return { turnType, data: retryData } as ExtractedNode
    } catch {
      console.warn(`[forge-extract] Extraction retry also failed for ${turnType}. Input lost.`)
      return null
    }
  }
}
