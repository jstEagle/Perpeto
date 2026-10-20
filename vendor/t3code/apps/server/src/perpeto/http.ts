import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { MessagingError } from "../../../../../../packages/factory-transport/src/storage.js";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Messaging from "./Messaging.ts";

export const MAX_BODY_BYTES = 512 * 1024;
export class ApiError extends Data.TaggedError("PerpetoMessagingApiError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}
const apiError = (status: number, code: string, message: string) => new ApiError({ status, code, message });
const errorResponse = (error: ApiError) => HttpServerResponse.jsonUnsafe(
  { error: { code: error.code, message: error.message } }, { status: error.status },
);
const storage = <A>(operation: () => A) => Effect.try({
  try: operation,
  catch: (error) => error instanceof ApiError ? error : error instanceof MessagingError
    ? apiError(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, error.code, error.message)
    : apiError(500, "INTERNAL_ERROR", "Messaging operation failed."),
});
function field(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string") throw apiError(400, "INVALID_INPUT", `${name} must be a string.`);
  return value;
}
const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return yield* Effect.fail(apiError(413, "BODY_TOO_LARGE", "Request body exceeds the messaging limit."));
  }
  // Node's MaxBodySize arrayBuffer reader destroys the socket at its limit.
  // Keep at most the accepted bytes, drain excess chunks, and return a JSON 413.
  const chunks: Uint8Array[] = [];
  let size = 0;
  let oversized = false;
  yield* Stream.runForEach(request.stream, (chunk) => Effect.sync(() => {
    if (oversized) return;
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) { oversized = true; chunks.length = 0; }
    else chunks.push(chunk);
  })).pipe(Effect.mapError(() => apiError(400, "INVALID_INPUT", "Request body is unreadable.")));
  if (oversized) return yield* Effect.fail(apiError(413, "BODY_TOO_LARGE", "Request body exceeds the messaging limit."));
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => apiError(400, "INVALID_INPUT", "Request body must be valid UTF-8."),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(text).pipe(
    Effect.mapError(() => apiError(400, "INVALID_INPUT", "Request body must be a JSON object.")),
  );
});

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const messages = yield* Messaging.FactoryMessaging;
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.mapError((error) =>
      EnvironmentAuth.isServerAuthCredentialError(error)
        ? apiError(401, "UNAUTHORIZED", "A valid environment session is required.")
        : apiError(500, "INTERNAL_ERROR", "Authentication failed."),
    ));
    const scope = request.method === "GET" ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
    if (!session.scopes.includes(scope)) return yield* Effect.fail(apiError(403, "FORBIDDEN", `Required scope: ${scope}.`));
    const url = new URL(request.url, "http://perpeto.local");
    const parts = yield* Effect.try({
      try: () => url.pathname.split("/").filter(Boolean).map(decodeURIComponent),
      catch: () => apiError(400, "INVALID_INPUT", "Malformed path."),
    });
    const projectId = parts[3];
    if (parts[2] !== "projects" || !projectId) return yield* Effect.fail(apiError(404, "NOT_FOUND", "Messaging route not found."));
    if (parts.length === 4 && request.method === "PUT") {
      const input = yield* body;
      return HttpServerResponse.jsonUnsafe(yield* storage(() => messages.createProject({ id: projectId, name: field(input, "name") })));
    }
    if (parts.length === 5 && parts[4] === "channels") {
      if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ channels: yield* storage(() => messages.listChannels({ projectId })) });
      if (request.method === "POST") {
        const input = yield* body;
        return HttpServerResponse.jsonUnsafe(yield* storage(() => messages.createChannel({ projectId, id: field(input, "id"), name: field(input, "name") })));
      }
    }
    const channelId = parts[5];
    if (parts.length === 7 && parts[4] === "channels" && channelId && parts[6] === "messages") {
      if (request.method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return yield* Effect.fail(apiError(400, "INVALID_INPUT", "limit must be an integer."));
        const rawLatest = url.searchParams.get("latest");
        if (rawLatest !== null && rawLatest !== "true" && rawLatest !== "false") return yield* Effect.fail(apiError(400, "INVALID_INPUT", "latest must be true or false."));
        return HttpServerResponse.jsonUnsafe(yield* storage(() => messages.readMessages({
          projectId, channelId, after: url.searchParams.get("after"), before: url.searchParams.get("before"), latest: rawLatest === "true",
          recipientRoleId: url.searchParams.get("recipientRoleId"),
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        })));
      }
      if (request.method === "POST") {
        const input = yield* body;
        return HttpServerResponse.jsonUnsafe(yield* storage(() => messages.send({
          projectId, channelId, senderRoleId: field(input, "senderRoleId"), body: field(input, "body"), idempotencyKey: field(input, "idempotencyKey"),
          ...(input.recipientRoleId === undefined ? {} : { recipientRoleId: input.recipientRoleId === null ? null : field(input, "recipientRoleId") }),
        })));
      }
    }
    return yield* Effect.fail(apiError(404, "NOT_FOUND", "Messaging route not found."));
  }).pipe(Effect.catchTag("PerpetoMessagingApiError", (error) => Effect.succeed(errorResponse(error))));
  yield* router.add("*", "/api/perpeto/*", handler);
}));

export { body as readJsonBody };
