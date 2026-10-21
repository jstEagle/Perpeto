import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Runner from "./Runner.ts";
import * as RunnerHttp from "./runnerHttp.ts";
import * as Messaging from "./Messaging.ts";
import * as MessagingHttp from "./http.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer), Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provide(ServerEnvironment.layerIdentity),
);
const routes = Layer.merge(RunnerHttp.layer.pipe(Layer.provide(Runner.layer)), MessagingHttp.layer.pipe(Layer.provide(Messaging.layer)));
it.layer(ServerConfig.layerTest(process.cwd(), {prefix:"perpeto-runner-http-"}).pipe(Layer.provideMerge(NodeServices.layer)))("Runner HTTP authorization", it => {
  it.effect("uses existing environment scopes for submit, claim, results and revocation", () => Effect.gen(function* () {
    const services = yield* Layer.build(HttpRouter.serve(routes,{disableListenLog:true}).pipe(Layer.provideMerge(authLayer),Layer.provideMerge(NodeHttpServer.layerTest)));
    const client = Context.get(services,HttpClient.HttpClient), auth = Context.get(services,EnvironmentAuth.EnvironmentAuth);
    const full = yield* auth.issueSession({scopes:["orchestration:read","orchestration:operate"]});
    const reader = yield* auth.issueSession({scopes:["orchestration:read"]});
    const call = (method:"GET"|"POST",path:string,token?:string,body?:unknown) => Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.make(method)(`/api/perpeto/runner${path}`,{
        ...(token ? {headers:{authorization:`Bearer ${token}`}} : {}),
        ...(body === undefined ? {} : {body:HttpBody.text(JSON.stringify(body),"application/json")}),
      }));
      return {status:response.status,body:yield* response.json};
    });
    const input = {projectId:"factory",repositoryId:"app",revision:"a".repeat(40),command:["node","test.js"],idempotencyKey:"first"};
    expect((yield* call("POST","/jobs",undefined,input)).status).toBe(401);
    expect((yield* call("POST","/jobs",reader.token,input)).status).toBe(403);
    const submitted = yield* call("POST","/jobs",full.token,input);
    expect(submitted.status).toBe(200);
    const {job} = submitted.body as {job:{id:string}};
    expect((yield* call("GET",`/jobs/${job.id}`,reader.token)).body).toMatchObject({status:"queued",revision:input.revision});
    const claimInput = {runnerId:"machine",repositoryIds:["app"],labels:[]};
    expect((yield* call("POST","/claim",reader.token,claimInput)).status).toBe(403);
    const claimed = yield* call("POST","/claim",full.token,claimInput);
    expect(claimed.status).toBe(200);
    const lease = claimed.body as {leaseToken:string};
    const result = {exitCode:0,timedOut:false,logsTruncated:false,log:"pass",artifacts:[]};
    expect((yield* call("POST",`/jobs/${job.id}/complete`,full.token,{runnerId:"machine",leaseToken:"stale",result})).status).toBe(409);
    expect((yield* call("POST",`/jobs/${job.id}/complete`,full.token,{runnerId:"machine",leaseToken:lease.leaseToken,result})).body).toMatchObject({status:"succeeded",result});
    expect((yield* call("GET",`/jobs/${job.id}`,reader.token)).body).not.toHaveProperty("leaseToken");
    yield* auth.revokeSession(full.sessionId);
    expect((yield* call("POST","/claim",full.token,claimInput)).status).toBe(401);
  }).pipe(Effect.scoped));
});
