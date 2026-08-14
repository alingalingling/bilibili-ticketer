// dsh-bilibili-ticket 插件入口。
// 职责：宿主平面（host plane）启动一次抢票/蹲回流引擎，注册模型工具，注入系统提示词。
// 引擎是进程级单例；工具注册进全局 tool registry，对所有 agent 预设可见。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createEngine } from "./engine.js";
import { registerRpc } from "./rpc.js";
import { loadState, resolveDataDir, saveState } from "./state.js";
import { isTruthy } from "./util.js";

/** 插件名（loader 诊断用）。 */
export const name = "bilibili-ticket";

/** 依赖的宿主服务：工具注册表 + 系统提示词注册表。二者在 dsh-base 中始终存在。 */
export const inject = ["tools", "systemPrompt"];

/** 配置默认值（未在 row 中覆盖时使用）。 */
const DEFAULTS = {
  enabled: true,
  dataDir: null,           // null -> resolveDataDir()
  pollIntervalMs: 3000,
  stormLeadMs: 2000,
  stormIntervalMs: 150,
  orderTimeoutMs: 60000
};

function resolveConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  return {
    enabled: isTruthy(c.enabled ?? DEFAULTS.enabled),
    dataDir: resolveDataDir(c.dataDir ?? DEFAULTS.dataDir),
    pollIntervalMs: Number(c.pollIntervalMs ?? DEFAULTS.pollIntervalMs),
    stormLeadMs: Number(c.stormLeadMs ?? DEFAULTS.stormLeadMs),
    stormIntervalMs: Number(c.stormIntervalMs ?? DEFAULTS.stormIntervalMs),
    orderTimeoutMs: Number(c.orderTimeoutMs ?? DEFAULTS.orderTimeoutMs)
  };
}

// ---------------------------------------------------------------------------
// 结果格式化辅助
// ---------------------------------------------------------------------------

function renderText(args, value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function presentGeneric(args) {
  return { card: "generic", title: String(args?.keyword ?? args?.projectId ?? args?.name ?? "会员购"), kind: "bili-ticket" };
}

function formatLogin(value) {
  const lines = [`登录${value.ok ? "成功" : "失败"}`];
  if (value.ok) {
    if (value.uid) lines.push(`UID: ${value.uid}`);
    if (value.userName) lines.push(`昵称: ${value.userName}`);
  } else {
    lines.push(`原因: ${value.error ?? "未知"}`);
  }
  return lines.join("\n");
}

function formatSearch(value) {
  if (!value.items?.length) return "未找到匹配的会员购项目。";
  const lines = [`共 ${value.items.length} 个项目：`];
  for (const item of value.items) lines.push(`- [${item.projectId}] ${item.title}${item.price ? ` · ${item.price}` : ""}${item.saleTime ? ` · ${item.saleTime}` : ""}`);
  return lines.join("\n");
}

function formatDetail(value) {
  const lines = [`项目: ${value.title} (${value.projectId})`];
  if (value.tickets?.length) {
    lines.push("票档：");
    for (const t of value.tickets) {
      const stock = t.stock == null ? "库存未知" : t.stock > 0 ? `有票(${t.stock})` : "售罄";
      lines.push(`- [${t.skuId}] ${t.name} · ${t.price ? `${t.price}元` : "价格未知"} · ${stock}`);
    }
  } else {
    lines.push("（未解析到票档，可能是场次需要进一步指定）");
  }
  return lines.join("\n");
}

function formatBuyers(value) {
  if (!value.buyers?.length) return "当前账号暂无购票人，请先在会员购 App 中实名并添加购票人。";
  const lines = ["购票人："];
  for (const b of value.buyers) lines.push(`- [${b.id}] ${b.name} · ${b.maskedIdNo}${b.maskedPhone ? ` · ${b.maskedPhone}` : ""}`);
  return lines.join("\n");
}

function formatTasks(value) {
  if (!value.tasks?.length) return "当前没有任务。";
  const lines = [];
  for (const t of value.tasks) {
    lines.push(`- [${t.id}] ${t.name} · 类型=${t.type === "grab" ? "抢票" : "蹲回流"} · 状态=${t.status}${t.lastError ? ` · 最近错误: ${t.lastError}` : ""}`);
  }
  return lines.join("\n");
}

function formatStatus(value) {
  const lines = [];
  lines.push(`登录态: ${value.loggedIn ? "已登录" : "未登录"}`);
  lines.push(`运行中任务: ${value.runningTaskIds?.length ? value.runningTaskIds.join(", ") : "无"}`);
  if (value.tasks?.length) {
    lines.push("任务：");
    for (const t of value.tasks) lines.push(`- [${t.id}] ${t.name} · ${t.status}`);
  }
  if (value.captcha) lines.push(`⚠️ 需要人工验证码: ${value.captcha}`);
  if (value.recentLogs?.length) {
    lines.push("最近日志：");
    for (const log of value.recentLogs.slice(-8)) lines.push(`- [${new Date(log.ts).toLocaleTimeString("zh-CN", { hour12: false })}] ${log.msg}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 工具定义与注册
// ---------------------------------------------------------------------------

function registerTools(ctx, engine) {
  // 登录 / 校验
  ctx.tools.register(defineTool({
    name: "bili_ticket_login",
    description: "导入 B 站会员购 Cookie 并校验登录态。Cookie 需包含 SESSDATA 与 bili_jct（csrf）。",
    parameters: {
      cookie: { type: "string", required: true, description: "完整 Cookie 头字符串（SESSDATA=...; bili_jct=...; ...）" }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          userName: { type: "string" },
          uid: { type: "string" },
          error: { type: "string" }
        }
      },
      render: (_a, value) => renderText(_a, formatLogin(value))
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) { return engine.login(args.cookie); },
    presentCall: () => ({ card: "generic", title: "会员购登录", kind: "bili-login" })
  }));

  // 扫码登录（推荐）
  ctx.tools.register(defineTool({
    name: "bili_ticket_login_qr",
    description: "扫码登录会员购（推荐，无需手动复制 Cookie）。生成一张二维码图片文件并返回其路径，用户双击打开该图片用手机 B 站 App 的「扫一扫」扫描并确认后，插件在后台自动完成登录。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          qrcodeKey: { type: "string" },
          url: { type: "string" },
          filePath: { type: "string" },
          expiresIn: { type: "integer" },
          error: { type: "string" }
        }
      },
      render: (_a, value) => {
        if (!value.ok) return renderText(_a, `扫码登录发起失败: ${value.error ?? "未知"}`);
        const parts = ["已生成登录二维码（约 3 分钟有效）。"];
        if (value.filePath) {
          parts.push(`请让用户双击打开下面的二维码图片文件，然后用手机 B 站 App「扫一扫」扫描，并在手机上点「确认登录」：\n\`${value.filePath}\`\n（如果打不开，可以把路径复制到文件资源管理器地址栏回车）`);
        } else if (value.url) {
          parts.push(`二维码图片生成失败。可退而求其次让用户点此链接在浏览器打开后扫码（扫完手机上确认即可，忽略电脑端页面后续变化）：${value.url}`);
        }
        parts.push("\n用户扫码并在手机上「确认登录」后，插件会自动完成登录；稍后可用 bili_ticket_status 查看登录态。");
        return [{ type: "text", text: parts.join("\n") }];
      }
    },
    timeoutMs: 25000,
    isConcurrencySafe: () => false,
    async execute() {
      try { return await engine.loginQr(); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    },
    presentCall: () => ({ card: "generic", title: "扫码登录会员购", kind: "bili-login-qr" })
  }));

  // 搜索
  ctx.tools.register(defineTool({
    name: "bili_ticket_search",
    description: "按关键词搜索 B 站会员购演出/活动项目，返回项目 id 与标题。",
    parameters: {
      keyword: { type: "string", required: true, description: "搜索关键词，如演出名、艺人名" }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          items: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              projectId: { type: "string", required: true },
              title: { type: "string", required: true },
              price: { type: "string" },
              saleTime: { type: "string" }
            }
          } }
        }
      },
      render: (_a, value) => renderText(_a, formatSearch(value))
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) { return engine.search(args.keyword); },
    presentCall: presentGeneric
  }));

  // 详情 / 票档
  ctx.tools.register(defineTool({
    name: "bili_ticket_detail",
    description: "读取会员购项目详情，返回票档（sku）、价格与库存。返回库存会同时用于蹲回流判断。",
    parameters: {
      projectId: { type: "string", required: true, description: "项目 id（来自 bili_ticket_search）" },
      screenId: { type: "string", description: "场次 id（可选，多场次项目需指定）" }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          projectId: { type: "string", required: true },
          title: { type: "string", required: true },
          tickets: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              skuId: { type: "string", required: true },
              name: { type: "string", required: true },
              price: { type: "number" },
              stock: { type: "integer" },
              screenId: { type: "string" }
            }
          } }
        }
      },
      render: (_a, value) => renderText(_a, formatDetail(value))
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) { return engine.detail(args.projectId, args.screenId); },
    presentCall: presentGeneric
  }));

  // 购票人
  ctx.tools.register(defineTool({
    name: "bili_ticket_buyers",
    description: "列出当前账号的实名购票人（身份信息已打码），返回可用的购票人 id。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          buyers: { type: "array", required: true, items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", required: true },
              name: { type: "string", required: true },
              maskedIdNo: { type: "string" },
              maskedPhone: { type: "string" }
            }
          } }
        }
      },
      render: (_a, value) => renderText(_a, formatBuyers(value))
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute() { return engine.buyers(); },
    presentCall: () => ({ card: "generic", title: "读取购票人", kind: "bili-buyers" })
  }));

  // 创建任务
  ctx.tools.register(defineTool({
    name: "bili_ticket_task_create",
    description: "创建抢票或蹲回流任务。type=grab 为开售时刻抢票（可设 scheduleAt）；type=monitor 为蹲回流（轮询库存，回流即下单）。",
    parameters: {
      name: { type: "string", required: true, description: "任务名称（便于识别）" },
      type: { type: "string", required: true, enum: ["grab", "monitor"], description: "grab=抢票；monitor=蹲回流" },
      projectId: { type: "string", required: true, description: "项目 id" },
      screenId: { type: "string", description: "场次 id（可选）" },
      skuIds: { type: "array", required: true, items: { type: "string" }, description: "目标票档 sku id 列表（按优先级排序）" },
      num: { type: "integer", required: true, description: "购买数量（1-6，通常单人最多 2）" },
      buyerIds: { type: "array", items: { type: "string" }, description: "购票人 id 列表，数量应等于 num" },
      scheduleAt: { type: "string", description: "开售时间（ISO 字符串，如 2026-08-01T12:00:00+08:00），grab 类型可用" },
      pollIntervalMs: { type: "integer", description: "按任务覆盖：蹲回流轮询间隔（毫秒），缺省用全局配置" },
      stormIntervalMs: { type: "integer", description: "按任务覆盖：抢票高频下单间隔（毫秒），缺省用全局配置" },
      stormLeadMs: { type: "integer", description: "按任务覆盖：开售提前量（毫秒），缺省用全局配置" },
      orderTimeoutMs: { type: "integer", description: "按任务覆盖：下单总超时（毫秒），缺省用全局配置" }
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          taskId: { type: "string", required: true },
          error: { type: "string" }
        }
      },
      render: (_a, value) => renderText(_a, value.error ? `创建失败: ${value.error}` : `任务已创建: ${value.taskId}`)
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return engine.createTask({
        name: args.name,
        type: args.type,
        projectId: args.projectId,
        screenId: args.screenId,
        skuIds: args.skuIds,
        num: args.num,
        buyerIds: args.buyerIds ?? [],
        scheduleAt: args.scheduleAt,
        pollIntervalMs: args.pollIntervalMs,
        stormIntervalMs: args.stormIntervalMs,
        stormLeadMs: args.stormLeadMs,
        orderTimeoutMs: args.orderTimeoutMs
      });
    },
    presentCall: (args) => ({ card: "generic", title: `创建任务 ${args.name}`, kind: "bili-task" })
  }));

  // 任务列表
  ctx.tools.register(defineTool({
    name: "bili_ticket_tasks",
    description: "列出所有任务及其状态。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          tasks: { type: "array", required: true, items: { type: "json" } }
        }
      },
      render: (_a, value) => renderText(_a, formatTasks(value))
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute() { return engine.listTasks(); },
    presentCall: () => ({ card: "generic", title: "任务列表", kind: "bili-tasks" })
  }));

  const taskIdTool = (name2, desc, fn) => ctx.tools.register(defineTool({
    name: name2,
    description: desc,
    parameters: { taskId: { type: "string", required: true, description: "任务 id" } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, error: { type: "string" } } },
      render: (_a, value) => renderText(_a, value.error ? `操作失败: ${value.error}` : "操作成功")
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    async execute(args) { return fn(args.taskId); },
    presentCall: (args) => ({ card: "generic", title: `${name2} ${args.taskId}`, kind: "bili-task" })
  }));

  taskIdTool("bili_ticket_task_start", "启动一个抢票/蹲回流任务。", (id) => engine.startTask(id));
  taskIdTool("bili_ticket_task_stop", "停止一个运行中的任务。", (id) => engine.stopTask(id));
  taskIdTool("bili_ticket_task_delete", "删除一个任务（运行中会先停止）。", (id) => engine.deleteTask(id));

  // 状态
  ctx.tools.register(defineTool({
    name: "bili_ticket_status",
    description: "查看引擎状态：登录态、运行中任务、任务列表、最近日志、待处理验证码。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          loggedIn: { type: "boolean", required: true },
          uid: { type: "string" },
          userName: { type: "string" },
          runningTaskIds: { type: "array", required: true, items: { type: "string" } },
          tasks: { type: "array", required: true, items: { type: "json" } },
          captcha: { type: "string" },
          recentLogs: { type: "array", required: true, items: { type: "json" } }
        }
      },
      render: (_a, value) => renderText(_a, formatStatus(value))
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute() { return engine.status(); },
    presentCall: () => ({ card: "generic", title: "引擎状态", kind: "bili-status" })
  }));
}

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

function registerGuidance(ctx) {
  ctx.systemPrompt.section({
    name: "tool:bili_ticket",
    order: 120,
    text: "Use the bili_ticket_* tools to help the user grab B 站会员购 tickets and monitor for re-releases (回流). Prefer bili_ticket_login_qr (QR login) for sign-in — it returns a QR-image file path the user opens and scans, no manual cookie copying; fall back to bili_ticket_login only if the user pastes a cookie. Workflow: log in, find the project with bili_ticket_search, inspect 票档 with bili_ticket_detail, list buyers with bili_ticket_buyers, then create a task with bili_ticket_task_create (grab=抢票, monitor=蹲回流) and start it with bili_ticket_task_start. The engine then runs in the background; report progress from bili_ticket_status. Remind the user of account-risk and ToS implications, and never attempt to bypass captchas automatically."
  });
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  const state = loadState(cfg.dataDir);
  const persist = () => saveState(cfg.dataDir, state);

  const engine = createEngine({
    state,
    persist,
    config: cfg,
    log: (level, msg) => {
      state.logs.push({ ts: Date.now(), level, msg });
      if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
    }
  });

  registerTools(ctx, engine);
  registerGuidance(ctx);
  registerRpc(ctx, engine);

  // 引擎生命周期：dispose 时停止所有后台轮询器与定时器。
  ctx.effect(() => {
    engine.start();
    return () => engine.dispose();
  });
}
