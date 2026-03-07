export const REJECTION_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured rejection node from a conversational turn.

The user has ruled something out. Extract the rejection precisely.

## Rules

1. statement: What was rejected? Rephrase as "We will NOT use/do X"
2. rejectionType:
   - 'categorical': "That's wrong", "I don't want that", "definitely not" — permanent
   - 'conditional': "Not now because X", "maybe later if Y" — conditional on change
   - 'deferred': "Maybe", "later", "not this version" — low signal, keep quietly
3. reason: Why was it rejected? Critical — if not stated, still try to infer from context
4. revivalCondition: For conditional rejections only — what would change this?
5. revealsPreference: For categorical rejections — what does this reveal about how they build?
   e.g. "Not building on Vercel because of vendor lock-in" -> "Prefers avoiding platform lock-in"
6. contributesToValues: true for categorical rejections, false for conditional/deferred

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "statement": "<what was rejected>",
  "rejectionType": "categorical" | "conditional" | "deferred",
  "reason": "<why>",
  "category": "market" | "product" | "technical" | "business" | "operational" | "brand",
  "revivalCondition": "<condition or null>",
  "revealsPreference": "<preference revealed or null>",
  "contributesToValues": true | false
}
`
