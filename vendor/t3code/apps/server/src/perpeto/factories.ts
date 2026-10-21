import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { FactoryStore, FactoryError, type Definition } from "../../../../../../packages/factory-definition/src/storage.js";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";

export class FactoryDefinitions extends Context.Service<FactoryDefinitions, FactoryStore>()("t3/perpeto/factories/FactoryDefinitions") {}
export const storageLayer = Layer.effect(FactoryDefinitions, Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  return yield* Effect.acquireRelease(
    Effect.sync(() => new FactoryStore(path.join(config.stateDir, "perpeto-factories.sqlite"))),
    (store) => Effect.sync(() => store.close()),
  );
}));

export const MAX_BODY_BYTES = 512 * 1024;
export class ApiError extends Data.TaggedError("PerpetoFactoryApiError")<{
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
  catch: (error) => error instanceof ApiError ? error : error instanceof FactoryError
    ? apiError(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, error.code, error.message)
    : apiError(500, "INTERNAL_ERROR", "Factory operation failed."),
});
const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return yield* Effect.fail(apiError(413, "BODY_TOO_LARGE", "Request body exceeds the factory limit."));
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
  if (oversized) return yield* Effect.fail(apiError(413, "BODY_TOO_LARGE", "Request body exceeds the factory limit."));
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
  const factories = yield* FactoryDefinitions;
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
    const projectId = parts[4]; const id = parts[5];
    if (parts[2] !== "factories" || parts[3] !== "projects" || !projectId) return yield* Effect.fail(apiError(404, "NOT_FOUND", "Factory route not found."));
    if (parts.length === 5) {
      if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ factories: yield* storage(() => factories.list({ projectId })) });
      if (request.method === "POST") {
        const input = yield* body;
        return HttpServerResponse.jsonUnsafe(yield* storage(() => {
          if (typeof input.id !== "string") throw apiError(400, "INVALID_INPUT", "id must be a string.");
          const { id, ...definition } = input;
          return factories.create({ ...definition as unknown as Definition, id, projectId });
        }), { status: 201 });
      }
    }
    if (parts.length === 6 && id) {
      if (request.method === "GET") {
        const version = url.searchParams.get("version");
        if (version !== null && !/^[1-9]\d*$/.test(version)) return yield* Effect.fail(apiError(400, "INVALID_INPUT", "version must be a positive integer."));
        return HttpServerResponse.jsonUnsafe(yield* storage(() => factories.read({ projectId, id, ...(version === null ? {} : { version: Number(version) }) })));
      }
      if (request.method === "PUT") {
        const input = yield* body;
        return HttpServerResponse.jsonUnsafe(yield* storage(() => {
          const { expectedVersion, ...definition } = input;
          if (typeof expectedVersion !== "number") throw apiError(400, "INVALID_INPUT", "expectedVersion must be a number.");
          return factories.update({ ...definition as unknown as Definition, projectId, id, expectedVersion });
        }));
      }
    }
    return yield* Effect.fail(apiError(404, "NOT_FOUND", "Factory route not found."));
  }).pipe(Effect.catchTag("PerpetoFactoryApiError", (error) => Effect.succeed(errorResponse(error))));
  yield* router.add("*", "/api/perpeto/factories/*", handler);
}));
