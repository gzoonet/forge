export const EXPLORATION_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured exploration node from a conversational turn.

The user is thinking through something without committing. Preserve the ambiguity —
do NOT resolve it. Your job is to capture what's being explored, not to decide it.

## Rules

1. topic: What is being explored? Short phrase, e.g. "Database selection" / "Pricing model"
2. direction: What general direction is the thinking pointing? Can be vague.
3. openQuestions: What questions remain unresolved? Extract them explicitly.
4. consideredOptions: What options have been mentioned? Even ones being compared.
5. resolutionCondition: What would allow this to be decided? If not stated, null.

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "topic": "<short topic phrase>",
  "direction": "<general direction of thinking>",
  "openQuestions": ["<question1>", "<question2>"],
  "consideredOptions": ["<option1>", "<option2>"],
  "resolutionCondition": "<condition or null>"
}
`
