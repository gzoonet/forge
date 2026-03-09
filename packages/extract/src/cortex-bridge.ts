import { spawn, type ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import type { CortexMatch } from '@gzoo/forge-core'

/**
 * Bridge to Cortex's MCP server. Spawns `cortex mcp start` as a child process
 * and communicates via JSON-RPC over stdio.
 *
 * Designed to be optional — if Cortex is not installed, all methods return
 * empty results silently.
 */
export class CortexBridge {
  private process: ChildProcess | null = null
  private connected = false
  private disabled = false
  private requestId = 0
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readBuffer = ''

  private static _available: boolean | null = null

  /**
   * Check if the `cortex` CLI is available on this system.
   * Result is cached for the lifetime of the process.
   */
  static isAvailable(): boolean {
    if (CortexBridge._available !== null) return CortexBridge._available
    try {
      execSync('which cortex', { stdio: 'ignore' })
      CortexBridge._available = true
    } catch {
      CortexBridge._available = false
    }
    return CortexBridge._available
  }

  /**
   * Reset the availability cache (useful for testing).
   */
  static resetAvailabilityCache(): void {
    CortexBridge._available = null
  }

  /**
   * Attempt to connect to Cortex by spawning its MCP server.
   * Returns true if connection was successful.
   */
  async connect(): Promise<boolean> {
    if (this.disabled) return false
    if (this.connected) return true
    if (!CortexBridge.isAvailable()) return false

    try {
      this.process = spawn('cortex', ['mcp', 'start'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env },
      })

      this.process.on('error', () => {
        this.markDisabled()
      })

      this.process.on('exit', () => {
        this.connected = false
        this.process = null
        this.rejectAllPending(new Error('Cortex process exited'))
      })

      this.process.stdout!.on('data', (chunk: Buffer) => {
        this.readBuffer += chunk.toString()
        this.processReadBuffer()
      })

      // Send MCP initialize request
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'forge-cortex-bridge', version: '0.1.0' },
      }, 5000)

      if (initResult) {
        // Send initialized notification (no response expected)
        this.sendNotification('notifications/initialized', {})
        this.connected = true
        console.error('[forge-extract] Cortex bridge connected')
        return true
      }
    } catch {
      this.markDisabled()
    }

    return false
  }

  /**
   * Query Cortex's knowledge graph with a natural language query.
   * Returns empty array if Cortex is not available.
   */
  async query(text: string): Promise<CortexMatch[]> {
    if (!this.connected || this.disabled) return []

    try {
      const result = await this.sendRequest('tools/call', {
        name: 'cortex_query',
        arguments: { query: text },
      }, 5000) as { content?: Array<{ type: string; text: string }> } | null

      if (!result?.content?.[0]?.text) return []
      return this.parseQueryResponse(result.content[0].text)
    } catch {
      console.warn('[forge-extract] Cortex query failed, disabling bridge')
      this.markDisabled()
      return []
    }
  }

  /**
   * Query Cortex for entities matching a search term.
   * Returns empty array if Cortex is not available.
   */
  async getEntities(search: string): Promise<CortexMatch[]> {
    if (!this.connected || this.disabled) return []

    try {
      const result = await this.sendRequest('tools/call', {
        name: 'cortex_entities',
        arguments: { query: search },
      }, 5000) as { content?: Array<{ type: string; text: string }> } | null

      if (!result?.content?.[0]?.text) return []
      return this.parseQueryResponse(result.content[0].text)
    } catch {
      console.warn('[forge-extract] Cortex entity query failed')
      return []
    }
  }

  /**
   * Disconnect from Cortex and clean up resources.
   */
  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error('Bridge disconnecting'))
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    this.connected = false
    this.readBuffer = ''
  }

  isConnected(): boolean {
    return this.connected && !this.disabled
  }

  // ── JSON-RPC over stdio ──────────────────────────────────────────────────

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return resolve(null)
      }

      const id = ++this.requestId
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Cortex request timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      try {
        this.process.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
      } catch {
        this.pendingRequests.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return
    const message = JSON.stringify({ jsonrpc: '2.0', method, params })
    try {
      this.process.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
    } catch {
      // Notification failures are non-critical
    }
  }

  private processReadBuffer(): void {
    while (true) {
      const headerEnd = this.readBuffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = this.readBuffer.slice(0, headerEnd)
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.readBuffer = this.readBuffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = parseInt(match[1], 10)
      const bodyStart = headerEnd + 4
      if (this.readBuffer.length < bodyStart + contentLength) break

      const body = this.readBuffer.slice(bodyStart, bodyStart + contentLength)
      this.readBuffer = this.readBuffer.slice(bodyStart + contentLength)

      try {
        const msg = JSON.parse(body)
        if ('id' in msg && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!
          this.pendingRequests.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) {
            pending.reject(new Error(msg.error.message ?? 'Cortex error'))
          } else {
            pending.resolve(msg.result)
          }
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(id)
    }
  }

  private markDisabled(): void {
    this.disabled = true
    this.connected = false
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    this.rejectAllPending(new Error('Bridge disabled'))
  }

  /**
   * Parse Cortex's text response into structured CortexMatch objects.
   * Cortex returns markdown/text — we extract what we can.
   */
  private parseQueryResponse(text: string): CortexMatch[] {
    const matches: CortexMatch[] = []

    // Try to parse as JSON first (Cortex may return structured data)
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name || item.description) {
            matches.push({
              entityType: item.type ?? item.entityType ?? 'unknown',
              name: item.name ?? '',
              description: item.description ?? item.summary ?? '',
              filePath: item.filePath ?? item.file ?? undefined,
              confidence: item.confidence ?? 0.5,
              relationships: item.relationships ?? undefined,
            })
          }
        }
        return matches
      }
    } catch {
      // Not JSON — parse as text
    }

    // Parse text response — extract entity-like blocks
    const lines = text.split('\n').filter(l => l.trim())
    let currentMatch: Partial<CortexMatch> | null = null

    for (const line of lines) {
      const trimmed = line.trim()

      // Lines starting with - or * or numbered suggest list items (entities)
      if (/^[-*]\s+\*?\*?(.+?)\*?\*?\s*[-–:]/.test(trimmed) || /^\d+\.\s+\*?\*?(.+?)\*?\*?\s*[-–:]/.test(trimmed)) {
        if (currentMatch?.name) {
          matches.push(this.finalizeCortexMatch(currentMatch))
        }
        const nameMatch = trimmed.match(/^[-*\d.]+\s+\*?\*?(.+?)\*?\*?\s*[-–:]\s*(.*)/)
        if (nameMatch) {
          currentMatch = {
            name: nameMatch[1].trim(),
            description: nameMatch[2]?.trim() ?? '',
            entityType: 'unknown',
            confidence: 0.5,
          }
        }
      } else if (currentMatch && trimmed && !trimmed.startsWith('#')) {
        // Continuation of current match description
        currentMatch.description = ((currentMatch.description ?? '') + ' ' + trimmed).trim()
      }

      // Detect file paths
      const fileMatch = trimmed.match(/(?:in|at|file:?)\s+[`"]?([^\s`"]+\.\w{1,5})[`"]?/i)
      if (fileMatch && currentMatch) {
        currentMatch.filePath = fileMatch[1]
      }
    }

    if (currentMatch?.name) {
      matches.push(this.finalizeCortexMatch(currentMatch))
    }

    return matches
  }

  private finalizeCortexMatch(partial: Partial<CortexMatch>): CortexMatch {
    return {
      entityType: partial.entityType ?? 'unknown',
      name: partial.name ?? '',
      description: partial.description ?? '',
      filePath: partial.filePath,
      confidence: partial.confidence ?? 0.5,
      relationships: partial.relationships,
    }
  }
}
