# Product-description verification

Source baselines: Cloudbox `551b0c6`; T3 Code fork `999e25ba`.

Run P1 before P2. Source tests verify invariants; only a real two-host pass verifies cloud transport
and recovery timing.

| ID | P | Needs | Claim | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- |
| LOAD-01 | P1 | Local dependencies | Bootstrap paths cannot escape home. | `pnpm exec vitest run src/config.test.ts` | Outside-home path is rejected. | Pass, 2026-08-29. |
| LOAD-02 | P1 | Local dependencies | Clone resumes and never deletes destination-only files. | `pnpm exec vitest run src/bootstrap/clone.test.ts` | Protected/partial flags exist; delete flag absent. | Pass, 2026-08-29. |
| LOAD-03 | P1 | Local dependencies | Dry run never contacts destination. | Run clone tests. | Only source/pull calls occur. | Pass, 2026-08-29. |
| LOAD-04 | P1 | Local dependencies | Cache refresh precedes destination preview/write. | Run clone tests. | Pull preview → pull → push preview → push. | Pass, 2026-08-29. |
| LOAD-05 | P1 | Local dependencies | Transfer is size guarded. | Run clone tests. | Oversized delta fails before mutation unless forced. | Pass, 2026-08-29. |
| LOAD-06 | P2 | Local dependencies | Existing sync remains intact. | `pnpm exec vitest run src/cli.test.ts` | CLI behavior tests pass. | Pass, 2026-08-29. |
| LOAD-07 | P2 | TypeScript/build tools | Public command compiles and is discoverable. | `pnpm typecheck`; `pnpm build:cli`; `node dist/cli.mjs bootstrap-clone --help` | All succeed; flags appear. | Pass, 2026-08-29. |
| LOAD-08 | P1 | Two authorized boxes | Interrupted transfer resumes with matching selected files. | Dry-run; interrupt real clone; rerun; compare. | Remaining deltas transfer; destination-only files remain. | Blocked: second target not supplied. |
| WAKE-01 | P1 | Deployed relay/mobile | Prompt wakes asleep box without manual Wake/Reconnect. | Submit one mobile prompt to sleeping linked box. | One wake; queued send after reconnect; passive reconnect cold. | Blocked: deployment/device pass outstanding. |

## Documentation consistency

Verify every relative Markdown link in `README.md` and `docs/product-description.md` resolves. The
2026-08-29 read-only link scan reported no missing targets.
