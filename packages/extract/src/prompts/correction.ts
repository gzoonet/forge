export const CORRECTION_EXTRACT_SYSTEM_PROMPT = `You are extracting a correction from a conversational turn.

The user is correcting something previously said or previously in the model.
Extract what is being corrected and what the correct version is.

## Output Format

Respond ONLY with valid JSON. No explanation. No markdown fences.

{
  "correcting": "<what is being corrected — quote or describe the original>",
  "correction": "<the correct version>",
  "isPermanent": true | false,
  "reason": "<why the correction is being made, if stated>"
}
`
