import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/http";

import {
  AgentPolicyError,
  AgentPolicyStore,
  type AuthorizeInput,
} from "../../../../../../packages/t3-executor/src/policy-store.js";
import * as ServerConfig from "../config.ts";

/**
 * Perpeto AgentPolicy enforcement for agent-created subagents and threads.
 *
 * The factory executor attaches `{ maxSubagents, allowedSubagentProviders }`
 * to the root thread of an assignment through `/api/perpeto/agent-policies`.
 * The MCP creation paths (`delegate_task`, `create_threads`, `t3_thread_launch`)
 * call `authorize` before dispatching. Threads that no policy governs keep
 * upstream behavior.
 *
 * The store is process-wide so the MCP services need no new layer dependency;
 * the Perpeto HTTP layer opens it for the server's lifetime.
 */
let active: AgentPolicyStore | undefined;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const store = new AgentPolicyStore(path.join(config.stateDir, "perpeto-agent-policy.sqlite"));
        active = store;
        return store;
      }),
      (store) =>
        Effect.sync(() => {
          if (active === store) active = undefined;
          store.close();
        }),
    );
  }),
);

/** Test seam: install a store without the HTTP layer. */
export const setStoreForTesting = (store: AgentPolicyStore | undefined) => {
  active = store;
};

interface ProviderLike {
  readonly instanceId: string;
  readonly driver?: string;
}

export interface CreationRequest extends Omit<AuthorizeInput, "driver"> {
  readonly providers?: ReadonlyArray<ProviderLike>;
}

const toInput = ({ providers, ...request }: CreationRequest): AuthorizeInput => ({
  ...request,
  driver:
    providers?.find((provider) => provider.instanceId === request.providerInstanceId)?.driver ??
    null,
});

/** Refuses a creation the governing policy does not allow; fails closed on store errors. */
export const authorize = (request: CreationRequest) =>
  Effect.gen(function* () {
    const store = active;
    if (store === undefined) return;
    const decision = yield* Effect.try({
      try: () => store.authorize(toInput(request)),
      catch: () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Unable to check this agent's subagent policy; nothing was created.",
        }),
    });
    if (!decision.allowed) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `${decision.reason} Nothing was created.`,
      });
    }
  });

class PolicyStoreError extends Data.TaggedError("PerpetoAgentPolicyStoreError")<{
  readonly cause: unknown;
}> {}

const quietly = (operation: (store: AgentPolicyStore) => unknown, message: string) =>
  Effect.suspend(() => {
    const store = active;
    if (store === undefined) return Effect.void;
    return Effect.try({
      try: () => operation(store),
      catch: (cause) => new PolicyStoreError({ cause }),
    }).pipe(
      Effect.asVoid,
      Effect.catch((cause) => Effect.logWarning(message, { cause })),
    );
  });

/** Records the created child and links it to the governing policy. */
export const recordCreated = (
  request: CreationRequest,
  child: { readonly childThreadId: string | null; readonly childRef?: string },
) =>
  quietly(
    (store) =>
      store.recordCreated({
        requestKey: request.requestKey,
        callerThreadId: request.callerThreadId,
        rootThreadId: request.rootThreadId ?? null,
        childThreadId: child.childThreadId,
        childRef: child.childRef ?? child.childThreadId,
      }),
    "perpeto agent policy could not record a created child",
  );

/** Returns a reservation whose creation failed. */
export const release = (request: CreationRequest) =>
  quietly(
    (store) =>
      store.release({
        requestKey: request.requestKey,
        callerThreadId: request.callerThreadId,
        rootThreadId: request.rootThreadId ?? null,
      }),
    "perpeto agent policy could not release a failed reservation",
  );

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });
const errorJson = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/**
 * `/api/perpeto/agent-policies/:threadId[/decisions|/native-subagents]`.
 * Caller authentication and scope checks happen in the Perpeto HTTP handler.
 */
export const route = <E, R>(input: {
  readonly segments: ReadonlyArray<string>;
  readonly method: string;
  readonly url: URL;
  readonly body: Effect.Effect<Readonly<Record<string, unknown>>, E, R>;
}): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
  Effect.gen(function* () {
    const store = active;
    if (store === undefined) return errorJson(503, "UNAVAILABLE", "Agent policy store is not open.");
    const [threadId, resource, ...rest] = input.segments;
    if (threadId === undefined || rest.length > 0)
      return errorJson(404, "NOT_FOUND", "Agent policy route not found.");
    const run = (operation: () => unknown) => {
      try {
        return json(200, operation());
      } catch (error) {
        if (error instanceof AgentPolicyError) {
          const status =
            error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
          return errorJson(status, error.code, error.message);
        }
        return errorJson(500, "INTERNAL_ERROR", "Agent policy operation failed.");
      }
    };
    if (resource === undefined && input.method === "PUT") {
      const body = yield* input.body;
      return run(() =>
        store.setPolicy({
          threadId,
          maxSubagents: body.maxSubagents,
          allowedSubagentProviders: body.allowedSubagentProviders,
        }),
      );
    }
    if (resource === undefined && input.method === "GET") {
      return run(() => {
        const policy = store.getPolicy(threadId);
        if (policy === null) throw new AgentPolicyError("NOT_FOUND", "No policy governs this thread.");
        return { policy };
      });
    }
    if (resource === "decisions" && input.method === "GET") {
      const after = input.url.searchParams.get("after");
      const limit = input.url.searchParams.get("limit");
      if ((after !== null && !/^\d+$/.test(after)) || (limit !== null && !/^\d+$/.test(limit)))
        return errorJson(400, "INVALID_INPUT", "after and limit must be integers.");
      return run(() =>
        store.decisions({
          threadId,
          ...(after === null ? {} : { after: Number(after) }),
          ...(limit === null ? {} : { limit: Number(limit) }),
        }),
      );
    }
    // Provider-native subagents start inside the harness, where T3 cannot
    // refuse them. The executor reports each one here so it draws from the
    // same budget, and interrupts the run when the decision is a refusal.
    if (resource === "native-subagents" && input.method === "POST") {
      const body = yield* input.body;
      const text = (name: string) => {
        const value = body[name];
        return typeof value === "string" ? value : null;
      };
      return run(() => {
        const subagentId = text("subagentId");
        const callerThreadId = text("callerThreadId") ?? threadId;
        if (subagentId === null)
          throw new AgentPolicyError("INVALID_INPUT", "subagentId must be a string.");
        return store.authorize({
          requestKey: `native:${subagentId}`,
          callerThreadId,
          rootThreadId: threadId,
          kind: "provider_native",
          providerInstanceId: text("providerInstanceId"),
          driver: text("driver"),
          model: text("model"),
          childRef: subagentId,
        });
      });
    }
    return errorJson(404, "NOT_FOUND", "Agent policy route not found.");
  });
