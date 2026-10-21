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
 */

/**
 * @typedef {object} CandidateRequest
 * @property {string} baseSha
 * @property {MergeEntry[]} entries
 * @property {'merge'|'squash'|'rebase'} method
 * @property {string} idempotencyKey Stable per queue attempt, including across process restart.
 */

/**
 * @typedef {object} GitForgeAdapter
 * @property {boolean} atomicMerge True only when base and heads are guarded atomically.
 * @property {(baseBranch:string) => Promise<string>} getBase
 * @property {(entry:MergeEntry) => Promise<string>} getHead
 * @property {(request:CandidateRequest) => Promise<{revision:string}>} prepare
 * @property {(request:{baseBranch:string,revision:string}) => Promise<boolean>} isMerged
 * @property {(request:CandidateRequest & {baseBranch:string,revision:string}) => Promise<{status:'merged',revision:string}|{status:'base_changed'|'head_changed'}>} merge
 */

export {};
