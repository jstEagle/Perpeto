import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { FactoryToolkit } from "../mcp/toolkits/orchestrator/tools.ts";

it.effect(
  "factory credentials list and call only delegation tools on their isolated endpoint",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId: EnvironmentId.make("factory-test"),
          requestNamespace: "factory-test",
          thread: {
            threadId: ThreadId.make("factory"),
            providerSessionId: "factory-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const reached = () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "factory handler reached",
            }),
          );
        const factory = McpHttpServer.toolkitRegistration(
          FactoryToolkit,
          McpToolAccess.toLayer(FactoryToolkit, {
            orchestrator_capabilities: McpToolAccess.reads(reached),
            delegate_task: McpToolAccess.reads(reached),
            task_status: McpToolAccess.reads(reached),
            task_cancel: McpToolAccess.reads(reached),
          }),
        ).pipe(
          Layer.provide(McpHttpServer.layerFactoryMcpTransport),
          Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
          Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
          Layer.fresh,
        );
        const fullToolkit = Toolkit.make(Tool.make("full_probe", { success: Schema.Void }));
        const full = McpHttpServer.toolkitRegistration(
          fullToolkit,
          McpToolAccess.toLayer(fullToolkit, {
            full_probe: McpToolAccess.reads(() => Effect.void),
          }),
        ).pipe(Layer.provide(McpHttpServer.layerMcpTransport));
        const server = Layer.merge(factory, full).pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(
                  token === "factory"
                    ? { ...scope, factoryTools: true }
                    : token === "full"
                      ? scope
                      : undefined,
                ),
            }),
          ),
        );
        yield* HttpRouter.serve(server, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const client = yield* HttpClient.HttpClient;
        const call = (
          path: string,
          token: string,
          method: string,
          params: unknown,
          session?: string,
        ) =>
          client.post(path, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json, text/event-stream",
              ...(session
                ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }
                : {}),
            },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              "application/json",
            ),
          });
        const initialize = {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        };
        const factoryInit = yield* call("/mcp/perpeto", "factory", "initialize", initialize);
        expect(factoryInit.status).toBe(200);
        const factorySession = factoryInit.headers["mcp-session-id"]!;
        const listing = yield* call("/mcp/perpeto", "factory", "tools/list", {}, factorySession);
        const listed = yield* listing.text;
        for (const name of Object.keys(FactoryToolkit.tools))
          expect(listed).toContain(`"name":"${name}"`);
        expect(listed).not.toContain('"name":"full_probe"');
        expect((yield* call("/mcp", "factory", "initialize", initialize)).status).toBe(403);
        expect((yield* call("/mcp/perpeto", "full", "initialize", initialize)).status).toBe(403);
        const allowed = yield* call(
          "/mcp/perpeto",
          "factory",
          "tools/call",
          { name: "orchestrator_capabilities", arguments: {} },
          factorySession,
        );
        expect(yield* allowed.text).toContain("factory handler reached");
        const denied = yield* call(
          "/mcp/perpeto",
          "factory",
          "tools/call",
          { name: "full_probe", arguments: {} },
          factorySession,
        );
        expect(yield* denied.text).toContain("error");
        const fullInit = yield* call("/mcp", "full", "initialize", initialize);
        const fullListing = yield* call(
          "/mcp",
          "full",
          "tools/list",
          {},
          fullInit.headers["mcp-session-id"]!,
        );
        const fullListed = yield* fullListing.text;
        expect(fullListed).toContain('"name":"full_probe"');
        expect(fullListed).not.toContain('"name":"delegate_task"');
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
