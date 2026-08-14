// Host RPC channel for dsh-bilibili-ticket: exposes the抢票 engine to the Web
// client bundle over the Connection transport. The client calls
// `ctx.connection.rpc.call('/bili-ticket', <endpoint>, payload)` and receives
// a JSON `RpcResult` envelope (`{ ok, value }` or `{ ok, error }`).
//
// Endpoints mirror the engine's public methods and return JSON-safe data only
// (no secrets beyond what the model-facing tools already surface).

function ok(value) {
  return { ok: true, value };
}

function err(error) {
  return {
    ok: false,
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      details: {}
    }
  };
}

/** Dispatch one RPC endpoint to the engine. */
async function dispatch(engine, endpoint, payload) {
  switch (endpoint) {
    case "status":
      return engine.status();
    case "config/get":
      return engine.getConfig();
    case "config/set":
      return engine.updateConfig(payload ?? {});
    case "buyers":
      return engine.buyers();
    case "search":
      return engine.search(String(payload.keyword ?? ""));
    case "detail":
      return engine.detail(payload.projectId, payload.screenId);
    case "tasks":
      return engine.listTasks();
    case "task/create":
      return engine.createTask(payload ?? {});
    case "task/start":
      return engine.startTask(payload.taskId);
    case "task/stop":
      return engine.stopTask(payload.taskId);
    case "task/delete":
      engine.deleteTask(payload.taskId);
      return { ok: true };
    case "login-qr":
      return engine.loginQr();
    case "login":
      return engine.login(String(payload.cookie ?? ""));
    default:
      throw new Error(`dsh-bilibili-ticket: unknown RPC endpoint "${endpoint}"`);
  }
}

/**
 * Register the `/bili-ticket` RPC channel. Uses `ctx.inject(["connection"])`
 * (not `ctx.get`) so the channel registers the moment the host connection
 * service mounts, regardless of plugin load order — the same pattern the
 * official api-gateway uses. `authority: "trusted-host"` matches the shipped
 * gateway so loopback Web sessions reach the channel.
 */
export function registerRpc(ctx, engine) {
  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.connection;
    if (!connection || typeof connection.rpc?.handle !== "function") return;
    const dispose = connection.rpc.handle(
      "/bili-ticket",
      async (endpoint, payload) => {
        try {
          const value = await dispatch(engine, endpoint, payload ?? {});
          return ok(value);
        } catch (error) {
          return err(error);
        }
      },
      { authority: "trusted-host" }
    );
    ctx.effect(() => () => {
      dispose();
    });
  });
}
