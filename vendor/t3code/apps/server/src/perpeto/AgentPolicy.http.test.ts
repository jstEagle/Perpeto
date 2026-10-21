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
import * as Messaging from "./Messaging.ts";
import * as PerpetoHttp from "./http.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerEnvironment.layerIdentity),
);
const serverLayer = HttpRouter.serve(PerpetoHttp.layer.pipe(Layer.provide(Messaging.layer)), {
  disableListenLog: true,
}).pipe(Layer.provideMerge(authLayer), Layer.provideMerge(NodeHttpServer.layerTest));
const prefix = "/api/perpeto/agent-policies/thread%3Aroot";

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "perpeto-policy-http-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("Perpeto agent policy routes", (it) => {
  it.effect("attaches, reads and reports policies with environment scopes", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(serverLayer);
      const client = Context.get(services, HttpClient.HttpClient);
      const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      const operator = yield* auth.issueSession({
        label: "factory-executor",
        scopes: ["orchestration:read", "orchestration:operate"],
      });
      const reader = yield* auth.issueSession({ label: "observer", scopes: ["orchestration:read"] });
      const request = (method: "GET" | "POST" | "PUT", route: string, token?: string, payload?: unknown) =>
        Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.make(method)(route, {
              ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
              ...(payload === undefined
                ? {}
                : { body: HttpBody.text(JSON.stringify(payload), "application/json") }),
            }),
          );
          return { status: response.status, body: yield* response.json };
        });
      const policy = { maxSubagents: 1, allowedSubagentProviders: ["claudeAgent"] };
      expect((yield* request("PUT", prefix, undefined, policy)).status).toBe(401);
      expect((yield* request("PUT", prefix, reader.token, policy)).status).toBe(403);
      expect((yield* request("GET", prefix, reader.token)).status).toBe(404);
      expect(yield* request("PUT", prefix, operator.token, policy)).toMatchObject({
        status: 200,
        body: { created: true, policy: { threadId: "thread:root", maxSubagents: 1, used: 0 } },
      });
      expect((yield* request("PUT", prefix, operator.token, policy)).body).toMatchObject({ created: false });
      expect(
        (yield* request("PUT", prefix, operator.token, { ...policy, maxSubagents: 5 })).status,
      ).toBe(409);
      expect(
        (yield* request("PUT", "/api/perpeto/agent-policies/x", operator.token, { maxSubagents: -1, allowedSubagentProviders: [] }))
          .status,
      ).toBe(400);
      const native = { subagentId: "node:native-1", driver: "claudeAgent", providerInstanceId: "claudeAgent", model: "m" };
      expect((yield* request("POST", `${prefix}/native-subagents`, operator.token, native)).body).toMatchObject({
        allowed: true,
        used: 1,
      });
      expect(
        (yield* request("POST", `${prefix}/native-subagents`, operator.token, { ...native, subagentId: "node:native-2" })).body,
      ).toMatchObject({ allowed: false });
      const log = yield* request("GET", `${prefix}/decisions?after=0`, reader.token);
      expect(log.body).toMatchObject({
        decisions: [
          { outcome: "created", kind: "provider_native", childRef: "node:native-1" },
          { outcome: "refused", kind: "provider_native" },
        ],
        hasMore: false,
      });
      expect((yield* request("GET", `${prefix}/decisions?after=-1`, reader.token)).status).toBe(400);
      expect((yield* request("GET", `${prefix}/other`, reader.token)).status).toBe(404);
    }),
  );
});
