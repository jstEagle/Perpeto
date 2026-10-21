import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { afterEach, beforeEach } from "vitest";

import { AgentPolicyStore } from "../../../../../../packages/factory-t3/src/policy-store.js";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as AgentPolicy from "./AgentPolicy.ts";

const parentThreadId = ThreadId.make("thread:policy-parent");
const parentRunId = RunId.make("run:policy-parent");
const parentNodeId = NodeId.make("node:policy-root");
const projectId = ProjectId.make("project:policy");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:policy"),
  requestNamespace: "provider-session:policy",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:policy",
    providerInstanceId: codex,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const provider = (instanceId: ProviderInstanceId, model: string): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const parentProjection = {
  thread: {
    id: parentThreadId,
    projectId,
    title: "Policy parent",
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
  },
  runs: [
    {
      id: parentRunId,
      ordinal: 1,
      status: "running",
      rootNodeId: parentNodeId,
      providerInstanceId: codex,
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
    },
  ],
  contextTransfers: [],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;

const task = (index: number, instanceId: ProviderInstanceId) => ({
  id: NodeId.make(`node:policy-task-${index}`),
  threadId: parentThreadId,
  runId: parentRunId,
  parentNodeId,
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make(instanceId),
  providerInstanceId: instanceId,
  providerThreadId: null,
  childThreadId: ThreadId.make(`thread:policy-child-${index}`),
  nativeTaskRef: null,
  prompt: "Summarize the diff.",
  title: null,
  model: "gpt-5.4",
  status: "running",
  result: null,
  startedAt: null,
  completedAt: null,
});

const childProjection = {
  thread: { id: ThreadId.make("thread:policy-child") },
  runs: [],
  contextTransfers: [],
  messages: [],
  subagents: [],
  providerThreads: [],
  runtimeRequests: [],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;

const serviceLayer = (dispatched: Ref.Ref<number>, failDispatch = false) => {
  const tasks: Array<ReturnType<typeof task>> = [];
  return OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? ({ ...parentProjection, subagents: tasks } as unknown as OrchestrationV2ThreadProjection)
                : childProjection,
            ),
          dispatch: (command) =>
            failDispatch
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId: codex,
                  }),
                )
              : Ref.updateAndGet(dispatched, (count) => count + 1).pipe(
                  Effect.map((count) => {
                    const created = task(
                      count,
                      (command as { modelSelection: { instanceId: ProviderInstanceId } })
                        .modelSelection.instanceId,
                    );
                    tasks.push(created);
                    return {
                        sequence: count,
                        storedEvents: [
                          {
                            sequence: count,
                            commandId: null,
                            event: { type: "subagent.updated", payload: created },
                          },
                        ],
                    } as never;
                  }),
                ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider(codex, "gpt-5.4"), provider(claude, "claude-x")]),
          refreshInstance: () => Effect.succeed([]),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([codex, claude]),
            get: (instanceId) =>
              Effect.succeed({ instanceId } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );
};

const delegate = (clientRequestId: string, instanceId: ProviderInstanceId = codex) =>
  OrchestratorMcpService.OrchestratorMcpService.pipe(
    Effect.flatMap((service) =>
      service.delegateTask(scope, {
        task: "Summarize the diff.",
        target: { providerInstanceId: instanceId },
        mode: "async",
        clientRequestId,
      }),
    ),
  );

describe("Perpeto AgentPolicy enforcement on delegate_task", () => {
  let directory: string;
  let store: AgentPolicyStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "perpeto-agent-policy-"));
    store = new AgentPolicyStore(join(directory, "policy.sqlite"));
    AgentPolicy.setStoreForTesting(store);
  });
  afterEach(() => {
    AgentPolicy.setStoreForTesting(undefined);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.effect("leaves threads without a policy unrestricted", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make(0);
      yield* delegate("free-1").pipe(Effect.provide(serviceLayer(dispatched)));
      assert.equal(yield* Ref.get(dispatched), 1);
    }),
  );

  it.effect("refuses delegation beyond maxSubagents without dispatching", () =>
    Effect.gen(function* () {
      store.setPolicy({ threadId: parentThreadId, maxSubagents: 1, allowedSubagentProviders: ["codex"] });
      const dispatched = yield* Ref.make(0);
      const layer = serviceLayer(dispatched);
      yield* delegate("limit-1").pipe(Effect.provide(layer));
      // A retry of the accepted request does not consume more budget.
      yield* delegate("limit-1").pipe(Effect.provide(layer));
      const error = yield* delegate("limit-2").pipe(Effect.flip, Effect.provide(layer));
      assert.equal(error.code, "capability_denied");
      assert.include(error.message, "at most 1 subagents");
      assert.equal(yield* Ref.get(dispatched), 2);
      assert.equal(store.getPolicy(parentThreadId)?.used, 1);
      const log = store.decisions({ threadId: parentThreadId }).decisions;
      assert.deepEqual(
        log.map((entry) => [entry.outcome, entry.kind, entry.driver]),
        [
          ["created", "delegated_task", "codex"],
          ["refused", "delegated_task", "codex"],
        ],
      );
      // The child thread now draws from the parent's budget.
      assert.equal(store.getPolicy("thread:policy-child-1")?.threadId, parentThreadId);
    }),
  );

  it.effect("refuses providers outside allowedSubagentProviders", () =>
    Effect.gen(function* () {
      store.setPolicy({ threadId: parentThreadId, maxSubagents: 3, allowedSubagentProviders: ["codex"] });
      const dispatched = yield* Ref.make(0);
      const error = yield* delegate("claude-1", claude).pipe(
        Effect.flip,
        Effect.provide(serviceLayer(dispatched)),
      );
      assert.equal(error.code, "capability_denied");
      assert.include(error.message, "claudeAgent");
      assert.equal(yield* Ref.get(dispatched), 0);
    }),
  );

  it.effect("returns the reservation when dispatch fails", () =>
    Effect.gen(function* () {
      store.setPolicy({ threadId: parentThreadId, maxSubagents: 1, allowedSubagentProviders: ["codex"] });
      const dispatched = yield* Ref.make(0);
      yield* delegate("failing-1").pipe(Effect.flip, Effect.provide(serviceLayer(dispatched, true)));
      assert.equal(store.getPolicy(parentThreadId)?.used, 0);
    }),
  );
});
