# Claude Code — mandatory session start and proof of reading

This file is the stable starting point for **every** Claude Code session, regardless of account, terminal or IDE. A separate account does not transfer chat history, connectors or credentials.

## Before making changes
1. Read the **full** root `CLAUDE.md`, `docs/v1-product-spec.md`, `docs/hipaa-compliance.md`, `HEALDESK_CLAUDE_CODE_LAUNCH_EXECUTION_PLAN.md`, and `AGENTS.md`.
2. Run `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, and inspect relevant recent commits and changed files. Preserve existing uncommitted work.
3. Independently verify the handoff's claims against source, tests, CI and `apps/web/src/lib/admin/seo/launch.ts`. Owner-confirmed agreements are not the same as production verification.
4. Report a **reading receipt** to the Owner: documents read; current branch/HEAD; current approved task ID; governing product/PHI restrictions; relevant blockers; tests and files to inspect; proposed next action.
5. Continue **only previously authorized, non-destructive work**. If approval or state is ambiguous, perform read-only investigation and ask one specific question.

## During work
- Use task IDs and acceptance criteria from the master execution plan.
- Keep Owner actions separate; never fabricate tests, approvals or production proof.
- No push, merge, deploy, infrastructure apply, live vendor-setting change, real patient activation or compliance attestation without specific Owner authorization.

## Before ending
- Update `AGENTS.md` with branch, HEAD, dirty paths, completed work, exact test results, blockers, Owner dependencies and next approved step.
- Update plan status only with evidence. Distinguish code complete, tests passed, deployed, live verified and Owner approved.
- Provide a short `Completed / Changed files / Tests / Git state / Blockers / Owner decisions / Next action` report.
- If interrupted, the next session must reconstruct state from Git.

## One-sentence startup prompt

**Read `docs/claude-session-start.md` and follow its complete session-start, proof-of-reading, execution and handoff procedure before continuing any approved Healdesk work.**
