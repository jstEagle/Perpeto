import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Factories from "./factories.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer), Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provide(ServerEnvironment.layerIdentity),
);
const serverLayer = HttpRouter.serve(Factories.layer.pipe(Layer.provide(Factories.storageLayer)), { disableListenLog: true }).pipe(
  Layer.provideMerge(authLayer), Layer.provideMerge(NodeHttpServer.layerTest),
);
const prefix = "/api/perpeto/factories/projects/project";
const definition = { name: "Build", nodes: [{ id: "lead", type: "agent", label: "Lead", harness: "codex", allowSubagents: true, maxSubagents: 8, maxConcurrent: 8 }], edges: [] };
it.layer(ServerConfig.layerTest(process.cwd(), { prefix: "perpeto-factory-http-" }).pipe(Layer.provideMerge(NodeServices.layer)))("Factory definition HTTP", (it) => {
  it.effect("authenticates every request and persists versioned definitions with stale-write protection", () => Effect.gen(function* () {
    const services = yield* Layer.build(serverLayer);
    const client = Context.get(services, HttpClient.HttpClient);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const writer = yield* auth.issueSession({ scopes: ["orchestration:read", "orchestration:operate"] });
    const reader = yield* auth.issueSession({ scopes: ["orchestration:read"] });
    const request = (method: "GET" | "POST" | "PUT", route: string, token?: string, input?: unknown) => Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.make(method)(route, {
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        ...(input === undefined ? {} : { body: HttpBody.text(JSON.stringify(input), "application/json") }),
      }));
      return { status: response.status, body: yield* response.json };
    });
    expect((yield* request("GET", prefix)).status).toBe(401);
    expect((yield* request("POST", prefix, reader.token, { id: "build", ...definition })).status).toBe(403);
    expect((yield* request("POST", prefix, writer.token, { id: "build", ...definition }))).toMatchObject({ status: 201, body: { id: "build", version: 1, name: "Build" } });
    expect((yield* request("GET", `${prefix}/build`, reader.token))).toMatchObject({ status: 200, body: { version: 1 } });
    expect((yield* request("PUT", `${prefix}/build`, writer.token, { ...definition, expectedVersion: 1, name: "Changed" }))).toMatchObject({ status: 200, body: { version: 2, name: "Changed" } });
    expect((yield* request("PUT", `${prefix}/build`, writer.token, { ...definition, expectedVersion: 1 }))).toMatchObject({ status: 409, body: { error: { code: "CONFLICT" } } });
    expect((yield* request("GET", `${prefix}/build?version=1`, reader.token))).toMatchObject({ status: 200, body: { version: 1, name: "Build" } });
    expect((yield* request("GET", prefix, reader.token))).toMatchObject({ status: 200, body: { factories: [{ version: 2 }] } });
    expect((yield* request("GET", `${prefix}/missing`, reader.token)).status).toBe(404);
    expect((yield* request("GET", "/api/perpeto/factories/projects/other", reader.token))).toMatchObject({ status: 200, body: { factories: [] } });
    expect((yield* request("GET", "/api/perpeto/factories/projects/other/build", reader.token)).status).toBe(404);
    expect((yield* request("POST", prefix, writer.token, { id: "invalid", ...definition, edges: [{ id: "bad", type: "workflow", source: "lead", target: "missing" }] })).status).toBe(400);
    yield* auth.revokeSession(reader.sessionId);
    expect((yield* request("GET", prefix, reader.token)).status).toBe(401);
  }).pipe(Effect.scoped));
  it.effect("caps streamed request bodies and rejects invalid JSON", () => Effect.gen(function* () {
    const services = yield* Layer.build(serverLayer);
    const client = Context.get(services, HttpClient.HttpClient);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const writer = yield* auth.issueSession({ scopes: ["orchestration:operate"] });
    for (const [content, status] of [["{broken", 400], [JSON.stringify({ id: "oversized", name: "x".repeat(Factories.MAX_BODY_BYTES) }), 413]] as const) {
      const response = yield* client.execute(HttpClientRequest.post(prefix, {
        headers: { authorization: `Bearer ${writer.token}` }, body: HttpBody.stream(Stream.make(new TextEncoder().encode(content)), "application/json"),
      }));
      expect(response.status).toBe(status);
    }
  }).pipe(Effect.scoped));
});
