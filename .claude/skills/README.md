# whatcan skills

Skills auto-loaded by Claude when working in this repo. A skill is a packaged set of
instructions Claude follows for a kind of task. Two kinds live here:

## ⚠️ Precedence — skills assist, they never override what's already built

Skills do NOT change the bot's behavior on their own. The bot's client communication and
analysis logic lives in the **server code** (prompts in `lib/stage-routing.ts`,
`lib/generate-suggestion.ts`, `lib/rental-prompt.ts`; cadence/priority in
`lib/adaptive-followup.ts`; profiling in `lib/lead-profile.ts`; the learning loops in
`approve.ts` / `/set-temperature` / `/reschedule-task`). Skills only guide Claude while it
works — they run when invoked, they don't silently mutate the running product.

Order of authority, highest first:

1. **The existing codebase logic and the owner's explicit decisions** (CLAUDE.md, the
   funnel rules, the adaptive cadence, the "cost of delay" ranking, the WhatsApp voice).
2. **The project skills** `whatcan-sales-playbook` and `whatcan-extension-ui` — they
   describe and protect that logic.
3. **General skills** (`frontend-design`, `webapp-testing`, and the built-ins) — tools
   applied *within* the constraints above. If a general skill's advice conflicts with the
   established sales logic, communication style, client-analysis approach, or UI
   conventions, the established logic wins — do not "improve" the bot into a generic
   default. `frontend-design` in particular is for the landing page / marketing artifacts;
   the copilot panel prioritizes clean consistency (per `whatcan-extension-ui`), not
   distinctive risk-taking.

Any change must still pass the codebase's own tests of correctness and the broker's
judgment (would Robert actually send this?). A skill is never a reason to overrule either.

## Project skills (custom, specific to this product)

- **whatcan-sales-playbook** — the sales / communication / funnel judgment the bot must
  embody (empathy, timing, when to push vs stay quiet, stage goals, Bali specifics, how
  the bot learns from brokers). Load before touching ANY lead-facing message, prompt,
  cadence, temperature or stage logic. This is the bot's "sales brain" as a reference.
- **whatcan-extension-ui** — the Chrome-extension panel's design system (colors, chip/
  badge patterns, the resizable split layout). Load before changing extension UI so new
  controls match instead of scattering one-off styles.

## General skills (vetted third-party — each was read before installing)

Skills execute in Claude's environment, so only trusted, read-first sources are here.

From **github.com/anthropics/skills** (Official Anthropic, licensed per each skill):
- **frontend-design** — deliberate, non-templated visual design (palette, typography,
  layout). For the landing page / marketing artifacts; the copilot panel uses
  `whatcan-extension-ui` (clean consistency, not risk-taking).
- **webapp-testing** — Playwright toolkit for driving/testing local web apps. For the
  `/m` mobile PWA and server-rendered pages (not the extension — it lives over amoCRM).

From **github.com/obra/superpowers** (community, MIT):
- **systematic-debugging** — find the root cause before proposing any fix (symptom fixes
  are failures). Matches how we work; load on any bug/unexpected behavior.
- **verification-before-completion** — no "done/fixed/passing" claim without fresh
  verification evidence in the same step. Load before committing or reporting success.

From **github.com/trailofbits/skills** (Trail of Bits, CC BY-SA 4.0 — attribution kept):
- **insecure-defaults** — detects fail-open insecure defaults (hardcoded secrets,
  `env or 'default'`, weak auth). Relevant to our `.env` / amoCRM tokens / VAPID keys.
- **supply-chain-risk-auditor** — audits npm/pnpm dependencies for takeover/abandonment
  risk. Run on demand before adding or bumping dependencies.

### Deliberately NOT installed (and why)

- Rest of **superpowers** (TDD, brainstorming, writing-plans, git-worktrees,
  subagent-driven-development) — opinionated end-to-end methodology that would fight our
  lean, highly-interactive iterate-and-deploy flow (and we have no test suite; esbuild
  doesn't typecheck). `subagent-driven-development` in particular says "don't check in with
  the human, just execute" — the opposite of how the owner works (live corrections).
- Rest of **Trail of Bits** — mostly smart-contract / C / Rust / crypto / fuzzing skills,
  not our Node/TS stack.
- Community sales/copywriting/CRM skills — **none exist** worth using; `whatcan-sales-playbook`
  is our answer for that domain.

### On "a skill that optimizes token usage"

There is no magic single skill for this. The real levers: (1) the Skills mechanism itself —
only a skill's name+description sits in context; the body loads only when invoked
(progressive disclosure); (2) **subagents**, which Claude Code supports natively (the Agent
tool) — offload a big/parallel task to a subagent that returns only a summary, keeping the
main context lean. We use subagents directly when a task warrants it; we did not install the
opinionated "subagent-driven-development" skill because its no-check-in workflow conflicts
with this project's interactive style.

## Already built into Claude — no download needed, just invoke

We rely on these directly (they are not copied here):

- Code quality & safety: **code-review**, **security-review**, **simplify**, **verify**
  — run code-review + security-review before deploying non-trivial server changes.
- UI/UX: **design-critique**, **design-system**, **accessibility-review**, **ux-copy**,
  **artifact-design**, **canvas-design**, **theme-factory**, **dataviz**.
- Building blocks: **mcp-builder**, **web-artifacts-builder**, **skill-creator**
  (use skill-creator to add a new skill here), doc skills (**docx/pdf/pptx/xlsx**).
- Sales/PM framing: the **sales:\*** and **product-management:\*** skill families.

To add a skill: for a project-specific one, use `skill-creator` and drop it in this
folder; for a general one, copy it from github.com/anthropics/skills — but read it first
(a skill is instructions Claude will execute) and prefer trusted sources only.
