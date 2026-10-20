# Foundation review

Reviewed 20 October 2026 by an independent Codex worker. Scope: root runtime launcher and configuration, package scripts, CI workflow, and factory-core messaging implementation/tests. No production provider sessions or networking were exercised.

## Finding to resolve

**P2: `runtime.openBrowser: true` is ignored.** In `scripts/runtime.mjs`, `runtimeArguments` always chooses upstream `serve`. Upstream `apps/server/src/cli/server.ts` explicitly sets headless startup for that command, and `cli/config.ts` gives headless startup precedence over the browser flag. Removing `--no-browser` therefore cannot enable browser opening. Either use upstream `start` when browser opening is requested (while explicitly preventing unwanted current-directory project bootstrapping) or remove the unsupported setting. Cover both settings in the launcher test and verify against the actual upstream command semantics.

## Validation

- Ran root `npm test`: 9 tests passed, 0 failed.
- Inspected messaging schema migration, WAL configuration, cross-connection retry deduplication, cursor scope/pagination, project isolation, and validation. No additional actionable correctness issue identified within this local-storage scope.
- Confirmed all three upstream files referenced by `test:upstream` exist.
- Root setup includes both `t3...` and `@t3tools/scripts...`, covering the scripts workspace dependency that the server build imports.

## Follow-up coverage

The current CI workflow installs and runs selected upstream tests but does not run `npm run build`. Add a build step once the first build is reliable so later changes cannot produce green CI while breaking the documented launcher preparation. The new messaging API remains local storage only; authentication, cross-device delivery, role wake-ups, durable consumer acknowledgments, and user-facing messaging are still unimplemented, as its README correctly states.

Only this handoff file was written by the reviewer.
