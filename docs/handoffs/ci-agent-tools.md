# CI agent tools handoff

Extended `packages/factory-client` with CI job submission, status, explicit retry, and bounded list support. Existing messaging CLI and tools remain present. No runtime/server or runner package source was changed.

Reusable API: `FactoryClient.submitCi({repositoryId, revision, command, requiredLabels?, idempotencyKey})`, `ciStatus(jobId)`, `retryCi(jobId)`, and `ciJobs({limit?})`. The configured project is always attached to submissions/list queries, and status/retry reject jobs from another project. The existing bearer credential file and JSON client configuration are reused; a submitting device does not need worker filesystem/repository configuration.

CLI: `ci-submit --job FILE`, `ci-status --id ID`, `ci-retry --id ID`, and `ci-jobs [--limit N]`. Job files contain the submission object above. Revision validation requires a full lowercase SHA; commands require an argv array, never a shell string. Labels, argument limits, and unknown fields are validated before requests.

MCP adds `factory_submit_ci`, `factory_ci_status`, and `factory_retry_ci` with strict schemas. The server now exposes six tools total. New schema handling validates arrays and full-revision patterns. Tool failures preserve MCP `isError` shape and avoid printing server error bodies or credentials.

CI submission uses the existing retry-once policy with one serialized payload and identical idempotency key. Explicit job retry checks scope then posts once, without automatic mutation replay: an ambiguous timeout could follow a runner already completing the next attempt, so the caller must inspect status before another retry. Existing read retries remain safe.

Validation: twelve tests pass on Node 24 with `node --test` in `packages/factory-client`. The added HTTP fixture tests verify configured project, argv/revision validation, exact-key retry payloads, cross-project refusal before retry mutation, and no automatic retry of a transient explicit-retry response. Actual CLI/MCP child processes submit jobs and read/retry status through fixture HTTP, reject invalid string commands/branch names, preserve existing messaging tools, and redact credential-bearing error responses.

Remaining verification: lead-owned real runner integration and any actual provider/harness invocation of the CI tools. These tests do not claim a live Codex/Claude CI submission or execution on a remote owned machine. Existing successful provider smoke for messaging is separate evidence.
