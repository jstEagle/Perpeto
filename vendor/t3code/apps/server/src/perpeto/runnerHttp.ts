import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RunnerError } from "../../../../../../packages/factory-runner/src/queue.js";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ApiError, readJsonBody } from "./http.ts";
import * as Runner from "./Runner.ts";

const fail = (status:number,code:string,message:string) => new ApiError({status,code,message});
const operation = <A>(f:()=>A) => Effect.try({try:f,catch:error => error instanceof RunnerError
  ? fail(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" || error.code === "STALE_LEASE" ? 409 : 400,error.code,error.message)
  : fail(500,"INTERNAL_ERROR","Runner operation failed.")});
export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const queue = yield* Runner.FactoryRunner;
  yield* router.add("*","/api/perpeto/runner/*",Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.mapError(error => EnvironmentAuth.isServerAuthCredentialError(error)
      ? fail(401,"UNAUTHORIZED","A valid environment session is required.") : fail(500,"INTERNAL_ERROR","Authentication failed.")));
    const scope = request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
    if (!session.scopes.includes(scope)) return yield* fail(403,"FORBIDDEN",`Required scope: ${scope}.`);
    const url = new URL(request.url,"http://perpeto.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[3];
    if (action === "claim" && parts.length === 4 && request.method === "POST") {
      const input = yield* readJsonBody;
      return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.claim(input)));
    }
    if (action === "jobs" && parts.length === 4) {
      if (request.method === "POST") {
        const input = yield* readJsonBody;
        return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.submit(input)));
      }
      if (request.method === "GET") return HttpServerResponse.jsonUnsafe({jobs:yield* operation(()=>queue.list({projectId:url.searchParams.get("projectId"),...(url.searchParams.has("limit") ? {limit:Number(url.searchParams.get("limit"))} : {})}))});
    }
    const id = parts[4];
    if (action === "jobs" && id && parts.length === 5 && request.method === "GET") return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.get(id)));
    if (action === "jobs" && id && parts.length === 6 && request.method === "POST") {
      const input = yield* readJsonBody;
      switch (parts[5]) {
        case "heartbeat": return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.heartbeat({...input,id})));
        case "complete": return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.complete({...input,id})));
        case "retry": return HttpServerResponse.jsonUnsafe(yield* operation(()=>queue.retry(id)));
      }
    }
    return yield* fail(404,"NOT_FOUND","Runner route not found.");
  }).pipe(Effect.catchTag("PerpetoMessagingApiError",error=>Effect.succeed(HttpServerResponse.jsonUnsafe({error:{code:error.code,message:error.message}},{status:error.status})))));
}));
