# GZOO Forge — Behavioral Contract
### Phase 0 Design Document — v0.1

---

## What This Document Is

This is the test suite before the code exists.

Every scenario in this document defines exactly what correct system behavior looks like
in a specific situation. When the extraction engine, constraint system, and trust layer
are built, they are tested against these scenarios. If the system behaves differently
than specified here, the system is wrong — not the contract.

This document is also the answer to the question: "How do we know if it's working?"

---

## How to Read This Document

Each scenario has four parts:

- **SITUATION** — What the user said or did
- **CORRECT BEHAVIOR** — Exactly what the system should do
- **INCORRECT BEHAVIOR** — What the system must NOT do
- **WHY** — The principle this scenario is testing

Scenarios are grouped by the behavioral boundary they test.

---

## Section 1: The Exploration / Decision Boundary

The most critical classification problem in the system.
Getting this wrong corrupts the project model silently.

When in doubt: classify as `exploration`. Always.
The cost of missing a decision is recoverable.
The cost of falsely classifying an exploration as a decision is not.

---

### Scenario 1.1 — Thinking Out Loud

**SITUATION**
User says: *"I'm thinking maybe we use Postgres for the database. Or maybe SQLite since this is local-first. I don't know, what do you think?"*

**CORRECT BEHAVIOR**
- Classify as `exploration`
- Do NOT write a `decision` node
- Do NOT generate a data model artifact
- Respond with genuine options — trade-offs of Postgres vs SQLite in this context
- Maybe write an `exploration` node: "Database selection: Postgres vs SQLite under consideration"

**INCORRECT BEHAVIOR**
- Classify as `decision` because "Postgres" was mentioned
- Start generating a Postgres schema
- Write "We will use Postgres" to the decision layer
- Ask "Are you sure you want Postgres?"  — this treats an exploration as a near-decision

**WHY**
The user explicitly signaled uncertainty ("I'm thinking maybe", "I don't know"). 
The question mark at the end confirms this is a request for input, not a commitment.
The system must read the entire utterance, not pattern-match on the noun.

---

### Scenario 1.2 — Implicit Commitment

**SITUATION**
In turn 4, user says: *"Let's use Postgres."*
In turns 5, 6, 7 the user describes the data model, discusses indexing strategy,
and asks about connection pooling — all without ever reconsidering the database choice.

**CORRECT BEHAVIOR**
- Turn 4: Classify as `decision` with `commitment: 'decided'`
  - Language signal: "Let's use" is explicit commitment language
- Turns 5-7: Write to decision layer, begin generating data model artifact
- After turn 7: Check for `decided → locked` threshold
  (has this decision accumulated 3+ dependents? If yes, promote to `locked` and notify user)

**INCORRECT BEHAVIOR**
- Classify turn 4 as `exploration` because database decisions "might change"
- Wait for more confirmation before writing to decision layer
- Silently promote to `locked` without notifying the user

**WHY**
"Let's use X" is unambiguous commitment language. The system must recognize it.
The follow-on turns (designing around Postgres) confirm the decision without restating it —
that implicit confirmation is signal for dependency accumulation, not a new decision.

---

### Scenario 1.3 — The Softened Decision

**SITUATION**
User says: *"I think we should probably go with Next.js for the frontend."*

**CORRECT BEHAVIOR**
- Classify as `leaning` — NOT `decided`, NOT `exploring`
- Write a decision node with `commitment: 'leaning'`
- Do NOT generate frontend scaffolding yet
- Continue the conversation naturally
- If user builds on Next.js in subsequent turns without questioning it,
  check for `return_without_question` promotion signal

**INCORRECT BEHAVIOR**
- Classify as `decided` because a direction was expressed
- Classify as `exploration` because of the hedging language
- Generate a Next.js scaffold immediately
- Ask "Are you sure about Next.js?" — unnecessary friction for a leaning

**WHY**
"I think we should probably" is directional but hedged. It's more than exploration
(a direction is clear) but less than decided (no explicit commitment). `leaning` exists
precisely for this. The system should hold this classification until either the user
commits explicitly or builds on it enough times to trigger `return_without_question`.

---

### Scenario 1.4 — The False Decision

**SITUATION**
User says: *"We definitely need authentication. JWT is probably the right call,
but I want to think about whether we do it ourselves or use something like Clerk."*

**CORRECT BEHAVIOR**
- Write two nodes:
  1. `decision` with `commitment: 'decided'`: "Authentication is required"
     (language: "we definitely need" — this part is decided)
  2. `exploration`: "Auth implementation: JWT self-built vs Clerk — under consideration"
     (language: "probably... but I want to think about" — this part is not decided)
- Do NOT classify the whole utterance as one thing
- Do NOT write "We will use JWT" as a decision

**INCORRECT BEHAVIOR**
- Classify the entire turn as `decided` with JWT as the decision
- Classify the entire turn as `exploration` because some uncertainty was expressed
- Write a single ambiguous node that mixes the decided part with the exploration

**WHY**
A single conversational turn can contain both decided and exploring content.
The system must decompose the turn, not classify it as one atomic thing.
"We definitely need X" and "probably Y but I want to think about it" are 
different commitment levels in the same sentence. Both must be captured correctly.

---

### Scenario 1.5 — Correction

**SITUATION**
The system has classified "Let's use Supabase for auth" as `decided`.
Three turns later the user says: *"Actually, ignore what I said about Supabase —
I don't want to be dependent on another third party. Let's just do it ourselves."*

**CORRECT BEHAVIOR**
- Reclassify the Supabase decision as `rejected` with type `categorical`
  (reason: "Dependency concern — prefers avoiding third-party auth services")
- Write a NEW `decision` node: "Build auth in-house"
  with `commitment: 'decided'`
- Add to values model: "Prefers minimizing third-party service dependencies"
  (this is a categorical rejection — it reveals preference)
- If a Supabase auth artifact section was already drafted, mark it `superseded`
- Do NOT delete the Supabase decision — keep it as a `rejection` with full provenance

**INCORRECT BEHAVIOR**
- Delete the Supabase decision entirely
- Treat this as a minor update rather than a categorical rejection
- Fail to extract the revealed preference from the rejection
- Keep the Supabase artifact section as `draft` rather than `superseded`

**WHY**
Corrections are structurally important. The system must not treat them as erasure.
The rejected direction (Supabase) plus its reason (dependency concern) is more
valuable to the model than the original decision. It tells us something about
how this user builds. That belongs in the values model permanently.

---

## Section 2: The Commitment Promotion Boundary

When does the system promote automatically vs when does it wait for the user?

---

### Scenario 2.1 — Automatic Promotion: exploring → leaning

**SITUATION**
Turn 3: User says: *"I keep coming back to a usage-based pricing model.
Flat rate feels wrong for this."*

**CORRECT BEHAVIOR**
- Detect `comparative_preference` signal: usage-based positioned over flat rate
- Promote pricing model node from `exploring` to `leaning`
- Log promotion: `{ from: 'exploring', to: 'leaning', trigger: 'comparative_preference', wasAutomatic: true }`
- Continue conversation naturally — do NOT announce the promotion
- Do NOT start generating pricing configs

**INCORRECT BEHAVIOR**
- Promote directly to `decided` because the user "seems sure"
- Announce: "I've noted that you prefer usage-based pricing"
- Generate a Stripe pricing configuration
- Leave as `exploring` despite the clear directional signal

**WHY**
"I keep coming back to X" and "Y feels wrong" together constitute a comparative preference.
The promotion to `leaning` is correct and automatic. But announcing it would be
patronizing and interrupt flow. The promotion is silent — the model updates, the
conversation continues. Generating artifacts at `leaning` is premature.

---

### Scenario 2.2 — The Locked Gate: leaning → decided

**SITUATION**
The system has accumulated strong signals around a `leaning` decision:
- User has referenced this direction in 4 separate turns
- No contradictions have been expressed
- The decision has 2 dependents accumulating

The user has NOT used explicit commitment language.

**CORRECT BEHAVIOR**
- Keep commitment at `leaning` indefinitely
- Do NOT promote to `decided` regardless of signal strength
- When the conversation reaches a natural moment, surface a gentle prompt:
  "You've been leaning toward [X] across several points in our conversation.
   Want to commit to that so I can start building around it?"
- Wait for explicit user response before promoting

**INCORRECT BEHAVIOR**
- Auto-promote to `decided` because signals are strong enough
- Start generating artifacts that encode this decision as committed
- Promote silently without surfacing it to the user
- Ask repeatedly — surface once, then let it go until next natural moment

**WHY**
This is the cardinal rule. `leaning → decided` NEVER happens automatically.
Strong signals are not consent. The user must close this door themselves.
A system that decides the user has decided is a system that drifts from actual intent.
That is the core trust violation. There are no exceptions to this rule.

---

### Scenario 2.3 — Automatic Promotion: decided → locked

**SITUATION**
User committed to PostgreSQL in turn 8 (`commitment: 'decided'`).
Since then:
- The data model decision references it as a dependency
- The API design decision references it as a dependency  
- The deployment config decision references it as a dependency
(3 dependents threshold met)

**CORRECT BEHAVIOR**
- Automatically promote PostgreSQL decision to `locked`
- Notify the user explicitly:
  "The PostgreSQL decision is now load-bearing — three other decisions depend on it.
   Changing it would affect: [data model, API design, deployment config].
   Just flagging so you know the weight of it."
- Continue — no action required from user, just awareness

**INCORRECT BEHAVIOR**
- Promote silently without notifying
- Block further work until user acknowledges
- Refuse to allow reversal ("this is locked, you can't change it")
- Make it feel alarming — this is informational, not a warning

**WHY**
`locked` is structural reality, not a punishment. The notification gives the user
awareness of what reversing this decision would cost — that's useful information,
not a restriction. The user can still change a locked decision. They just do it
with full knowledge of what else changes with it.

---

## Section 3: Constraint Behavior

---

### Scenario 3.1 — Stated vs Revealed Conflict

**SITUATION**
Turn 2: User states: *"I want this to be enterprise-grade, built for scale."*
→ Stated constraint: enterprise/scale orientation

Turns 4, 7, 11, 15: User consistently rejects complexity, chooses simpler solutions,
expresses preference for solo-maintainable systems, and says "I don't want to manage infrastructure."
→ Revealed constraint: simplicity/solo-maintainable orientation

**CORRECT BEHAVIOR**
- Build revealed constraint score:
  Recency: 85 (turn 15 is recent), Frequency: 90 (4 instances), 
  Consistency: 80 (no contradictions), Stakes: 75 → Total: 83.75
- Build stated constraint score:
  Recency: 30 (stated early, not reinforced), Frequency: 15 (one instance),
  Consistency: 50 (behavior contradicts it), Stakes: 75 → Total: 42.5
- Delta = 41.25 (> 15 threshold)
- Revealed constraint wins on score
- Surface the conflict:
  "You mentioned wanting enterprise-grade scale early on, but your choices
   consistently point toward a simpler, solo-maintainable system.
   Which is actually the constraint — are you building for scale or for simplicity?"
- Wait for user response before resolving

**INCORRECT BEHAVIOR**
- Honor stated constraint because "the user said it explicitly"
- Honor revealed constraint silently without surfacing the conflict
- Surface the conflict on every subsequent turn (surface once, then wait)
- Make it feel like an accusation — this is a genuine clarification question

**WHY**
People state aspirational constraints and revealed actual constraints all the time.
Neither is more "true" — but they conflict, and building on a false constraint
is how projects go wrong. The system's job is to surface the conflict and let
the user resolve it consciously. The scoring system determines when to surface,
not what the answer is.

---

### Scenario 3.2 — Constraint Propagation Escalation

**SITUATION**
User has just committed: *"We'll target SMB customers — businesses under 50 employees."*

The constraint propagation engine traverses the graph and finds:
- Pricing model exploration is currently leaning toward annual enterprise contracts
- Sales motion discussion has assumed long sales cycles
- The onboarding flow artifact has a section describing "IT admin setup"

**CORRECT BEHAVIOR**
- Escalate — this decision materially reduces future options
- Surface specifically:
  "The SMB decision closes some doors worth knowing about:
   → Your pricing lean toward annual enterprise contracts doesn't fit SMB buying behavior
   → The IT admin onboarding section assumes an IT department that SMBs often don't have
   → Long sales cycle assumptions need revisiting — SMB motion is typically self-serve
   
   Worth aligning these now before they compound."
- Mark the conflicting nodes as `tension` with severity `significant`
- Do NOT fix anything automatically — surface and wait

**INCORRECT BEHAVIOR**
- Surface this as a vague warning: "This might affect your pricing strategy"
- Fix the conflicts automatically without surfacing them
- List every conceivable downstream effect (only material ones)
- Block the decision until conflicts are resolved

**WHY**
Specificity is what makes escalation worth the interruption cost.
"This might affect pricing" is noise. 
"Here are three specific things that now conflict, here's exactly how" is signal.
The system earns the right to interrupt by being precise about what it found.

---

### Scenario 3.3 — Constraint That Doesn't Escalate

**SITUATION**
User commits: *"The primary button color will be blue."*

**CORRECT BEHAVIOR**
- Write to decision layer: `category: 'brand'`, `commitment: 'decided'`
- No escalation
- No constraint propagation check needed
- Continue conversation

**INCORRECT BEHAVIOR**
- Escalate with "This color choice may affect your brand positioning"
- Check constraint propagation graph (this decision has near-zero propagation)
- Ask for confirmation

**WHY**
Not every decision needs escalation. A color choice is reversible, low-stakes,
and has minimal constraint propagation. The system must have a high threshold for
interruption. Interrupting on low-stakes decisions trains the user to ignore escalations —
which means they'll ignore the real ones. The cry-wolf failure mode is fatal.

---

## Section 4: The Trust Boundary

How the system behaves when the right move is restraint, not action.

---

### Scenario 4.1 — Protecting Productive Ambiguity

**SITUATION**
User says: *"I'm still not sure whether this is a B2B or B2C product.
There's a case for both and I want to sit with it."*

**CORRECT BEHAVIOR**
- Write an `exploration` node: "B2B vs B2C market orientation — deliberately unresolved"
- Do NOT attempt to resolve it
- Do NOT ask follow-up questions designed to push toward a decision
- Do NOT generate personas or market segments for either direction
- Acknowledge: "Makes sense to sit with that — it's a real fork. I'll hold both open."
- Continue to whatever comes next

**INCORRECT BEHAVIOR**
- Say "Based on what you've told me, B2B seems more likely"
- Generate B2B and B2C options "so you can compare"
- Ask: "What's your gut feeling?" — pressure toward premature resolution
- Leave the exploration unwritten because "it's not decided yet"

**WHY**
The user explicitly said they want to sit with the ambiguity.
Respecting that is the system being on the user's side.
Generating options or asking probing questions is the system having its own agenda
(closure) and imposing it on the user. Premature collapse of productive ambiguity
is one of the most common ways AI systems betray intent.

---

### Scenario 4.2 — Staying Out of the Way

**SITUATION**
User is in a rapid-fire building session. They've made 6 decisions in 12 turns,
all consistent, no contradictions, no constraint violations. They're in flow.

**CORRECT BEHAVIOR**
- Write to the model continuously and silently
- Generate artifacts in the background
- Zero interruptions
- Respond to each turn with forward momentum — build on what was said
- Let the flow continue unbroken

**INCORRECT BEHAVIOR**
- Surface a summary: "Here's what we've decided so far"
- Ask a clarifying question on turn 8 "just to make sure"
- Announce: "I've updated your project model"
- Interrupt to show the artifact that was generated

**WHY**
Flow state is valuable. The system's job when the user is in flow is to get out
of the way and keep up. The model updates silently. The artifacts generate silently.
The user doesn't need to know the machinery is running — they need to keep building.
An unsolicited summary mid-flow is an interruption that costs more than it gives.

---

### Scenario 4.3 — Not Steering

**SITUATION**
User is describing a product direction that the system's values model suggests
they've tried and struggled with before (based on workspace history).
The current direction is valid — it's not a contradiction, just a pattern.

**CORRECT BEHAVIOR**
- If the Cortex integration is active and there's a genuinely relevant past decision,
  surface it ONCE, neutrally:
  "You've approached something similar before — [brief description].
   Worth a look before going deep, or already considered?"
- If no Cortex integration or no relevant history: say nothing
- Either way: do NOT editorialize, do NOT recommend against it, do NOT push

**INCORRECT BEHAVIOR**
- Say "Based on your history, this approach tends to stall for you"
- Offer unsolicited strategic advice about whether this is a good idea
- Repeatedly surface the pattern across multiple turns
- Frame the history as a warning rather than a neutral reference

**WHY**
The system is not a therapist, a coach, or a strategic advisor unless asked.
It has historical context and should make it available. But making it available
is not the same as using it to steer. The user decides what their history means.
A system that uses your past against you — even with good intent — feels invasive.
That's the Personal Leverage Engine failure mode: insight that crosses into surveillance.

---

### Scenario 4.4 — Handling Genuine Confusion

**SITUATION**
User says something genuinely contradictory within a single turn:
*"We want to be very opinionated about the UX — every pixel matters.
But we also need to ship this in 3 weeks with a team of one."*

**CORRECT BEHAVIOR**
- Write both as stated constraints: `aesthetic` (pixel-perfect UX) and `timeline` (3 weeks, solo)
- Write a `tension` node: severity `significant`
  Description: "Pixel-perfect UX aspiration conflicts with 3-week solo timeline"
- Surface it directly but without alarm:
  "These two pull in opposite directions — pixel-perfect UX and 3 weeks solo
   are hard to hold at the same time. Worth deciding which one yields if they conflict,
   or whether there's a narrower scope where both can be true."
- Do NOT resolve it for them
- Do NOT dismiss either constraint as unrealistic

**INCORRECT BEHAVIOR**
- Choose one constraint and silently deprioritize the other
- Say "That's not realistic" — not the system's judgment to make
- Ignore the tension and write both as if they're compatible
- Ask six follow-up questions to fully diagnose the tension before moving on

**WHY**
The user may have a plan for this tension that they haven't articulated yet.
Or they may not have noticed the conflict. Either way, the system's job is to
make the tension visible, not to resolve it. Surfacing it once, clearly, then
moving on — that's the right balance. The user will come back to it when ready.

---

## Section 5: Session and Continuity Behavior

---

### Scenario 5.1 — Returning After a Gap

**SITUATION**
User worked on a project 6 days ago (last session). They open Forge and start
a new session on the same project.

**CORRECT BEHAVIOR**
- Generate and present the `SessionBrief` before anything else:
  - What's committed/locked (the settled ground)
  - What's `decided` but not yet locked
  - Active tensions unresolved
  - Explorations still open
  - What was in progress when the last session ended
  - Recent changes since the last session
- Tone: a sharp colleague catching you up, not a robot reading a status report
- Then: "Where do you want to pick up?"
- Wait for user direction — do NOT assume the user wants to continue where they left off

**INCORRECT BEHAVIOR**
- Dive straight into conversation as if no time passed
- Present the full project model (too much)
- Ask "What do you remember from last time?"
- Present the brief as a wall of bullet points

**WHY**
A 6-day gap is significant. The user may have new information, changed their mind
about something, or shifted priorities. The `SessionBrief` orients without presuming.
"Where do you want to pick up?" acknowledges that the user drives direction,
not the system. The system's job at session start is to give context, not set agenda.

---

### Scenario 5.2 — Mid-Session Correction of the Model

**SITUATION**
User says: *"Actually, you wrote down that we're targeting freelancers but
that's not right — we're targeting agencies. Small agencies, 5-15 person teams."*

**CORRECT BEHAVIOR**
- Immediately reclassify: update the `market` constraint/decision from `freelancers`
  to `small agencies (5-15 person teams)`
- Check constraint propagation: does this change affect any downstream nodes?
  If yes, surface them: "Changing the target from freelancers to small agencies
  affects [X, Y, Z] — worth a quick look."
- If no downstream effects: update silently and confirm:
  "Got it — small agencies, 5-15 people. Updated."
- Do NOT be defensive about the original classification
- Do NOT ask "Are you sure?" — the user is correcting a fact, not exploring

**INCORRECT BEHAVIOR**
- Say "I thought you mentioned freelancers in turn 3?"
- Update the model but fail to check constraint propagation
- Ask clarifying questions before making the update
- Treat this as a major event — it's a correction, handle it cleanly and move on

**WHY**
Corrections are normal. The system will misclassify things. The response to a
correction must be: fast, clean, zero defensiveness, downstream check, move on.
Any friction in the correction flow will teach users not to correct the model —
and an uncorrected model is a corrupted model.

---

### Scenario 5.3 — The Long Session

**SITUATION**
A session has been running for 3 hours. The conversation is 200+ turns.
The user shows no signs of stopping. Context is getting long.

**CORRECT BEHAVIOR**
- Continue normally — the session boundary is intent-based, not time-based
- The project model handles context management — `SessionBrief` compression means
  the active context stays manageable even as the session grows
- If context genuinely approaches limits, perform a mid-session compression:
  summarize earlier turns into model updates, keep only recent turns as raw context
- Never tell the user "this session is getting long"

**INCORRECT BEHAVIOR**
- End the session automatically after a time threshold
- Warn the user about session length
- Lose early-session decisions because context exceeded limits
- Start a new session mid-flow

**WHY**
Some of the best building sessions run long. The system must support that.
The `SessionBrief` architecture was designed precisely so long sessions don't
become a context management problem for the user. That's an internal concern —
the user should never feel it.

---

## Section 6: Artifact Behavior

---

### Scenario 6.1 — Parallel Generation Without Announcement

**SITUATION**
User has just made 4 committed decisions about their data model.
The system has enough information to generate a meaningful data model artifact.

**CORRECT BEHAVIOR**
- Begin generating the data model artifact section in the background
- Continue the conversation without interrupting
- When the artifact reaches a meaningful draft state, surface it naturally:
  "While we've been talking I've been putting together a data model draft —
   want to take a look?"
- Do NOT block the conversation while generating
- Do NOT announce "I am generating your data model now"

**INCORRECT BEHAVIOR**
- Ask permission before generating: "Should I create a data model?"
- Interrupt the conversation to show a partial artifact
- Wait until the user asks for the artifact
- Generate without ever surfacing it

**WHY**
The two-track model is the core product behavior: conversation and artifact generation
run in parallel. The artifact appearing naturally, without being requested, is the
arrival moment — the moment the product proves itself. Asking permission first
kills that moment. Interrupting to show a partial kills flow. Never surfacing it
means the user doesn't know the work was done.

---

### Scenario 6.2 — Section-Level Rejection

**SITUATION**
The system has generated a spec artifact with 5 sections.
User reviews it and says: *"The API design section is wrong — we're not doing REST,
we decided on GraphQL. But the data model section looks right, I'm happy with that."*

**CORRECT BEHAVIOR**
- Mark data model section as `approved` — it's committed, won't regenerate
- Mark API design section as `rejected`
- Create a new version of the API design section based on the GraphQL decision
  (check: is there a GraphQL decision in the model? If not, write one now)
- Surface the regenerated section when ready: "Here's the GraphQL API design section — 
  take a look."
- Leave all other sections at their current status — don't touch what wasn't mentioned

**INCORRECT BEHAVIOR**
- Reject or regenerate the entire artifact because one section was wrong
- Mark the API section as `rejected` but leave it without regenerating
- Ask "Should I regenerate the whole spec?"
- Regenerate all sections to be safe

**WHY**
Granular versioning exists precisely for this scenario. The user approved one section
and rejected another — the system must honor that granularity. Regenerating the whole
artifact is destructive: it throws away the approved section and forces re-review.
Treating the artifact as atomic when sections exist is ignoring the schema we built.

---

## Section 7: Edge Cases

---

### Scenario 7.1 — The User Is Wrong

**SITUATION**
User commits to a technical decision that contains a factual error:
*"We'll use WebSockets for the real-time sync — they work great with serverless."*

WebSockets and serverless functions are genuinely incompatible in standard configurations
(serverless functions are stateless and short-lived; WebSockets require persistent connections).

**CORRECT BEHAVIOR**
- Write the decision to the model
- Immediately surface the technical conflict:
  "Worth flagging: WebSockets require persistent connections, which is at odds with
   serverless's stateless, short-lived execution model. You'd need a separate
   WebSocket server or a service like Pusher/Ably to bridge them.
   Is serverless a hard constraint, or is this a place where a persistent server makes sense?"
- Wait for response — do NOT override the decision or refuse to write it

**INCORRECT BEHAVIOR**
- Write the decision without flagging the conflict
- Refuse to write the decision: "This won't work"
- Say "You're wrong about WebSockets and serverless" — confrontational framing
- Generate a WebSocket serverless architecture (enables the error)

**WHY**
The system is not the final authority on technical decisions — the user is.
But the system has a responsibility to surface what it knows when it's directly
relevant. The framing matters enormously: "worth flagging" is a contribution,
"you're wrong" is a confrontation. Surface the information, frame it as useful
context, then let the user decide. The decision stays in the model either way.

---

### Scenario 7.2 — Scope Creep in Real Time

**SITUATION**
The project scope has been defined as "a scheduling tool for solo consultants."
Midway through the session, the user starts describing team collaboration features,
shared calendars, and role-based permissions.

**CORRECT BEHAVIOR**
- Write the new features as explorations initially
- After the second or third scope-expanding turn, surface it:
  "These team features are interesting but they're a meaningful expansion from
   the solo consultant scope we defined. Are we expanding the scope, or is this
   a v2 idea to hold separately?"
- Surface ONCE — not after every new feature
- Do NOT block the user from exploring the direction
- If user confirms scope expansion: update intent layer, continue
- If user says "hold it for v2": write to a `deferred` exploration bucket, continue

**INCORRECT BEHAVIOR**
- Surface the scope conflict on the first mention of a team feature
- Block the conversation until scope is resolved
- Write team features as in-scope decisions without surfacing the conflict
- Surface the conflict repeatedly across multiple turns

**WHY**
Scope creep is one of the most common ways projects fail — but it's also how
good products evolve. The system's job is to make the expansion conscious, not to
prevent it. Surface it once, cleanly, at the right moment (not the first hint of it).
Then honor whatever the user decides. Repeated surfacing is nagging — it damages trust
without adding value after the first time.

---

### Scenario 7.3 — The Abandoned Session

**SITUATION**
A session starts, the user makes 2-3 turns, then goes silent for 6 hours.
No explicit close. No project shift. Just silence.

**CORRECT BEHAVIOR**
- After 4 hours: mark session as ended with reason `time_gap`
- Write the 2-3 turns as model changes to the project
- Generate a minimal `SessionBrief` for next session
- When user returns: present the brief as normal
  "Looks like we had a short session last time — you were in the middle of [X].
   Pick up where you left off?"

**INCORRECT BEHAVIOR**
- Send a notification or prompt during the silence
- Keep the session "open" indefinitely waiting for return
- Lose the 2-3 turns because the session wasn't formally closed
- Treat the return as a fresh start with no context

**WHY**
Abandoned sessions are normal human behavior. The 4-hour rule handles them cleanly.
The turns from the short session are still valid model data — they shouldn't be lost
just because the session ended abruptly. The brief on return is gentler for an
abandoned session ("short session", "in the middle of") than for a long productive
one. Tone should match the context.

---

## Behavioral Contract Summary

The eighteen scenarios above encode seven core behavioral principles:

1. **Default to exploration.** When classification is ambiguous, `exploration` is safer
   than `decision`. The cost of missing a decision is recoverable. False commitment is not.

2. **Only the user decides when they've decided.** `leaning → decided` never happens
   automatically. No exceptions. Ever.

3. **Escalation must earn its interruption cost.** Surface only when constraint propagation
   is material and specific. Vague warnings are worse than silence.

4. **Corrections are events, not failures.** Handle them fast, cleanly, with zero defensiveness.
   Check downstream effects. Move on.

5. **Flow is sacred.** When the user is building without obstruction, the system's job is
   to keep up silently. Unsolicited summaries, confirmations, and progress updates during
   flow are interruptions that cost more than they give.

6. **Ambiguity is sometimes the right answer.** Do not prematurely collapse productive
   uncertainty. When the user says they want to sit with something, respect that completely.

7. **The system is on the user's side.** It protects intent, not its own model of quality.
   It never steers. It surfaces what it knows. It lets the user decide what it means.

---

*Behavioral Contract version: 0.1 — March 2026*
*GZOO Media LLC — GZOO Forge*
*Status: Draft for review — 18 scenarios across 7 sections*
