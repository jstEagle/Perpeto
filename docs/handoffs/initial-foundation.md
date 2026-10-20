# Initial foundation handoff

Perpeto's first implementation preserves T3 Code under `vendor/t3code` and adds a root launcher plus durable messaging storage. The import is pinned in `config/upstream.json`; `config/upstream-files.json` records every imported file hash. MIT licenses and third-party notices are retained. The original Perpeto brand and documentation are preserved in the first repository commit.

Setup includes both the server dependency closure and upstream build scripts; the latter is necessary for `typescript-legacy` used during bundling. Root configuration supplies explicit host, port and state flags. The initial browser-opening bug identified in review was corrected by selecting `start` for interactive launches and `serve` otherwise.

Local checks: 9 Perpeto tests, 170 focused upstream tests, complete web/server build, CLI help, actual startup and restart with an isolated database. HTTP descriptor and HTML responded; no authenticated customer flow or live provider inference was tested. The inherited UI remains branded T3. GitHub workflow execution must be reported separately from local tests.

Continue with authenticated messaging transport/tool integration; current messaging is an API for local durable storage. Factory graph execution, cross-machine scheduling, CI runners and release packaging remain unfinished.

Setup was also verified to restore the host repository's Git hook configuration after upstream prepare, which otherwise installs a hook targeting the nested upstream workspace.
