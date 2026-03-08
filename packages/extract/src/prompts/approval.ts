export const APPROVAL_EXTRACT_SYSTEM_PROMPT = `You are extracting an approval from a conversational turn.

The user is approving, confirming, or committing to something previously discussed or proposed.
Extract what is being approved, whether it's a full or partial approval, and whether the user
intends to promote/commit to the approved item.

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "targetDescription": "<what is being approved — describe the decision, artifact section, or direction>",
  "scope": "full" | "partial",
  "promotionIntent": true | false,
  "comment": "<any qualifying comment, or null>"
}

## Guidelines

- promotionIntent is true when the user is explicitly committing ("yes, let's go with that",
  "commit to it", "that's decided"). This is the signal to promote leaning → decided.
- promotionIntent is false for softer approval ("looks good", "I like it") that acknowledges
  without explicitly committing.
- scope is "partial" when the user approves only part of something ("the data model section
  looks right, but the API section needs work").
- scope is "full" when approving everything discussed or an entire artifact/decision.
`
