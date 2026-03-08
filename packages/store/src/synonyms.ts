// ── Domain Synonym Map ──────────────────────────────────────────────────────
// Small curated map for expanding keyword-based relevance matching.
// Each key maps to synonyms that should be treated as equivalent in context.

export const DOMAIN_SYNONYMS: Record<string, string[]> = {
  // Frontend / UI
  frontend: ['ui', 'interface', 'client', 'view'],
  ui: ['frontend', 'interface', 'client', 'view'],
  interface: ['frontend', 'ui', 'view'],
  react: ['frontend', 'ui', 'component'],
  vue: ['frontend', 'ui', 'component'],
  svelte: ['frontend', 'ui', 'component'],
  angular: ['frontend', 'ui', 'component'],

  // Backend / Server
  backend: ['server', 'api', 'service'],
  server: ['backend', 'api', 'service'],
  api: ['backend', 'server', 'endpoint', 'service'],
  endpoint: ['api', 'route'],

  // Database / Storage
  database: ['db', 'storage', 'datastore', 'persistence'],
  db: ['database', 'storage', 'datastore', 'persistence'],
  storage: ['database', 'db', 'persistence'],
  postgresql: ['postgres', 'database', 'sql'],
  postgres: ['postgresql', 'database', 'sql'],
  mysql: ['database', 'sql'],
  mongodb: ['database', 'nosql', 'document'],
  redis: ['cache', 'storage'],

  // Auth
  auth: ['authentication', 'login', 'authorization'],
  authentication: ['auth', 'login', 'authorization'],
  login: ['auth', 'authentication', 'signin'],
  authorization: ['auth', 'permissions', 'rbac'],

  // Pricing / Billing
  pricing: ['billing', 'revenue', 'monetization', 'subscription'],
  billing: ['pricing', 'revenue', 'payment', 'subscription'],
  revenue: ['pricing', 'billing', 'monetization'],
  subscription: ['billing', 'pricing', 'recurring'],
  payment: ['billing', 'checkout', 'stripe'],

  // Deploy / Infrastructure
  deploy: ['deployment', 'hosting', 'infrastructure'],
  deployment: ['deploy', 'hosting', 'infrastructure'],
  hosting: ['deploy', 'deployment', 'infrastructure'],
  infrastructure: ['deploy', 'hosting', 'devops'],
  serverless: ['lambda', 'functions', 'cloud'],
  docker: ['container', 'containerization'],
  container: ['docker', 'containerization'],
  kubernetes: ['k8s', 'orchestration', 'container'],

  // Testing
  testing: ['tests', 'test', 'qa', 'quality'],
  tests: ['testing', 'test', 'qa'],
  test: ['testing', 'tests', 'qa'],

  // Framework
  framework: ['library', 'toolkit'],
  library: ['framework', 'package'],
}

/**
 * Expand a list of words with their synonyms from the domain map.
 * Returns a deduplicated array containing the original words plus synonyms.
 */
export function expandWithSynonyms(words: string[]): string[] {
  const expanded = new Set(words)
  for (const word of words) {
    const synonyms = DOMAIN_SYNONYMS[word]
    if (synonyms) {
      for (const syn of synonyms) {
        expanded.add(syn)
      }
    }
  }
  return Array.from(expanded)
}
