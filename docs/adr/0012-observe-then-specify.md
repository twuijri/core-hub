# ADR 0012 — Observation is allowed; the clean room is a procedure, not a blindfold

Status: accepted (2026-09-22, owner decision)

Supersedes the fourth bullet of ADR 0004. Everything else in ADR 0004 stands.

## Context
ADR 0004 said contributors never have the Studio source open. In practice that
was read as "never look at the fork at all", so work was re-derived from first
principles and the owner was left testing behaviour we could have observed.
His objection, in his words: he is not asking us to copy code; he is asking us
to see how it works and build the same thing in our own writing — and he does
not want to be the one discovering every gap.

Copyright protects expression, not function. Reading a running product, its
screens, its network traffic, its files on disk and its documentation is
observing facts. Reading its source and then writing the same code is where
derivation begins. The distinction is procedural, so we write the procedure
down instead of banning the whole activity.

## Decision
**Observation is allowed and encouraged.** Anyone working on Majlis may run the
fork (or any other product), use it, read its screens, capture its API calls
and realtime frames, inspect the configuration it writes, and read its user
documentation and changelog. None of that is source code.

**Source stays closed, and the two roles stay separate.**
1. An *observer* may study behaviour and, where a licence permits it, source.
   The observer produces a specification in our own words: screens, states,
   fields, rules, edge cases, error text, and what we deliberately do
   differently. It goes in `docs/inspirations/` or `docs/specs/`.
2. An *implementer* builds from that specification and does **not** open the
   observed product's source. Their brief says so.
3. The same person may not hold both roles for the same feature within the
   same task.

**Never**, in any role: copying a file, a function, a string table, an asset,
a schema or a configuration block from a BSL-licensed source into Majlis, or
paraphrasing code line by line from it.

**Recorded**: every specification names what was observed, how (used the
product / read its docs / captured its traffic), and the date. A specification
derived from reading BSL source is marked as such and may only be used by an
implementer who did not read it.

## Consequences
- We stop re-deriving solved problems, and the owner stops being the test rig.
- Verification is ours: a change is proven by us — in a container, in the
  browser, against a scripted endpoint — before it reaches him. What genuinely
  needs his machine (his keys, his server, his phone) is named explicitly and
  kept short.
- The review question changes from "was any Studio source consulted?" to
  "which role were you in, and does this change contain anything copied?"
