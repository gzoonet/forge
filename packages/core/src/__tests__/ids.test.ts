import { describe, it, expect } from 'vitest'
import { createId, type IdType } from '../ids'

describe('createId', () => {
  it('generates decision IDs with dec_ prefix', () => {
    const id = createId('decision')
    expect(id).toMatch(/^dec_/)
  })

  it('generates project IDs with proj_ prefix', () => {
    const id = createId('project')
    expect(id).toMatch(/^proj_/)
  })

  it('generates unique IDs across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId('decision')))
    expect(ids.size).toBe(100)
  })

  it('generates correct prefix for every type', () => {
    const expected: Record<IdType, string> = {
      project: 'proj_',
      workspace: 'ws_',
      session: 'sess_',
      intent: 'int_',
      decision: 'dec_',
      constraint: 'con_',
      rejection: 'rej_',
      exploration: 'exp_',
      tension: 'ten_',
      artifact: 'art_',
      artifact_section: 'sec_',
    }

    for (const [type, prefix] of Object.entries(expected)) {
      const id = createId(type as IdType)
      expect(id.startsWith(prefix), `${type} should start with ${prefix}, got ${id}`).toBe(true)
    }
  })

  it('generates IDs with 10-char nanoid suffix', () => {
    const id = createId('decision')
    const suffix = id.slice('dec_'.length)
    expect(suffix).toHaveLength(10)
  })
})
