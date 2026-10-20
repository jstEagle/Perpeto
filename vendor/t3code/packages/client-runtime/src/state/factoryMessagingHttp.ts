import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";

export class FactoryMessagingHttpError extends Data.TaggedError("FactoryMessagingHttpError")<{
  readonly message: string;
  readonly code?: string;
}> {}
const failure = (message: string, code?: string) => new FactoryMessagingHttpError({ message, ...(code ? { code } : {}) });

export interface FactoryMessagingRequest {
  readonly prepared: PreparedConnection;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/** Uses the selected environment's existing cookie, bearer or renewable DPoP grant. */
const requestFactoryMessaging = (input: FactoryMessagingRequest) => Effect.gen(function* () {
  if (!input.path.startsWith("/api/perpeto/projects/") || input.path.includes("#")) {
    return yield* failure("Invalid factory endpoint.");
  }
  const client = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remote = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const method = input.method ?? "GET";
  let rejectedAccessToken: string | undefined;
  for (;;) {
    let baseUrl = input.prepared.httpBaseUrl;
    let authorization = input.prepared.httpAuthorization;
    if (authorization?._tag === "Dpop") {
      if (Option.isNone(remote)) return yield* failure("Reconnect this environment to authorize messaging.");
      const current = yield* remote.value.authorizeDpopHttp({
        expectedEnvironmentId: input.prepared.environmentId,
        ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
      }).pipe(Effect.mapError(() => failure("Could not authorize messaging. Reconnect this environment.")));
      authorization = current.httpAuthorization;
      if (input.prepared.target._tag === "RelayConnectionTarget") baseUrl = current.httpBaseUrl;
    }
    const url = `${baseUrl.replace(/\/$/, "")}${input.path}`;
    const headers = yield* buildEnvironmentAuthHeaders(authorization, method, url, signer).pipe(
      Effect.mapError(() => failure("Could not authorize messaging. Reconnect this environment.")),
    );
    const initial = HttpClientRequest.make(method)(url, { headers: { ...headers } });
    const request = input.body === undefined ? initial : yield* HttpClientRequest.bodyJson(initial, input.body).pipe(
      Effect.mapError(() => failure("Could not encode this message.")),
    );
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: authorization === null ? "include" : "omit", redirect: "error" }),
      Effect.mapError(() => failure("Messaging connection failed. Check the selected environment and retry.")),
    );
    if (response.status === 401 && authorization?._tag === "Dpop" && rejectedAccessToken === undefined) {
      rejectedAccessToken = authorization.accessToken;
      continue;
    }
    const result = yield* response.json.pipe(
      Effect.mapError(() => failure("This environment did not return a messaging response. Update its Perpeto runtime.")),
    );
    if (response.status < 200 || response.status >= 300) {
      const error = result as { error?: { code?: string; message?: string } };
      return yield* failure(error.error?.message ?? `Messaging request failed (${response.status}).`, error.error?.code);
    }
    return result;
  }
});

export const fetchFactoryMessaging = (input: FactoryMessagingRequest) => {
  const request = requestFactoryMessaging(input).pipe(Effect.timeoutOrElse({
    duration: 15_000,
    orElse: () => Effect.fail(failure("Messaging timed out. Check the selected environment and retry.")),
  }));
  if (!input.signal) return request;
  const signal = input.signal;
  const aborted = Effect.callback<never, FactoryMessagingHttpError>((resume) => {
    const onAbort = () => resume(Effect.fail(failure("Messaging request cancelled.")));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return Effect.raceFirst(request, aborted);
};
