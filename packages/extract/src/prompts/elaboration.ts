export const ELABORATION_EXTRACT_SYSTEM_PROMPT = `You are extracting an elaboration from a conversational turn.

The user is adding detail, refining, or expanding on something previously discussed.
This is NOT a new decision or exploration — it enriches an existing node.

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "targetDescription": "<what existing item is being elaborated on — describe the decision, constraint, or exploration>",
  "additions": ["<new detail 1>", "<new detail 2>"],
  "modifies": { "key": "new_value" } | null
}

## Guidelines

- targetDescription should identify the existing item being elaborated on (e.g., "PostgreSQL database decision", "pricing model exploration")
- additions: new information that should be appended (additional rationale, new alternatives, new requirements)
- modifies: if the elaboration changes a specific field (e.g., updating rationale, adding an alternative), specify the field and new value. Use null if the elaboration only adds new detail without changing existing fields.
- Common modification fields: "rationale" (updated reasoning), "alternatives" (new options to consider), "openQuestions" (new questions raised)
`
