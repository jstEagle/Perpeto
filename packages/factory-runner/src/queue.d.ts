export interface RunnerResult { exitCode: number | null; timedOut: boolean; logsTruncated: boolean; log: string; artifacts: Array<{path:string;size:number}> }
export interface Job { id:string;projectId:string;repositoryId:string;revision:string;command:string[];requiredLabels:string[];status:'queued'|'leased'|'succeeded'|'failed'|'lost';runnerId:string|null;leaseExpiresAt:number|null;attempt:number;result:RunnerResult|null;createdAt:number;updatedAt:number }
export class RunnerError extends Error { code:string }
export class RunnerQueue {
 constructor(filename:string,options?:{now?:()=>number});
 close():void;
 submit(input:Record<string,unknown>):{job:Job;duplicate:boolean};
 get(id:string):Job;
 list(input:Record<string,unknown>):Job[];
 claim(input:Record<string,unknown>):{job:Job;leaseToken:string;leaseExpiresAt:number}|null;
 heartbeat(input:Record<string,unknown>):Job;
 complete(input:Record<string,unknown>):Job;
 retry(id:string):Job;
}
