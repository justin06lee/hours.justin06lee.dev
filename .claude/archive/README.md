# Archive

Finished process documents, kept because they explain *why* parts of this
codebase look the way they do — not because anything still acts on them.

| File | What it was |
| --- | --- |
| `AGENT-COORDINATION.md` | The file-claim protocol two agents used to work this repo in parallel in Aug 2026, with the handoff negotiation between them. The reason `calendar.ts` has `hydrate` overloads and `db.ts` has a fingerprint fast path. |
| `AUDIT-FINDINGS-FOR-INSTANCE-B.md` | The 19-defect audit that produced most of the hardening comments in `lib/`. Every finding is either fixed or recorded as deliberately not fixed. |

**Both are historical.** Line numbers in them are stale, the claims table binds
nobody, and the "still open" lists have since been worked through. Read them for
the reasoning behind a comment you don't understand; don't read them as a
to-do list.

Two findings they record as *deliberately not fixed* are still true and still
deliberate, so they are worth naming here rather than leaving buried:

- **`clampActualToDay` assumes a 1440-minute day**, so the two DST transition
  days a year are off by the transition size. Fixing it in that function moves
  the error rather than removing it — the value feeds a fixed 0–1440 render axis
  and is intersected against a literal full-day window. The real fix is the axis
  and the window together. Bounded, documented in the JSDoc, and pinned by a test.
- **No rate limit on the mutating server actions.** The deleted helper ran
  *after* the admin check, so it never protected against an unauthenticated
  attacker and would only have throttled the admin's own polling. `login` — the
  one surface an unauthenticated caller can reach — is rate-limited.
