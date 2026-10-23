# CI pipelines

A repository describes its CI in `.perpeto/ci.json`. The hub reads the file at the exact commit it runs, expands each pipeline into a graph of jobs, and leases those jobs to your machines' runner pools. Check a file before committing it:

```sh
perpeto ci validate                 # .perpeto/ci.json in the current directory
perpeto ci validate --file other.json
```

Validation is offline and reports every problem with a JSON path, for example `$.pipelines.default.jobs.test.needs: Unknown job "build".`

## Example

```json
{
  "version": 1,
  "defaults": { "timeoutSec": 1800, "env": { "CI_PROFILE": "fast" } },
  "pipelines": {
    "default": {
      "triggers": [{ "on": "merge-queue" }, { "on": "pull-request" }, { "on": "schedule", "cron": "0 3 * * *" }],
      "jobs": {
        "lint": { "steps": [{ "name": "lint", "run": "npm run lint" }] },
        "test": {
          "needs": ["lint"],
          "matrix": { "node": ["22", "24"], "os": ["darwin", "linux"] },
          "runsOn": { "pool": "default", "os": "{{ matrix.os }}" },
          "cache": [{ "key": "node-modules-{{ matrix.os }}-{{ hashFiles('package-lock.json') }}", "paths": ["node_modules"] }],
          "retry": { "maxAttempts": 2 },
          "steps": [{ "name": "install", "run": "npm ci" }, { "name": "test", "run": "npm test" }]
        },
        "package": {
          "needs": ["test"],
          "artifacts": [{ "name": "tarball", "paths": ["*.tgz"], "maxBytes": 52428800, "when": "on-success" }],
          "steps": [{ "name": "pack", "run": "npm pack" }]
        }
      }
    }
  }
}
```

## Schema

| Field | Meaning |
| --- | --- |
| `version` | Required, `1`. |
| `defaults` | Optional `runsOn`, `env`, `timeoutSec` and `retry` for every job. |
| `pipelines.<name>` | Names are 1 to 64 letters, digits, `.`, `_` or `-`. At most 50 pipelines. |
| `.description` | Optional text. |
| `.triggers` | `manual` (default, and always allowed), `merge-queue`, `pull-request` (optional `branches`), `schedule` (`cron`: five-field UTC cron; optional `branch`). |
| `.env` | Non-secret variables for every job of the pipeline. |
| `.jobs.<name>` | At most 100 jobs per pipeline. |
| `steps` | 1 to 50 `{ name, run, timeoutSec? }`; `run` is a shell command. |
| `needs` | Jobs that must pass first. Needing a matrix job waits for every combination. Cycles are rejected. |
| `matrix` | Up to 4 keys and 64 combinations. Each combination is its own job, keyed like `test (node=22, os=linux)`, with `MATRIX_<KEY>` set. |
| `runsOn` | `pool` (absent: any pool), `os` (`darwin`, `linux`, `windows` or `{{ matrix.<key> }}`), `labels` (runner or machine labels). |
| `timeoutSec` | Whole-job limit, 1 to 86400, default 3600. Steps also keep their own `timeoutSec`. |
| `env` | Non-secret variables. `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `GIT_CONFIG_*`, `GIT_TERMINAL_PROMPT` and `PERPETO_*` are reserved. |
| `cache` | Up to 4 `{ key, paths }`. Restored before the steps, saved after a passing run that missed. |
| `artifacts` | Up to 8 `{ name, paths (globs), maxBytes? (default 50 MiB, max 1 GiB), when? ('always' default, 'on-success', 'on-failure') }`. |
| `retry` | `{ maxAttempts: 1..5 }`, default 1. A failed or errored attempt reruns as a new job until the limit. |

Templates are `{{ matrix.<key> }}` in step commands, env values, `runsOn` and artifact names, and `{{ hashFiles('glob', ...) }}` in cache keys only. The runner resolves `hashFiles` from the checked-out files. Secrets never belong in this file: it is committed, and the hub stores only non-secret configuration.

Steps also get `CI=true` (overridable), `PERPETO_CI=1`, `PERPETO_JOB_ID`, `PERPETO_REVISION` and `PERPETO_PIPELINE_JOB`.

## Where configuration comes from

1. `.perpeto/ci.json` at the run's revision, when the hub holds the repository (local projects, and merge-queue candidates in the hub's mirror). An invalid file fails the run; it is never silently replaced.
2. Otherwise the project's hub-stored configuration: `PUT /api/v1/projects/:id/ci-config { config }` (same schema; `null` removes it).

## Running pipelines

```sh
perpeto ci run default                    # default branch head the hub holds
perpeto ci run default --rev HEAD          # resolved by Git in this directory
perpeto ci status --project Web
perpeto ci logs job_… --follow
```

- **Workflow `ci` nodes** take `"pipeline": "default"` instead of inline `steps`. The node's gate passes when the pipeline run passes.
- **Merge queues**: `requiredChecks` entries may name pipelines. Each candidate then runs those pipelines at the candidate commit, and the queue merges only if all pass. A graph with no ci nodes and no required checks uses pipelines with a `merge-queue` trigger.
- **Pull requests**: when an agent reports a new head commit, pipelines with a `pull-request` trigger run at it. A newer run for the same branch cancels the older one.
- **Schedules** run against the default branch (or `branch`) head once per matching UTC minute.

## Runner pools and the cache

Each node's config has a `runner` section, separate from agent slots:

```json
"capacity": { "maxAgents": 0, "maxJobs": 3 },
"runner": {
  "pools": [{ "name": "default", "maxJobs": 2 }, { "name": "gpu", "maxJobs": 1 }],
  "labels": ["cuda"],
  "cacheDir": "../.perpeto/node/ci-cache",
  "cacheMaxBytes": 10737418240,
  "artifactMaxBytes": 104857600
}
```

`maxAgents: 0` makes a CI-only machine, `maxJobs: 0` an agents-only one. Without pools a machine has one `default` pool of `maxJobs`. The dependency cache lives in `cacheDir` (default `<dataDir>/ci-cache`). Entries are per project, evicted least recently used above `cacheMaxBytes`, and only the daemon touches them; steps cannot read the cache directory. Its size is reported in heartbeats and shown on the CI screen.
