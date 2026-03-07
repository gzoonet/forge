import { nanoid } from 'nanoid'

export type NodeId = string

export type ModelNodeType =
  | 'intent'
  | 'decision'
  | 'constraint'
  | 'rejection'
  | 'exploration'
  | 'tension'
  | 'artifact'
  | 'artifact_section'

const PREFIX_MAP: Record<ModelNodeType | 'project' | 'workspace' | 'session', string> = {
  project: 'proj',
  workspace: 'ws',
  session: 'sess',
  intent: 'int',
  decision: 'dec',
  constraint: 'con',
  rejection: 'rej',
  exploration: 'exp',
  tension: 'ten',
  artifact: 'art',
  artifact_section: 'sec',
}

export type IdType = keyof typeof PREFIX_MAP

export function createId(type: IdType): NodeId {
  return `${PREFIX_MAP[type]}_${nanoid(10)}`
}
