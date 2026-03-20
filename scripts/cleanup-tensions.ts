#!/usr/bin/env npx tsx
/**
 * Bulk-resolve all active tensions in the PainSignal project.
 * Uses the ProjectModelStore API (not raw SQL) so events are properly materialized.
 *
 * Usage: npx tsx scripts/cleanup-tensions.ts [--dry-run]
 */

import { ProjectModelStore } from '@gzoo/forge-store'
import { createProvenance, type NodeId } from '@gzoo/forge-core'

const DB_PATH = '/var/www/painsignal.gzoo.ai/.forge/forge.db'
const PROJECT_ID = 'proj_6BZOTMywUV' as NodeId
const DRY_RUN = process.argv.includes('--dry-run')

const store = new ProjectModelStore(DB_PATH)

try {
  const model = store.getProjectModel(PROJECT_ID)

  const activeTensions = Array.from(model.tensions.values())
    .filter(t => t.status === 'active' || t.status === 'acknowledged')

  console.log(`Project: ${model.name} (${PROJECT_ID})`)
  console.log(`Total tensions: ${model.tensions.size}`)
  console.log(`Active/acknowledged: ${activeTensions.length}`)
  console.log(`Already resolved: ${model.tensions.size - activeTensions.length}`)
  console.log()

  // Breakdown by severity
  const bySeverity = new Map<string, number>()
  for (const t of activeTensions) {
    bySeverity.set(t.severity, (bySeverity.get(t.severity) ?? 0) + 1)
  }
  console.log('By severity:')
  for (const [sev, count] of bySeverity) {
    console.log(`  ${sev}: ${count}`)
  }
  console.log()

  if (DRY_RUN) {
    console.log('[DRY RUN] Would resolve all active tensions. Run without --dry-run to execute.')
    process.exit(0)
  }

  // Create a cleanup session
  const sessionId = 'sess_cleanup_' + Date.now()
  const resolution = 'Bulk cleanup: false positive or superseded constraint — tightened constraint engine pre-filter'
  const provenance = createProvenance(sessionId, 0, resolution, 'high')
  const context = { projectId: PROJECT_ID, sessionId, turnIndex: 0 }

  let resolved = 0
  for (const tension of activeTensions) {
    store.appendEvent(
      {
        type: 'TENSION_RESOLVED',
        tensionId: tension.id,
        resolution,
        provenance,
      },
      context
    )
    resolved++
    if (resolved % 100 === 0) {
      console.log(`  resolved ${resolved}/${activeTensions.length}...`)
    }
  }

  console.log(`\nDone. Resolved ${resolved} tensions.`)

  // Verify
  const updated = store.getProjectModel(PROJECT_ID)
  const remaining = Array.from(updated.tensions.values()).filter(t => t.status === 'active')
  console.log(`Remaining active tensions: ${remaining.length}`)
} finally {
  store.close()
}
