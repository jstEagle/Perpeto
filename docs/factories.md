# Factory definitions

A factory definition describes the system you want to build software with. It belongs to a project in a selected execution environment, and each save creates an immutable revision. Definitions currently store configuration; they do not start agents, run checks, enforce harness delegation limits or merge code.

## Build a graph

Open **Factories** in the sidebar and choose the project and environment. Create a factory, add nodes, and select a node to edit its properties. Move nodes by dragging or with arrow keys while a node has focus. The canvas scrolls independently of the properties panel.

| Node | Configuration |
| --- | --- |
| Agent | Harness, optional model, subagent policy and concurrency |
| Context | Document paths or other references, one per line |
| Check | Command as an argument list, one argument per line |
| Merge queue | Required checks and review; serialized changes |

All nine imported harness kinds can be recorded. Selecting a harness or entering a model does not verify that it is installed, authenticated or available. A context reference is stored as text; saving it does not read the referenced file.

Use **Connections** to choose the source, target and relationship. Delegation connects agents and must not form a cycle. Context connections start at a context node and end at a different node type. Workflow connections describe work relationships and may include rework loops. A connection does not dispatch a task or send a message.

## Save and collaborate

**Save** creates the first revision or updates the version you loaded. If another user or agent saves first, the server rejects the stale edit. Your draft should remain available so you can inspect it, explicitly reload the saved version or save a separate copy.

Drafts are temporary editor state. Save before leaving the editor, reloading or closing the app. Saved revisions persist on the selected environment, independently of browser and agent sessions. Environment read permissions allow viewing definitions; operation permissions are required to write them.

The authenticated endpoints and schema are documented in [the definition package](../packages/factory-definition/README.md). The [agent client](../packages/factory-client/README.md) provides CLI and MCP access. A user-owned runner can execute a separately submitted CI job now; saving a check node does not automatically submit that job. See [the runner guide](../packages/factory-runner/README.md).

## Execution work still required

The next runtime layer must connect definitions to durable assignments, actual harness sessions, results, review and merging. Definitions do not yet express a complete scheduler or guarantee native subagent limits. See [current verification](status.md) and [the complete factory criteria](definition-of-done.md).
