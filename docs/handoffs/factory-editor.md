# Visual factory definition editor

Delivered the authenticated `/factories` route and a readable Factories sidebar action, using the actual selected T3 environment and project. The editor creates, loads, edits and saves versioned factory definitions through the real factory API. It reuses the existing cookie/bearer/DPoP transport with a narrowly added factory-definition route prefix; unrelated API paths remain rejected.

The canvas supports adding, selecting and moving agent, context, check and merge-queue nodes. Nodes move by pointer drag or arrow keys. The property inspector edits harness/model, subagent permissions and counts, concurrency, context references, command argv and merge requirements. Typed connections are visible on the canvas and removable in the inspector. Delegation cycles and invalid context/delegation endpoints are rejected locally, with the server remaining authoritative. Deleting a node removes its incident edges.

Saved definitions use observed-version CAS. Stale writes leave the local graph intact and offer Reload saved or Save copy. A known server ID or conflict also allows Reload saved when an interrupted creation has an uncertain result. A browser-session memory cache retains every factory draft and selected draft per project/environment across project switches, factory switches and ordinary sidebar navigation. Initial list loads and connection refreshes cannot replace an edited draft; controls are disabled during initial loading and aborted requests cannot leave the editor stuck saving.

Workshop values are imported from the canonical brand tokens and scoped to this page. The mobile factory picker has its own full-width toolbar row. Messages and Factories occupy a dedicated readable sidebar row above the inherited utilities. Editor layout/defaults live in `editor.config.json`; no new runtime dependency was added.

## Verification

- Web and client-runtime typechecks passed during implementation. Root also ran the final focused inherited suite: 220 tests passed.
- Nine graph/messaging helper tests passed, including typed defaults, delegation cycles, context endpoint restrictions, edge removal and strict save payload metadata stripping.
- Five HTTP auth tests passed, including the new factory-definition namespace and rejection of unrelated routes, plus existing cookie/bearer/DPoP behavior.
- Web production build passed; root full packaged production build passed after the lifecycle and responsive fixes.
- Independent read-only reviewer approved final serialization/CAS and lifecycle changes after identifying and confirming fixes for draft loss, first-list overwrite and aborted-save state.
- Real browser on source runtime first, then repeated on the refreshed packaged `dist/bin.mjs` runtime at isolated port 4312: created five nodes and four typed edges, edited Claude/model/subagent/concurrency properties, moved nodes by dragging and keyboard, saved version 1 and reloaded the graph. Serialized settings and positions matched.
- Packaged browser: an external authenticated HTTP CAS update made the local save stale. The UI showed a conflict and retained the edited node name. Save copy preserved the complete local graph as a new definition.
- Packaged browser: two unsaved factories retained their names and graph state across Messages/Factories sidebar navigation and switching between two real T3 projects.
- Desktop 1440x1000 and mobile 390x844 screenshots inspected after dismissing inherited update notifications. Mobile has no horizontal overflow. Fixed controls are readable; create/save flow produced zero page errors.
- Packaged bounded-message read/older/latest/send regression also passed before editor verification.

Screenshots are ignored local artifacts at `.perpeto/ui-validation/factory-editor-desktop.png` and `factory-editor-mobile.png`. Temporary credentials remain owner-only under the same ignored validation directory. The isolated packaged runtime remains running on 4312 for lead inspection. An isolated Git repository under `/tmp/perpeto-editor-project-*` was added only to the validation runtime to test cross-project draft retention.

## Boundaries

Definitions are inert configuration. The editor explicitly displays Definition only and has no Run action. Saving does not launch harnesses, read context files, execute checks, enforce native subagent limits, schedule work or merge changes. Model names are stored without testing provider availability. The editor loads current definitions and shows their saved version; browsing historical immutable revisions is available through the backend API, not a revision-history picker here.

Unsaved drafts survive navigation only within the current browser application session. Reloading or closing the application discards unsaved edits; saved revisions persist on the hosting environment. Real remote-device graph editing, live DPoP pairing and read-only browser editing were not independently exercised by this worker; authorization transport tests cover the existing credential paths and server scopes remain authoritative.
