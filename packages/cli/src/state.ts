import * as fs from 'fs'
import * as path from 'path'

const STATE_DIR = path.join(process.cwd(), '.forge')
const STATE_FILE = path.join(STATE_DIR, 'state.json')

export type ForgeState = {
  projectId: string
  sessionId: string
  turnIndex: number
  dbPath: string
}

export function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  }
}

export function saveState(state: ForgeState): void {
  ensureStateDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function loadState(): ForgeState | null {
  if (!fs.existsSync(STATE_FILE)) return null
  const raw = fs.readFileSync(STATE_FILE, 'utf-8')
  return JSON.parse(raw)
}

export function getDbPath(): string {
  return path.join(STATE_DIR, 'forge.db')
}
