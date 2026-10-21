import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { RunnerQueue } from "../../../../../../packages/factory-runner/src/queue.js";
import * as ServerConfig from "../config.ts";

export class FactoryRunner extends Context.Service<FactoryRunner, RunnerQueue>()("t3/perpeto/Runner/FactoryRunner") {}
export const layer = Layer.effect(FactoryRunner, Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(config.stateDir, {recursive:true});
  return yield* Effect.acquireRelease(
    Effect.sync(() => new RunnerQueue(path.join(config.stateDir,"perpeto-runner.sqlite"))),
    queue => Effect.sync(() => queue.close()),
  );
}));
