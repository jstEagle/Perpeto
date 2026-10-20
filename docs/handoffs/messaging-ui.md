# Factory messaging UI

Implemented a discoverable Messages sidebar action and authenticated `/factory` page in the inherited web client. The page selects existing T3 projects and their actual environment connections, maps the chosen project ID into factory messaging on first channel creation, lists/creates channels, reads cursor-paginated messages, and sends caller-selected role messages with an optional recipient. Recipient addressing remains visible to the whole channel; it is not private messaging or authenticated role identity.

The page uses scoped Workshop values imported directly from `brand/tokens.css`, with a channel rail, readable chronological history and compact composer. Sender role preferences survive reload and channel switches through schema-backed browser storage. Read-only environment grants hide mutation controls. This remains a provisional working surface, not the final brand or factory graph.

The new client-runtime `state/factory-messaging` transport reuses upstream HTTP client, authorization-header builder and renewable DPoP service. It signs the selected route, preserves direct origins and URL prefixes, follows relay endpoint renewals, retries a rejected DPoP credential once, carries bearer credentials only in headers, and uses session cookies where applicable. Requests have cancellation and bounded timeouts. No localhost substitution or token query parameter is introduced.

Message polling advances only from applied server pages, preserves server order, deduplicates overlapping deliveries and drains backlog serially. Send retries reuse the original idempotency key for unchanged content and do not append send responses ahead of unseen history. Newly created channels survive stale polling snapshots. Existing factory project names are not re-registered on every new channel, so renaming an inherited project does not block channel creation.

## Verification

- Web production build passed.
- Web and client-runtime typechecks passed.
- Four HTTP transport tests passed: selected host and URL prefix with cookies, bearer header handling, exact DPoP proof and 401 renewal, and safe transport errors.
- Message page overlap/deduplication unit test passed.
- `git diff --check` passed.
- Real browser against isolated built runtime at `127.0.0.1:4312`: paired using temporary owner-only credentials, completed inherited onboarding without importing conversations, added the existing Perpeto checkout through the real project UI, created messaging channels, sent a recipient-addressed message, and read it after reloading. Sender role persisted. An inbound message submitted through the authenticated HTTP API appeared through browser polling. No page errors during create/send.
- Desktop 1440x1000 and mobile 390x844 screenshots inspected. Mobile has no horizontal overflow and the Send control is visible.
- Independent messaging-core review identified project rename/bootstrap and stale channel polling races; both fixed and re-reviewed without remaining correctness blockers.

Screenshots are local ignored validation artifacts: `.perpeto/ui-validation/messaging-desktop.png` and `.perpeto/ui-validation/messaging-mobile.png`. Temporary auth artifacts also stay inside that ignored owner-only validation directory and must never be committed. The isolated runtime is still running on 4312 for lead inspection.

## Limits

No verification on two physical devices, real remote DPoP connection, or agent harness messaging invocation is claimed here. Current history rendering drains the full channel into React DOM; bounded windows/virtualization are a scale follow-up. Threads, reactions, private messages, agent wakeups and graph execution are not implemented by this page. Existing inherited provider-update notifications may overlap page content until dismissed.
