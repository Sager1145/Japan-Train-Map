# One-shot data migrations

Scripts here have **already run**. Each one fixed a specific defect in a
committed dataset (a wrong stop list, a missing pass-through, one day's
itinerary) and is kept for provenance: it documents exactly what was changed
and lets the edit be reproduced or audited later.

They are not part of any pipeline. Nothing in `npm run build`, the Pages
workflow, or the test suite depends on them running again, and re-running one
against today's data is not guaranteed to be a no-op.

Permanent tooling is grouped by responsibility in sibling `railway/`,
`validation/`, `build/`, and `samples/` directories.

`npm run update:*` still points here, so the historical itinerary edits stay
invocable by name.
