import type { ExecutionAction, ProjectModel, NodeId } from '@gzoo/forge-core'
import type { ExecutionHook, ProposedAction, ActionResult, GitHubConfig } from '../types'

export class GitHubHook implements ExecutionHook {
  service = 'github'
  description = 'GitHub integration — create repos, issues, and commit artifacts'

  private config: GitHubConfig | null = null

  constructor(config?: GitHubConfig) {
    if (config) {
      this.config = config
    } else {
      // Auto-detect from environment
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
      const owner = process.env.GITHUB_OWNER ?? process.env.GITHUB_USER
      if (token && owner) {
        this.config = { token, owner }
      }
    }
  }

  isConfigured(): boolean {
    return this.config !== null
  }

  async propose(model: ProjectModel): Promise<ProposedAction[]> {
    if (!this.config) return []
    const proposals: ProposedAction[] = []

    // Proposal 1: Create repo if project has 3+ committed decisions and no repo exists
    const committedDecisions = Array.from(model.decisions.values())
      .filter(d => d.commitment === 'decided' || d.commitment === 'locked')

    if (committedDecisions.length >= 3) {
      proposals.push({
        description: `Create GitHub repository: ${slugify(model.name)}`,
        service: 'github',
        actionType: 'create_repo',
        parameters: {
          name: slugify(model.name),
          description: model.intent.primaryGoal?.statement ?? `${model.name} — created by GZOO Forge`,
          private: this.config.defaultVisibility !== 'public',
        },
        requiresApproval: true,
        isReversible: true,
        reason: `${committedDecisions.length} committed decisions — enough to create a repository`,
      })
    }

    // Proposal 2: Create issues from unresolved tensions
    const activeTensions = Array.from(model.tensions.values())
      .filter(t => t.status === 'active' && (t.severity === 'significant' || t.severity === 'blocking'))

    for (const tension of activeTensions) {
      proposals.push({
        description: `Create GitHub issue: ${tension.description.slice(0, 80)}`,
        service: 'github',
        actionType: 'create_issue',
        parameters: {
          title: `[Tension] ${tension.description.slice(0, 100)}`,
          body: formatTensionIssue(tension, model),
          labels: ['forge-tension', tension.severity],
        },
        requiresApproval: true,
        isReversible: true,
        reason: `${tension.severity} tension should be tracked as an issue`,
      })
    }

    // Proposal 3: Create issues from active explorations that have been open for 3+ turns
    const activeExplorations = Array.from(model.explorations.values())
      .filter(e => e.status === 'active' && e.openQuestions.length > 0)

    for (const exploration of activeExplorations) {
      proposals.push({
        description: `Create GitHub issue: ${exploration.topic.slice(0, 80)}`,
        service: 'github',
        actionType: 'create_issue',
        parameters: {
          title: `[Exploration] ${exploration.topic}`,
          body: formatExplorationIssue(exploration),
          labels: ['forge-exploration'],
        },
        requiresApproval: true,
        isReversible: true,
        reason: `Open exploration with ${exploration.openQuestions.length} unresolved question(s)`,
      })
    }

    // Proposal 4: Commit spec artifact to repo
    for (const [, artifact] of model.artifacts) {
      if (artifact.type === 'spec' && artifact.status === 'draft') {
        const rootSection = artifact.sections.get(artifact.rootSectionId)
        if (rootSection) {
          proposals.push({
            description: `Commit spec to repo: ${artifact.name}`,
            service: 'github',
            actionType: 'commit_file',
            parameters: {
              path: 'docs/spec.md',
              content: rootSection.content.body,
              message: `docs: add project specification (v${artifact.version})`,
            },
            sourceArtifactId: artifact.id,
            requiresApproval: true,
            isReversible: true,
            reason: 'Spec artifact ready to commit to repository',
          })
        }
      }
    }

    return proposals
  }

  async execute(action: ExecutionAction): Promise<ActionResult> {
    if (!this.config) {
      return { success: false, error: 'GitHub not configured' }
    }

    switch (action.actionType) {
      case 'create_repo':
        return this.createRepo(action)
      case 'create_issue':
        return this.createIssue(action)
      case 'commit_file':
        return this.commitFile(action)
      default:
        return { success: false, error: `Unknown action type: ${action.actionType}` }
    }
  }

  async rollback(action: ExecutionAction): Promise<ActionResult> {
    if (!this.config) {
      return { success: false, error: 'GitHub not configured' }
    }

    switch (action.actionType) {
      case 'create_repo':
        return this.deleteRepo(action)
      case 'create_issue':
        return this.closeIssue(action)
      default:
        return { success: false, error: `Rollback not supported for: ${action.actionType}` }
    }
  }

  // ── GitHub API Methods ─────────────────────────────────────────────────────

  private async createRepo(action: ExecutionAction): Promise<ActionResult> {
    const { name, description, private: isPrivate } = action.parameters as {
      name: string; description: string; private: boolean
    }

    const response = await this.apiRequest('POST', '/user/repos', {
      name,
      description,
      private: isPrivate,
      auto_init: true,
    })

    if (!response.ok) {
      const error = await response.json()
      return { success: false, error: `Failed to create repo: ${error.message ?? response.statusText}` }
    }

    const repo = await response.json()
    return {
      success: true,
      data: {
        repoUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        fullName: repo.full_name,
      },
    }
  }

  private async createIssue(action: ExecutionAction): Promise<ActionResult> {
    const { title, body, labels, repo } = action.parameters as {
      title: string; body: string; labels: string[]; repo?: string
    }

    // Use repo from parameters or try to find from prior create_repo results
    const repoName = repo ?? (action.parameters as any).repoName
    if (!repoName) {
      return { success: false, error: 'No repository specified. Create a repo first or set repo parameter.' }
    }

    const response = await this.apiRequest('POST', `/repos/${this.config!.owner}/${repoName}/issues`, {
      title,
      body,
      labels,
    })

    if (!response.ok) {
      const error = await response.json()
      return { success: false, error: `Failed to create issue: ${error.message ?? response.statusText}` }
    }

    const issue = await response.json()
    return {
      success: true,
      data: {
        issueUrl: issue.html_url,
        issueNumber: issue.number,
      },
    }
  }

  private async commitFile(action: ExecutionAction): Promise<ActionResult> {
    const { path: filePath, content, message, repo } = action.parameters as {
      path: string; content: string; message: string; repo?: string
    }

    const repoName = repo ?? (action.parameters as any).repoName
    if (!repoName) {
      return { success: false, error: 'No repository specified.' }
    }

    // Get the current file SHA if it exists (needed for updates)
    let sha: string | undefined
    const getResponse = await this.apiRequest(
      'GET',
      `/repos/${this.config!.owner}/${repoName}/contents/${filePath}`
    )
    if (getResponse.ok) {
      const existing = await getResponse.json()
      sha = existing.sha
    }

    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content).toString('base64'),
    }
    if (sha) body.sha = sha

    const response = await this.apiRequest(
      'PUT',
      `/repos/${this.config!.owner}/${repoName}/contents/${filePath}`,
      body
    )

    if (!response.ok) {
      const error = await response.json()
      return { success: false, error: `Failed to commit file: ${error.message ?? response.statusText}` }
    }

    const result = await response.json()
    return {
      success: true,
      data: {
        commitSha: result.commit?.sha,
        contentUrl: result.content?.html_url,
      },
    }
  }

  private async deleteRepo(action: ExecutionAction): Promise<ActionResult> {
    const { name } = action.parameters as { name: string }
    const response = await this.apiRequest('DELETE', `/repos/${this.config!.owner}/${name}`)

    if (!response.ok) {
      return { success: false, error: `Failed to delete repo: ${response.statusText}` }
    }
    return { success: true }
  }

  private async closeIssue(action: ExecutionAction): Promise<ActionResult> {
    if (!action.result?.issueNumber) {
      return { success: false, error: 'No issue number to close' }
    }

    const repoName = (action.parameters as any).repo ?? (action.parameters as any).repoName
    const response = await this.apiRequest(
      'PATCH',
      `/repos/${this.config!.owner}/${repoName}/issues/${action.result.issueNumber}`,
      { state: 'closed' }
    )

    if (!response.ok) {
      return { success: false, error: `Failed to close issue: ${response.statusText}` }
    }
    return { success: true }
  }

  // ── HTTP Helper ────────────────────────────────────────────────────────────

  private async apiRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `https://api.github.com${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config!.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (body) headers['Content-Type'] = 'application/json'

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatTensionIssue(tension: any, model: ProjectModel): string {
  const lines: string[] = []
  lines.push(`## Constraint Tension`)
  lines.push('')
  lines.push(`**Severity:** ${tension.severity}`)
  lines.push(`**Status:** ${tension.status}`)
  lines.push('')
  lines.push(`### Description`)
  lines.push(tension.description)
  lines.push('')

  // Try to show the conflicting nodes
  const nodeA = model.decisions.get(tension.nodeAId) ??
    model.constraints.get(tension.nodeAId) ??
    model.explorations.get(tension.nodeAId)
  const nodeB = model.decisions.get(tension.nodeBId) ??
    model.constraints.get(tension.nodeBId) ??
    model.explorations.get(tension.nodeBId)

  if (nodeA) {
    lines.push(`### Side A`)
    lines.push(`> ${(nodeA as any).statement ?? (nodeA as any).topic}`)
  }
  if (nodeB) {
    lines.push('')
    lines.push(`### Side B`)
    lines.push(`> ${(nodeB as any).statement ?? (nodeB as any).topic}`)
  }

  lines.push('')
  lines.push('---')
  lines.push('*Created by GZOO Forge*')

  return lines.join('\n')
}

function formatExplorationIssue(exploration: any): string {
  const lines: string[] = []
  lines.push(`## Open Exploration`)
  lines.push('')
  lines.push(`**Topic:** ${exploration.topic}`)
  lines.push(`**Direction:** ${exploration.direction}`)
  lines.push('')

  if (exploration.openQuestions.length > 0) {
    lines.push(`### Open Questions`)
    for (const q of exploration.openQuestions) {
      lines.push(`- [ ] ${q}`)
    }
    lines.push('')
  }

  if (exploration.consideredOptions.length > 0) {
    lines.push(`### Options Under Consideration`)
    for (const o of exploration.consideredOptions) {
      lines.push(`- ${o}`)
    }
    lines.push('')
  }

  if (exploration.resolutionCondition) {
    lines.push(`### Resolution Condition`)
    lines.push(exploration.resolutionCondition)
    lines.push('')
  }

  lines.push('---')
  lines.push('*Created by GZOO Forge*')

  return lines.join('\n')
}
