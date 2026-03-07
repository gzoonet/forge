export const CONSTRAINT_EXTRACT_SYSTEM_PROMPT = `You are extracting a structured constraint node from a conversational turn.

A constraint has been identified — something the project must do, must not do, or is limited by.

## Rules

1. statement: Rephrase as a clear requirement: "Must X" / "Cannot Y" / "Under Z"
2. hardness:
   - 'hard': Non-negotiable. "We must", "it has to", "absolutely"
   - 'soft': Strong preference but could flex. "I'd prefer", "ideally", "try to"
3. type: What domain does this constraint belong to?
4. certainty: How certain is the user about this constraint?
   - 'assumed': Stated matter-of-factly
   - 'evidenced': User gave a reason
   - 'uncertain': User expressed some doubt

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "statement": "<clear constraint statement>",
  "hardness": "hard" | "soft",
  "type": "technical" | "financial" | "market" | "timeline" | "operational" | "aesthetic" | "ethical" | "regulatory" | "strategic",
  "certainty": "assumed" | "uncertain" | "evidenced"
}
`
