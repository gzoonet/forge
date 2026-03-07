import {
  createId,
  createProvenance,
  type NodeId,
  type ProjectModel,
  type Artifact,
  type ArtifactSection,
  type ArtifactContent,
  type Decision,
  type Constraint,
  type Rejection,
  type Exploration,
  type DecisionCategory,
  type Provenance,
} from '@gzoo/forge-core'
import { ProjectModelStore } from '@gzoo/forge-store'
import type { LLMClient } from './llm-client'
import { SPEC_ARTIFACT_SYSTEM_PROMPT } from './prompts/artifact'

export type ArtifactTriggerResult = {
  shouldGenerate: boolean
  reason?: string
  categories: DecisionCategory[]
}

/**
 * Check if the model state warrants generating a spec artifact.
 * Trigger: 3+ decided/locked decisions exist.
 */
export function checkArtifactTrigger(model: ProjectModel): ArtifactTriggerResult {
  const committedDecisions = Array.from(model.decisions.values()).filter(
    d => d.commitment === 'decided' || d.commitment === 'locked'
  )

  if (committedDecisions.length < 3) {
    return { shouldGenerate: false, categories: [] }
  }

  // Check if we already have a current spec artifact
  const existingSpec = Array.from(model.artifacts.values()).find(
    a => a.type === 'spec' && (a.status === 'draft' || a.status === 'ready')
  )

  // Collect categories with committed decisions
  const categories = [...new Set(committedDecisions.map(d => d.category))]

  if (existingSpec) {
    // Check if new decisions have been made since the artifact was generated
    const coveredDecisionIds = new Set(existingSpec.sourceDecisionIds)
    const newDecisions = committedDecisions.filter(d => !coveredDecisionIds.has(d.id))

    if (newDecisions.length === 0) {
      return { shouldGenerate: false, categories }
    }

    return {
      shouldGenerate: true,
      reason: `${newDecisions.length} new committed decision(s) since last spec generation`,
      categories,
    }
  }

  return {
    shouldGenerate: true,
    reason: `${committedDecisions.length} committed decisions — enough to generate initial spec`,
    categories,
  }
}

/**
 * Generate a spec artifact from the current model state.
 */
export async function generateSpecArtifact(
  model: ProjectModel,
  store: ProjectModelStore,
  llmClient: LLMClient,
  sessionId: string,
  turnIndex: number
): Promise<Artifact> {
  const provenance = createProvenance(sessionId, turnIndex, '[artifact generation]', 'high')

  // Gather model data for the prompt
  const decisions = Array.from(model.decisions.values()).filter(
    d => d.commitment === 'decided' || d.commitment === 'locked'
  )
  const constraints = Array.from(model.constraints.values())
  const rejections = Array.from(model.rejections.values())
  const explorations = Array.from(model.explorations.values()).filter(e => e.status === 'active')

  const prompt = buildSpecPrompt(model, decisions, constraints, rejections, explorations)

  const response = await llmClient.complete({
    system: SPEC_ARTIFACT_SYSTEM_PROMPT,
    prompt,
    model: 'sonnet',
    maxTokens: 4000,
  })

  const specContent = response.text

  // Parse sections from the generated markdown
  const sections = parseMarkdownSections(specContent)

  // Create the artifact structure
  const artifactId = createId('artifact')
  const rootSectionId = createId('artifact_section')

  const sectionMap = new Map<NodeId, ArtifactSection>()
  const childSectionIds: NodeId[] = []

  // Create child sections from parsed markdown
  for (const section of sections) {
    const sectionId = createId('artifact_section')
    childSectionIds.push(sectionId)

    const artifactSection: ArtifactSection = {
      id: sectionId,
      artifactId,
      parentSectionId: rootSectionId,
      childSectionIds: [],
      title: section.title,
      content: {
        format: 'markdown',
        body: section.body,
      },
      status: 'draft',
      version: 1,
      sourceDecisionIds: findRelatedDecisions(section.body, decisions),
      sourceConstraintIds: findRelatedConstraints(section.body, constraints),
      provenance,
    }

    sectionMap.set(sectionId, artifactSection)
  }

  // Create root section
  const rootSection: ArtifactSection = {
    id: rootSectionId,
    artifactId,
    childSectionIds,
    title: `${model.name} — Specification`,
    content: {
      format: 'markdown',
      body: specContent,
    },
    status: 'draft',
    version: 1,
    sourceDecisionIds: decisions.map(d => d.id),
    sourceConstraintIds: constraints.map(c => c.id),
    provenance,
  }

  sectionMap.set(rootSectionId, rootSection)

  // Create the artifact
  const artifact: Artifact = {
    id: artifactId,
    type: 'spec',
    name: `${model.name} — Specification`,
    description: `Auto-generated spec from ${decisions.length} committed decisions`,
    status: 'draft',
    provenance,
    sourceDecisionIds: decisions.map(d => d.id),
    sourceConstraintIds: constraints.map(c => c.id),
    sections: sectionMap,
    rootSectionId,
    version: '1.0',
    fullyCommitted: false,
  }

  // Store the artifact via event
  store.appendEvent(
    { type: 'NODE_CREATED', nodeType: 'artifact', node: artifact, provenance },
    { projectId: model.id, sessionId, turnIndex }
  )

  return artifact
}

function buildSpecPrompt(
  model: ProjectModel,
  decisions: Decision[],
  constraints: Constraint[],
  rejections: Rejection[],
  explorations: Exploration[]
): string {
  const parts: string[] = []

  // Goal
  if (model.intent.primaryGoal) {
    parts.push(`## Project Goal\n${model.intent.primaryGoal.statement}`)
    if (model.intent.primaryGoal.successCriteria.length > 0) {
      parts.push(`\nSuccess criteria:\n${model.intent.primaryGoal.successCriteria.map(c => `- ${c}`).join('\n')}`)
    }
  }

  // Decisions by category
  const byCategory = new Map<DecisionCategory, Decision[]>()
  for (const d of decisions) {
    const list = byCategory.get(d.category) ?? []
    list.push(d)
    byCategory.set(d.category, list)
  }

  parts.push('\n## Committed Decisions')
  for (const [category, decs] of byCategory) {
    parts.push(`\n### ${category}`)
    for (const d of decs) {
      parts.push(`- [${d.commitment}] ${d.statement}`)
      if (d.rationale && d.rationale !== 'Not stated') {
        parts.push(`  Rationale: ${d.rationale}`)
      }
    }
  }

  // Constraints
  if (constraints.length > 0) {
    parts.push('\n## Constraints')
    for (const c of constraints) {
      parts.push(`- [${c.hardness}] ${c.statement} (${c.type})`)
    }
  }

  // Rejections
  if (rejections.length > 0) {
    parts.push('\n## Rejections (what was ruled out)')
    for (const r of rejections) {
      parts.push(`- ${r.statement}: ${r.reason}`)
    }
  }

  // Open explorations
  if (explorations.length > 0) {
    parts.push('\n## Open Explorations (NOT decided — do not resolve these)')
    for (const e of explorations) {
      parts.push(`- ${e.topic}: ${e.direction}`)
      for (const q of e.openQuestions) {
        parts.push(`  - ${q}`)
      }
    }
  }

  return parts.join('\n')
}

type ParsedSection = { title: string; body: string }

function parseMarkdownSections(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n')
  const sections: ParsedSection[] = []
  let currentTitle = ''
  let currentBody: string[] = []

  for (const line of lines) {
    // Match ## headings (top-level sections in the generated spec)
    const match = line.match(/^##\s+(.+)$/)
    if (match) {
      if (currentTitle) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() })
      }
      currentTitle = match[1]
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }

  if (currentTitle) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() })
  }

  return sections
}

function findRelatedDecisions(text: string, decisions: Decision[]): NodeId[] {
  const lower = text.toLowerCase()
  return decisions
    .filter(d => {
      const keywords = d.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
      return keywords.some(k => lower.includes(k))
    })
    .map(d => d.id)
}

function findRelatedConstraints(text: string, constraints: Constraint[]): NodeId[] {
  const lower = text.toLowerCase()
  return constraints
    .filter(c => {
      const keywords = c.statement.toLowerCase().split(/\s+/).filter(w => w.length > 4)
      return keywords.some(k => lower.includes(k))
    })
    .map(c => c.id)
}
