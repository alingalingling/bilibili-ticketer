// 状态持久化：一个进程级 JSON 状态文件（cookie、任务、购票人缓存、日志环形缓冲）。
// 所有写操作都先落盘再返回，保证插件重启后任务与登录态不丢。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const STATE_VERSION = 1;
export const MAX_LOGS = 200;

/** 新建一个空的默认状态对象（不落盘）。 */
export function createState() {
  return {
    version: STATE_VERSION,
    cookie: null,            // { raw, sessdata, csrf, dedeuserid, buvid3 }
    tasks: {},               // taskId -> task
    buyersCache: [],         // [{ id, name, maskedIdNo }]
    logs: [],                // [{ ts, level, msg }]
    captcha: null,           // 最近一次需要人工处理的验证码提示
    tunable: {}              // 运行时可调参数覆盖（重启后仍生效，覆盖 cordis 默认值）
  };
}

/** 追加一条日志（环形缓冲，最多 MAX_LOGS 条），并返回新状态。 */
export function appendLog(state, level, msg) {
  state.logs.push({ ts: Date.now(), level, msg });
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  return state;
}

/** 展开 ~ 开头的路径；非 ~ 路径原样返回（相对路径保持相对）。 */
export function expandHome(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return process.env.USERPROFILE || process.env.HOME || process.cwd();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return resolve(home, path.slice(2));
  }
  return path;
}

/** 解析数据目录，返回绝对路径。 */
export function resolveDataDir(dataDir) {
  if (dataDir) return expandHome(dataDir);
  const dshHome = process.env.DSH_HOME;
  if (dshHome) return resolve(dshHome, "bilibili-ticket");
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return resolve(home, ".dsh", "bilibili-ticket");
}

/** 状态文件路径。 */
export function stateFile(dataDir) {
  return resolve(dataDir, "state.json");
}

/** 加载状态；文件不存在或损坏时返回新状态。 */
export function loadState(dataDir) {
  const file = stateFile(dataDir);
  if (!existsSync(file)) return createState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.version === STATE_VERSION) {
      // 补齐可能缺失的字段（向前兼容）。
      const state = createState();
      Object.assign(state, parsed);
      return state;
    }
    return createState();
  } catch {
    return createState();
  }
}

/** 原子化保存状态：先写临时文件再 rename。 */
export function saveState(dataDir, state) {
  const file = stateFile(dataDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    // 落盘失败不应让抢票主流程崩溃；由调用方决定是否重试。
    // eslint-disable-next-line no-console
    console.error("[dsh-bilibili-ticket] 状态保存失败:", error?.message ?? String(error));
  }
}
