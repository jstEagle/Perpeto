import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { MessagingStore } from "../../../../../../packages/messaging/src/messaging-store.js";
import * as Messaging from "./Messaging.ts";
import * as MessagingHttp from "./http.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerEnvironment.layerIdentity),
);
const serverLayer = HttpRouter.serve(Layer.merge(MessagingHttp.layer.pipe(Layer.provide(Messaging.layer)), ServerHttp.layerBrowserApiCors), { disableListenLog: true }).pipe(
  Layer.provideMerge(authLayer),
  Layer.provideMerge(NodeHttpServer.layerTest),
);
const prefix = "/api/perpeto/projects/factory";

it.layer(ServerConfig.layerTest(process.cwd(), { prefix: "perpeto-http-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
))("Perpeto authenticated messaging transport", (it) => {
  it.effect("enforces live sessions/scopes and persists messages over real HTTP", () => Effect.gen(function* () {
    const services = yield* Layer.build(serverLayer);
    const client = Context.get(services, HttpClient.HttpClient);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const preflight = yield* client.execute(HttpClientRequest.options(prefix, {
      headers: { origin: "https://perpeto.example", "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PUT");
    const full = yield* auth.issueSession({ label: "factory-client", scopes: ["orchestration:read", "orchestration:operate"] });
    const reader = yield* auth.issueSession({ label: "observer", scopes: ["orchestration:read"] });
    const request = (method: "GET" | "POST" | "PUT", route: string, token?: string, payload?: unknown) => Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.make(method)(route, {
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        ...(payload === undefined ? {} : { body: HttpBody.text(JSON.stringify(payload), "application/json") }),
      }));
      return { status: response.status, body: yield* response.json };
    });
    expect((yield* request("PUT", prefix, undefined, { name: "Factory" })).status).toBe(401);
    expect((yield* request("PUT", prefix, reader.token, { name: "Factory" })).status).toBe(403);
    expect((yield* request("PUT", prefix, full.token, { name: "Factory" }))).toEqual({ status: 200, body: { id: "factory", name: "Factory" } });
    expect((yield* request("POST", `${prefix}/channels`, full.token, { id: "build", name: "Build" })).status).toBe(200);
    expect((yield* request("GET", `${prefix}/channels`, reader.token)).body).toEqual({ channels: [{ projectId: "factory", id: "build", name: "Build" }] });
    expect((yield* request("POST", `${prefix}/channels`, full.token, { id: "..", name: "Invalid" })).status).toBe(400);
    const payload = { senderRoleId: "lead", recipientRoleId: "review", body: "Ready", idempotencyKey: "first" };
    const sent = yield* request("POST", `${prefix}/channels/build/messages`, full.token, payload);
    expect(sent.status).toBe(200);
    const result = sent.body as { message: { id: string }; duplicate: boolean };
    expect(result.duplicate).toBe(false);
    const retried = yield* request("POST", `${prefix}/channels/build/messages`, full.token, payload);
    expect(retried.body).toEqual({ message: result.message, duplicate: true });
    expect((yield* request("POST", `${prefix}/channels/build/messages`, reader.token, payload)).status).toBe(403);
    expect((yield* request("POST", `${prefix}/channels/build/messages`, full.token, { ...payload, body: "Different" })).status).toBe(409);
    const read = yield* request("GET", `${prefix}/channels/build/messages?recipientRoleId=review&limit=1`, reader.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ messages: [result.message], hasMore: false });
    expect((yield* request("GET", `${prefix}/channels/missing/messages`, reader.token)).status).toBe(404);
    expect((yield* request("GET", `${prefix}/channels/build/messages?limit=-1`, reader.token)).status).toBe(400);
    expect((yield* request("POST", `${prefix}/channels`, full.token, {}))).toMatchObject({ status: 400, body: { error: { code: "INVALID_INPUT" } } });
    const revoked = yield* auth.issueSession({ label: "revoked", scopes: ["orchestration:read"] });
    yield* auth.revokeSession(revoked.sessionId);
    expect((yield* request("GET", `${prefix}/channels`, revoked.token)).status).toBe(401);
    // A separate database connection sees the committed network result.
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const reopened = new MessagingStore(path.join(config.stateDir, "perpeto-messaging.sqlite"));
    try { expect(reopened.readMessages({ projectId: "factory", channelId: "build" }).messages).toEqual([result.message]); }
    finally { reopened.close(); }
  }).pipe(Effect.scoped));

  it.effect("supports bounded latest/older pages and rejects ambiguous history queries", () => Effect.gen(function* () {
    const services = yield* Layer.build(serverLayer);
    const client = Context.get(services, HttpClient.HttpClient);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const session = yield* auth.issueSession({ scopes: ["orchestration:read", "orchestration:operate"] });
    const headers = { authorization: `Bearer ${session.token}` };
    const request = (method: "GET" | "POST" | "PUT", route: string, payload?: unknown) => Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.make(method)(route, {
        headers, ...(payload === undefined ? {} : { body: HttpBody.text(JSON.stringify(payload), "application/json") }),
      }));
      return { status: response.status, body: yield* response.json };
    });
    const root = "/api/perpeto/projects/history";
    yield* request("PUT", root, { name: "History" });
    yield* request("POST", `${root}/channels`, { id: "build", name: "Build" });
    const route = `${root}/channels/build/messages`;
    for (let i = 0; i < 5; i++) yield* request("POST", route, { senderRoleId: "lead", body: `Message ${i}`, idempotencyKey: `history-${i}` });
    type Page = { messages: Array<{ body: string }>; previousCursor: string; nextCursor: string; hasMore: boolean };
    const newest = yield* request("GET", `${route}?latest=true&limit=2`);
    const page = newest.body as Page;
    expect(newest.status).toBe(200);
    expect(page.messages.map(message => message.body)).toEqual(["Message 3", "Message 4"]);
    expect(page.hasMore).toBe(true);
    const older = (yield* request("GET", `${route}?before=${encodeURIComponent(page.previousCursor)}&limit=2`)).body as Page;
    expect(older.messages.map(message => message.body)).toEqual(["Message 1", "Message 2"]);
    expect(older.hasMore).toBe(true);
    const forward = (yield* request("GET", `${route}?after=${encodeURIComponent(older.nextCursor)}&limit=2`)).body as Page;
    expect(forward.messages.map(message => message.body)).toEqual(["Message 3", "Message 4"]);
    expect(forward.hasMore).toBe(false);
    for (const query of ["latest=1", "latest=", "before=bad", `latest=true&after=${page.nextCursor}`, `after=${page.nextCursor}&before=${page.previousCursor}`]) {
      expect((yield* request("GET", `${route}?${query}`)).status).toBe(400);
    }
    expect((yield* request("GET", `${route}?latest=false&limit=2`)).status).toBe(200);
  }).pipe(Effect.scoped));

  it.effect("rejects malformed JSON and caps chunked requests before storage", () => Effect.gen(function* () {
    const services = yield* Layer.build(serverLayer);
    const client = Context.get(services, HttpClient.HttpClient);
    const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const session = yield* auth.issueSession({ scopes: ["orchestration:operate"] });
    for (const [content, expected] of [["{broken", 400], [JSON.stringify({ name: "x".repeat(MessagingHttp.MAX_BODY_BYTES) }), 413]] as const) {
      const response = yield* client.execute(HttpClientRequest.put(prefix, {
        headers: { authorization: `Bearer ${session.token}` },
        body: HttpBody.stream(Stream.make(new TextEncoder().encode(content)), "application/json"),
      }));
      expect(response.status).toBe(expected);
    }
  }).pipe(Effect.scoped));
});
