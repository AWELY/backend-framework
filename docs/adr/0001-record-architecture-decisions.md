# 0001. Record architecture decisions

- Status: Accepted
- Since: 1.0.0

## Context

Maa started as a graduation project. The reasoning behind its design lives in Arabic code comments,
spread across the files they explain ("why we did not use Zod" sits in `src/engine/validation.ts`).
That works for someone reading one file. It does not work for a reviewer who wants every major
decision, its alternatives and its known costs in one place, in English, and it does not survive a
refactor that moves or deletes the comment.

The production hardening (see `docs/ROADMAP.md`) added decisions with real trade-offs: an outbox
instead of a broker, sessions instead of stateless tokens, rate limits in the database. Those need a
durable record that a future maintainer can challenge.

## Decision

- Architecture decisions are recorded as ADRs in `docs/adr/`, one Markdown file per decision.
- File name: `NNNN-kebab-case-title.md`, numbered sequentially. The index is `docs/adr/README.md`.
- Sections: Context, Decision, Consequences, Alternatives considered. A header gives the status
  (`Proposed`, `Accepted`, `Superseded by NNNN`) and the release the decision took effect in.
- An accepted ADR is not rewritten. A changed decision gets a new ADR that supersedes the old one;
  the old one only gets its status line updated.
- Code comments may link to an ADR by file name. `src/engine/validation.ts`,
  `src/modules/products/products.schema.ts`, `src/engine/auth-token.ts`, `src/runtime/outbox.ts` and
  `src/runtime/jobs.ts` link to 0004 through 0008, so those file names are fixed.
- Code comments stay in Arabic (see `CONTRIBUTING.md`); ADRs are in English.

## Consequences

- One place to answer "why is it built this way?", including the costs we accepted.
- Pull requests that change a recorded decision must add or supersede an ADR, which makes the change
  visible in review.
- Small cost per decision; trivial choices do not need an ADR.

## Alternatives considered

- **Comments only.** Already the case; not discoverable and not in English.
- **A single design document.** Grows stale and mixes current state with history. ADRs are
  append-only, so history is kept by construction.
- **Wiki outside the repository.** Drifts from the code and is not reviewed with it.
