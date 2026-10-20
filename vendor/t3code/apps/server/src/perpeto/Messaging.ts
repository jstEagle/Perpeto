import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { MessagingStore } from "../../../../../../packages/factory-transport/src/storage.js";
import * as ServerConfig from "../config.ts";

/** Environment-owned local state; every HTTP caller is authorized separately. */
export class FactoryMessaging extends Context.Service<FactoryMessaging, MessagingStore>()(
  "t3/perpeto/Messaging/FactoryMessaging",
) {}

export const layer = Layer.effect(
  FactoryMessaging,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    return yield* Effect.acquireRelease(
      Effect.sync(() => new MessagingStore(path.join(config.stateDir, "perpeto-messaging.sqlite"))),
      (store) => Effect.sync(() => store.close()),
    );
  }),
);
