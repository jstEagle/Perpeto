/** @typedef {import('./jobs.js').CIConfig} CIConfig */
/** @typedef {import('./jobs.js').MachineRequirements} MachineRequirements */
/** @typedef {import('./jobs.js').JobStep} JobStep */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} projectId
 * @property {string} [runId]
 * @property {string} [workItemId]
 * @property {{url:string,defaultBranch?:string,localPath?:string}} repo
 * @property {string} revision Full commit SHA.
 * @property {JobStep[]} steps
 * @property {MachineRequirements} requirements
 * @property {'queued'|'leased'|'running'|'passed'|'failed'|'cancelled'|'error'} status
 * @property {number} attempt
 * @property {string} configHash
 * @property {object[]} artifacts
 * @property {string} [logRef]
 * @property {string} [machineId]
 * @property {string} [leaseExpiresAt]
 * @property {{name:string,status:'passed'|'failed'|'pending',revision:string,configHash:string}[]} [checks]
 * @property {string} [queueAttemptId] Private delivery metadata; not required from a node result.
 */

/**
 * @typedef {object} MergeEntry
 * @property {string} id
 * @property {string} projectId
 * @property {string} prUrl
 * @property {string} headSha
 * @property {string} baseBranch
 * @property {'queued'|'testing'|'merging'|'merged'|'rejected'} status
 * @property {string} [jobId]
 * @property {string} [reason]
 * @property {string} [testedRevision] Perpeto speculative candidate.
 * @property {string} [mergedRevision] Published SHA, potentially different for GitHub native queue.
 */

/**
 * @typedef {object} CandidateRequest
 * @property {string} baseSha
 * @property {MergeEntry[]} entries
 * @property {'merge'|'squash'|'rebase'} method
 * @property {'fast-forward-push'|'github-merge-queue'} [publication]
 * @property {string} idempotencyKey Stable per queue attempt, including across process restart.
 */

/**
 * @typedef {object} GitForgeAdapter
 * @property {boolean} atomicMerge Atomic publication capability; see adapter-specific guarantees in README (not a universal base/head CAS).
 * @property {(baseBranch:string,publication?:'fast-forward-push'|'github-merge-queue') => Promise<string>} getBase
 * @property {(entry:MergeEntry) => Promise<string>} getHead
 * @property {(request:CandidateRequest) => Promise<{revision:string}>} prepare
 * @property {(request:{baseBranch:string,revision:string}) => Promise<boolean>} isMerged
 * @property {(request:CandidateRequest & {baseBranch:string,revision:string,evidence?:Job,publicationState?:string}) => Promise<{status:'merged',revision:string,publication?:'github-merge-queue'}|{status:'base_changed'|'head_changed'}|{status:'pending',publicationState:string}|{status:'rejected',reason:string}>} merge
 */

export {};
