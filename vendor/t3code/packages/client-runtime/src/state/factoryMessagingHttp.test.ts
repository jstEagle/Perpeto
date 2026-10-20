import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { BearerConnectionTarget, RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchFactoryMessaging } from "./factoryMessagingHttp.ts";

const environmentId = EnvironmentId.make("remote-machine");
const target = new BearerConnectionTarget({ environmentId, label: "Dev box", connectionId: "saved" });
const prepared: PreparedConnection = { environmentId, label: "Dev box", httpBaseUrl: "https://devbox.test/prefix", socketUrl: "wss://devbox.test/ws", target, httpAuthorization: null };
const path = "/api/perpeto/projects/project/channels";

describe("factory messaging environment transport", () => {
  it.effect("sends cookies only to the selected environment, retaining its URL prefix", () => Effect.gen(function* () {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = yield* fetchFactoryMessaging({ prepared, path }).pipe(Effect.provide(layerRemoteHttpClient(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ channels: [] });
    })));
    expect(result).toEqual({ channels: [] });
    expect(calls[0]?.url).toBe("https://devbox.test/prefix/api/perpeto/projects/project/channels");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
  }));

  it.effect("puts bearer grants in a header and never in the URL", () => Effect.gen(function* () {
    yield* fetchFactoryMessaging({ prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: "private-test-grant" } }, path, method: "POST", body: { id: "general", name: "General" } }).pipe(Effect.provide(layerRemoteHttpClient(async (url, init) => {
      expect(String(url)).not.toContain("private-test-grant");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-grant");
      expect(init?.credentials).toBe("omit");
      expect(init?.method).toBe("POST");
      return Response.json({ id: "general" });
    })));
  }));

  it.effect("renews rejected DPoP once, signing the exact relay endpoint", () => Effect.gen(function* () {
    const authorizations: Array<string | undefined> = [];
    const proofs: string[] = [];
    let count = 0;
    const remote = RemoteEnvironmentAuthorization.of({
      authorizeBearer: () => Effect.die("unexpected"), authorizeDpop: () => Effect.die("unexpected"),
      authorizeDpopHttp: (input) => Effect.sync(() => {
        authorizations.push(input.rejectedAccessToken);
        return { environmentId, label: "Dev box", httpBaseUrl: "https://relay.test/environment", httpAuthorization: { _tag: "Dpop" as const, accessToken: input.rejectedAccessToken ? "renewed" : "first", expiresAtEpochMs: 100000 } };
      }),
    });
    yield* fetchFactoryMessaging({ prepared: { ...prepared, target: new RelayConnectionTarget({ environmentId, label: "Dev box" }), httpAuthorization: { _tag: "Dpop", accessToken: "old", expiresAtEpochMs: 0 } }, path }).pipe(
      Effect.provideService(RemoteEnvironmentAuthorization, remote),
      Effect.provideService(ManagedRelayDpopSigner, { thumbprint: Effect.succeed("thumbprint"), createProof: (input) => Effect.sync(() => { proofs.push(input.url); return "proof"; }) }),
      Effect.provide(layerRemoteHttpClient(async (url, init) => {
        count++;
        expect(String(url)).toBe("https://relay.test/environment" + path);
        expect(new Headers(init?.headers).get("dpop")).toBe("proof");
        return count === 1 ? Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }) : Response.json({ channels: [] });
      })),
    );
    expect(authorizations).toEqual([undefined, "first"]);
    expect(proofs).toEqual(["https://relay.test/environment" + path, "https://relay.test/environment" + path]);
  }));

  it.effect("returns actionable errors without exposing transport credentials", () => Effect.gen(function* () {
    const result = yield* fetchFactoryMessaging({ prepared, path }).pipe(
      Effect.provide(layerRemoteHttpClient(async () => { throw new Error("secret internal URL"); })), Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("Messaging connection failed");
      expect(result.failure.message).not.toContain("secret");
    }
  }));
});
