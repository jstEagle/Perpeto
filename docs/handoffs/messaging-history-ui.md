# Bounded messaging history UI

The messaging page opens the latest 100 messages, polls at most one forward page per interval, and retains at most 500 rendered messages. The page-size, render limit and poll intervals live in `vendor/t3code/apps/web/src/components/factory/messaging.config.json`.

Older history is explicit: Load older switches to a stable browsing window with live updates paused. More older pages evict the newest pages once the render bound is reached. Latest returns to the current newest page and resumes live polling. Sending from history also returns to Latest so the posted result is visible. Live overflow evicts whole oldest pages; each retained page keeps the server-provided cursor so Load older always starts at an actual visible boundary. Poll overlap, duplicate pages and cancelled requests cannot append duplicates or overwrite a newer navigation request.

## Verification

- Web typecheck and production build passed.
- Five messaging UI unit tests passed, including initial latest, 3,000 forward messages, 1,000 backward messages, overlapping delivery and no-op polling.
- Real browser against the source server and built web UI on isolated port 4312: seeded 1,200 messages, loaded 100 newest initially, used six older loads with exactly 500 rendered, confirmed no message polling while browsing older history, and restored Latest with 100 messages and live polling.
- Submitted a further 600 messages through the authenticated HTTP API; the browser caught up while rendering at most 500. All captured message read requests specified limit=100. This validates bounded browser requests and DOM, not cross-device delivery.
- Mobile viewport 390x844 had no horizontal overflow. The inherited update notification was dismissed before screenshots.
- Screenshots: `.perpeto/ui-validation/messaging-bounded-desktop.png` and `.perpeto/ui-validation/messaging-bounded-mobile.png`.

The source server was used to pick up new latest/before endpoints without changing a server bundle during concurrent lead validation. The lead still owns final packaged-runtime verification and source provenance. Port 4312 now runs `apps/server/src/bin.ts`, replacing the earlier built-bin validation process; it uses the same ignored validation state directory.
