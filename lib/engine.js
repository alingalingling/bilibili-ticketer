// 抢票 + 蹲回流引擎：进程级单例，管理任务、后台轮询与下单调度。
// 设计要点（综合调研）：
//   - 毫秒级抢票/轮询在 Node 进程内后台执行，不受 AI 逐条工具调用延迟影响；
//   - 蹲回流 = 低频轮询库存，命中即下单；抢票 = 开售卡点 + 高频下单风暴；
//   - 串行 + 随机抖动 + 有限重试，避免机关枪式高频触发风控；
//   - 遇验证码/风控时暂停任务并上报，由人处理，不内置破解。

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "./client.js";
import { qrToPngBuffer } from "./qr.js";
import { buildCookieString, maskIdNo, maskPhone, newTaskId, parseCookie, sleep, jitter, nowMs, errText } from "./util.js";

export function createEngine({ state, persist, config, log }) {
  // 合并持久化的运行时可调参数覆盖（state.tunable 覆盖 cordis 默认配置）。
  config = { ...config, ...(state.tunable && typeof state.tunable === "object" ? state.tunable : {}) };
  const client = createClient({ getCookie: () => state.cookie, log });
  const running = new Set();   // 正在执行的任务 id
  let disposed = false;
  let buyerCache = [];         // 完整购票人（含实名，仅存内存，不落盘）
  let pendingQr = null;        // 进行中的扫码登录 { qrcodeKey, deadline, timer }
  let fetchingName = false;    // 懒补昵称的进行中标记

  const info = (msg) => log?.("info", msg);
  const warn = (msg) => log?.("warn", msg);

  // 可调参数白名单（运行时实时生效，可持久化到 state.tunable）。
  const TUNABLE_KEYS = ["pollIntervalMs", "stormLeadMs", "stormIntervalMs", "orderTimeoutMs"];

  /** 取某任务的频率参数：任务级覆盖 > 全局配置。 */
  function taskParam(t, key) {
    const v = t?.[key];
    return v === undefined || v === null ? config[key] : v;
  }

  /** 从选项对象里挑出合法的可调参数（忽略缺失/非法项）。 */
  function pickTunable(opts) {
    const out = {};
    for (const k of TUNABLE_KEYS) {
      const v = opts?.[k];
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
    }
    return out;
  }

  function projectTask(t) {
    return {
      id: t.id,
      name: t.name,
      type: t.type,
      status: t.status,
      attemptCount: t.attemptCount ?? 0,
      projectId: t.projectId,
      skuIds: t.skuIds,
      num: t.num,
      createdAt: t.createdAt,
      ...(t.lastError != null ? { lastError: t.lastError } : {}),
      ...(t.orderId != null ? { orderId: t.orderId } : {}),
      ...(t.screenId != null ? { screenId: t.screenId } : {}),
      ...(t.scheduleAt != null ? { scheduleAt: t.scheduleAt } : {}),
      ...(t.pollIntervalMs != null ? { pollIntervalMs: t.pollIntervalMs } : {}),
      ...(t.stormIntervalMs != null ? { stormIntervalMs: t.stormIntervalMs } : {}),
      ...(t.stormLeadMs != null ? { stormLeadMs: t.stormLeadMs } : {}),
      ...(t.orderTimeoutMs != null ? { orderTimeoutMs: t.orderTimeoutMs } : {})
    };
  }

  function assertLogin() {
    if (!state.cookie?.sessdata) throw new Error("尚未登录会员购，请先用 bili_ticket_login_qr 扫码登录");
  }

  // -------------------------------------------------------------------------
  // 对外能力
  // -------------------------------------------------------------------------

  async function login(rawCookie) {
    const parsed = parseCookie(rawCookie);
    if (!parsed.sessdata) return { ok: false, error: "Cookie 缺少 SESSDATA" };
    if (!parsed.csrf) return { ok: false, error: "Cookie 缺少 bili_jct(csrf)" };
    const prev = state.cookie;
    state.cookie = parsed;
    const check = await client.checkLogin();
    if (!check.ok) {
      state.cookie = prev;
      persist();
      return { ok: false, error: check.error };
    }
    info(`登录成功 uid=${check.uid}`);
    if (check.userName != null) state.cookie.userName = check.userName;
    // 登录后预热设备指纹与风控令牌（非阻塞，失败不致命）。
    client.fetchBuvid().catch(() => {});
    client.genBiliTicket().catch(() => {});
    persist();
    return {
      ok: true,
      ...(check.uid != null ? { uid: String(check.uid) } : {}),
      ...(check.userName != null ? { userName: check.userName } : {})
    };
  }

  /**
   * 扫码登录：生成二维码 + 后台轮询扫码结果。
   * 二维码被写成一张 PNG 文件（写到 dataDir），工具层把「文件路径」作为纯文本返回，
   * 用户双击打开该图片用手机扫码，避免经过模型图片通道。
   * 用户扫码并确认后，引擎后台轮询，成功后自动写入登录态并刷新 buvid/bili_ticket。
   */
  async function loginQr() {
    const { qrcodeKey, url } = await client.generateQr();
    let filePath = null;
    try {
      const png = await qrToPngBuffer(url);
      mkdirSync(config.dataDir, { recursive: true });
      filePath = resolve(config.dataDir, "bili-login-qr.png");
      writeFileSync(filePath, png);
    } catch (error) {
      warn(`二维码图片写入失败: ${errText(error)}`);
    }
    if (pendingQr?.timer) clearTimeout(pendingQr.timer);
    pendingQr = { qrcodeKey, deadline: nowMs() + 180000, timer: null };
    info("已生成登录二维码，请扫码");
    pollQrLoop(qrcodeKey);
    return { ok: true, qrcodeKey, url, expiresIn: 180, ...(filePath ? { filePath } : {}) };
  }

  async function pollQrLoop(qrcodeKey) {
    if (disposed || !pendingQr || pendingQr.qrcodeKey !== qrcodeKey) return;
    try {
      const r = await client.pollQr(qrcodeKey);
      if (r.state === "success" && r.cookie?.sessdata && r.cookie?.csrf) {
        // 登录成功：构建完整 cookie（附设备指纹与风控票据）。
        const buvid = await client.fetchBuvid().catch(() => null);
        const ticket = await client.genBiliTicket().catch(() => null);
        const raw = buildCookieString({
          sessdata: r.cookie.sessdata,
          csrf: r.cookie.csrf,
          dedeuserid: r.cookie.dedeuserid,
          buvid3: buvid?.b3,
          buvid4: buvid?.b4,
          biliTicket: ticket
        });
        state.cookie = { raw, sessdata: r.cookie.sessdata, csrf: r.cookie.csrf, dedeuserid: r.cookie.dedeuserid, buvid3: buvid?.b3 ?? null };
        const nav = await client.checkLogin().catch(() => null);
        if (nav?.userName != null) state.cookie.userName = nav.userName;
        info(`扫码登录成功 uid=${r.cookie.dedeuserid}`);
        pendingQr = null;
        persist();
        return;
      }
      if (r.state === "success") {
        // 扫码已成功但没解析到关键 cookie（理论不该发生，兜底便于排查）。
        warn(`扫码成功但未解析到 SESSDATA/bili_jct：${JSON.stringify(r.cookie ?? null)}`);
      }
      if (r.state === "expired") {
        warn("登录二维码已过期，请重新发起扫码");
        pendingQr = null;
        return;
      }
      if (r.state === "scanned") info("已扫码，请在手机上确认登录");
    } catch (error) {
      warn(`扫码轮询异常: ${errText(error)}`);
    }
    // 继续轮询
    if (pendingQr && nowMs() < pendingQr.deadline) {
      pendingQr.timer = setTimeout(() => pollQrLoop(qrcodeKey), 1000);
    } else if (pendingQr) {
      warn("扫码登录超时，请重新发起");
      pendingQr = null;
    }
  }

  async function search(keyword) {
    assertLogin();
    return client.search(keyword);
  }

  async function detail(projectId, screenId) {
    assertLogin();
    const raw = await client.getProjectDetail(projectId, screenId);
    return {
      projectId: raw.projectId,
      title: raw.title,
      tickets: raw.tickets.map((t) => ({
        skuId: t.skuId,
        name: t.name,
        ...(t.price != null ? { price: t.price } : {}),
        ...(t.stock != null ? { stock: t.stock } : {}),
        ...(t.screenId != null ? { screenId: t.screenId } : {})
      }))
    };
  }

  async function buyers() {
    assertLogin();
    const result = await client.getBuyers();
    buyerCache = result.buyers; // 完整信息仅内存缓存，用于下单组装
    return {
      buyers: result.buyers.map((b) => ({
        id: b.id,
        name: b.name,
        maskedIdNo: b.personalId ? maskIdNo(b.personalId) : "未填身份证",
        ...(b.tel ? { maskedPhone: maskPhone(b.tel) } : {})
      }))
    };
  }

  function createTask(opts) {
    assertLogin();
    if (!opts.projectId) return { error: "缺少 projectId" };
    if (!opts.skuIds?.length) return { error: "缺少 skuIds" };
    const num = Number(opts.num);
    if (!Number.isInteger(num) || num < 1 || num > 6) return { error: "购买数量须为 1-6 的整数" };
    const type = opts.type === "monitor" ? "monitor" : "grab";
    const id = newTaskId();
    const task = {
      id,
      name: opts.name || (type === "monitor" ? "蹲回流" : "抢票"),
      type,
      status: "idle",
      attemptCount: 0,
      lastError: null,
      orderId: null,
      projectId: String(opts.projectId),
      screenId: opts.screenId ? String(opts.screenId) : null,
      skuIds: opts.skuIds.map(String),
      num,
      buyerIds: (opts.buyerIds ?? []).map(String),
      scheduleAt: opts.scheduleAt || null,
      ...pickTunable(opts),   // 按任务覆盖频率参数（缺省走全局配置）
      createdAt: Date.now()
    };
    state.tasks[id] = task;
    persist();
    info(`任务已创建 ${task.name} (${id}, ${type})`);
    return { taskId: id };
  }

  function listTasks() {
    return { tasks: Object.values(state.tasks).map(projectTask) };
  }

  async function startTask(id) {
    const t = state.tasks[id];
    if (!t) return { ok: false, error: "任务不存在" };
    if (running.has(id)) return { ok: true };
    if (t.status === "success") return { ok: false, error: "任务已成功，请勿重复启动" };
    t.status = "running";
    t.lastError = null;
    running.add(id);
    persist();
    info(`任务启动 ${t.name} (${id})`);
    runTask(t).finally(() => {
      running.delete(id);
      persist();
    });
    return { ok: true };
  }

  async function stopTask(id) {
    const t = state.tasks[id];
    if (!t) return { ok: false, error: "任务不存在" };
    if (running.has(id)) {
      running.delete(id);
      t.status = "stopped";
      info(`任务停止 ${t.name} (${id})`);
    } else if (t.status === "needs_captcha" || t.status === "failed") {
      t.status = "stopped";
    }
    persist();
    return { ok: true };
  }

  function deleteTask(id) {
    if (running.has(id)) running.delete(id);
    delete state.tasks[id];
    persist();
    info(`任务删除 (${id})`);
    return { ok: true };
  }

  function status() {
    // 懒补昵称：已登录但还没缓存昵称时，异步拉一次（面板下次轮询即能看到）。
    if (state.cookie?.sessdata && !state.cookie?.userName && !fetchingName) {
      fetchingName = true;
      client.checkLogin().then((c) => {
        if (c.ok && c.userName != null) { state.cookie.userName = c.userName; persist(); }
      }).catch(() => {}).finally(() => { fetchingName = false; });
    }
    return {
      loggedIn: Boolean(state.cookie?.sessdata),
      uid: state.cookie?.dedeuserid ?? null,
      userName: state.cookie?.userName ?? null,
      runningTaskIds: [...running],
      tasks: Object.values(state.tasks).map(projectTask),
      recentLogs: state.logs.slice(-30),
      ...(state.captcha != null ? { captcha: state.captcha } : {})
    };
  }

  // -------------------------------------------------------------------------
  // 执行循环
  // -------------------------------------------------------------------------

  async function runTask(t) {
    if (t.type === "monitor") return runMonitor(t);
    return runGrab(t);
  }

  /** 抢票：卡点进入高频下单风暴。 */
  async function runGrab(t) {
    if (t.scheduleAt) {
      const at = Date.parse(t.scheduleAt);
      if (!Number.isNaN(at)) {
        const wait = at - taskParam(t, "stormLeadMs") - nowMs();
        if (wait > 0) {
          t.status = "waiting";
          persist();
          info(`任务 ${t.name} 等待开售，${Math.round(wait / 1000)}s 后进入抢票`);
          await sleep(wait);
          if (disposed || !running.has(t.id)) return;
        }
      } else {
        warn(`任务 ${t.name} 的 scheduleAt 无法解析，忽略`);
      }
    }
    t.status = "running";
    persist();
    const deadline = nowMs() + taskParam(t, "orderTimeoutMs");
    while (!disposed && running.has(t.id) && nowMs() < deadline) {
      const result = await attemptOrder(t);
      if (result.ok) {
        t.status = "success";
        t.orderId = result.orderId ?? null;
        info(`任务 ${t.name} 抢票成功，订单号 ${t.orderId ?? "未知"}（请在 10-15 分钟内完成支付）`);
        persist();
        return;
      }
      if (result.needsCaptcha) {
        t.status = "needs_captcha";
        t.lastError = result.error;
        state.captcha = `任务「${t.name}」在下单时触发验证码/风控，请人工处理后重新启动任务`;
        warn(`任务 ${t.name} 需要人工处理验证码`);
        persist();
        return;
      }
      t.attemptCount++;
      t.lastError = result.error;
      persist();
      const si = taskParam(t, "stormIntervalMs");
      await sleep(jitter(si, Math.max(50, Math.floor(si / 2))));
    }
    if (!disposed && running.has(t.id)) {
      t.status = "failed";
      t.lastError = t.lastError || "抢票超时";
      warn(`任务 ${t.name} 失败: ${t.lastError}`);
      persist();
    }
  }

  /** 蹲回流：轮询库存，命中即下单，直到成功或被停止。 */
  async function runMonitor(t) {
    info(`任务 ${t.name} 开始蹲回流（轮询间隔 ${taskParam(t, "pollIntervalMs")}ms）`);
    while (!disposed && running.has(t.id)) {
      try {
        const result = await attemptOrder(t);
        if (result.ok) {
          t.status = "success";
          t.orderId = result.orderId ?? null;
          info(`任务 ${t.name} 蹲到回流并下单成功，订单号 ${t.orderId ?? "未知"}`);
          persist();
          return;
        }
        if (result.needsCaptcha) {
          t.status = "needs_captcha";
          t.lastError = result.error;
          state.captcha = `任务「${t.name}」下单触发验证码/风控，请人工处理后重新启动任务`;
          warn(`任务 ${t.name} 需要人工处理验证码`);
          persist();
          return;
        }
        if (result.hit) {
          // 有票但下单未成功（可能被抢/参数问题），继续快速重试，不进入长轮询等待。
          t.attemptCount++;
          t.lastError = result.error;
          persist();
          const si = taskParam(t, "stormIntervalMs");
          await sleep(jitter(si, Math.max(50, Math.floor(si / 2))));
        } else {
          // 无票，按轮询间隔等待。
          const pi = taskParam(t, "pollIntervalMs");
          await sleep(jitter(pi, Math.floor(pi / 3)));
        }
      } catch (error) {
        t.lastError = errText(error);
        t.attemptCount++;
        persist();
        const pi = taskParam(t, "pollIntervalMs");
        await sleep(jitter(pi, Math.floor(pi / 3)));
      }
    }
    if (!disposed && running.has(t.id)) {
      t.status = "stopped";
      persist();
    }
  }

  /** 单次下单尝试：先探测库存/票档，命中则下单。 */
  async function attemptOrder(t) {
    const detail = await client.getProjectDetail(t.projectId, t.screenId);
    const sku = pickSku(detail.tickets, t.skuIds);
    if (!sku) return { ok: false, hit: false, error: "目标票档不存在或不可售" };

    // 精确库存探测（蹲回流核心）：stock/check 返回 hasStock=false 时判定无票。
    const screenId = t.screenId ?? sku.screenId;
    const stock = await client.checkStock({ projectId: t.projectId, screenId, skuId: sku.skuId });
    if (stock.ok && stock.hasStock === false) return { ok: false, hit: false, error: "无票" };

    // 解析购票人：优先内存缓存；缺失时现取。
    if ((t.buyerIds ?? []).length && buyerCache.length === 0) {
      try { buyerCache = (await client.getBuyers()).buyers; } catch { buyerCache = []; }
    }
    const buyers = (t.buyerIds ?? []).map((id) => buyerCache.find((b) => b.id === id)).filter(Boolean);

    const result = await client.createOrder({
      projectId: t.projectId,
      screenId,
      skuId: sku.skuId,
      num: t.num,
      buyers,
      priceFen: sku.priceFen
    });
    return { ...result, hit: true };
  }

  /** 按 skuIds 优先级挑选一个可买票档。 */
  function pickSku(tickets, skuIds) {
    for (const id of skuIds) {
      const t = tickets.find((x) => x.skuId === id);
      if (t && (t.stock == null || t.stock > 0)) return t;
    }
    return tickets.find((x) => x.stock == null || x.stock > 0) ?? null;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  function start() {
    // 不自动恢复上次任务（避免重启后误触发下单）；任务状态保留供用户查看后手动启动。
  }

  function dispose() {
    disposed = true;
    running.clear();
    if (pendingQr?.timer) clearTimeout(pendingQr.timer);
    pendingQr = null;
  }

  // -------------------------------------------------------------------------
  // 运行时参数调整（实时生效，并持久化到 state.tunable，重启后仍生效）
  // -------------------------------------------------------------------------
  function getConfig() {
    return {
      pollIntervalMs: config.pollIntervalMs,
      stormLeadMs: config.stormLeadMs,
      stormIntervalMs: config.stormIntervalMs,
      orderTimeoutMs: config.orderTimeoutMs
    };
  }

  function updateConfig(partial) {
    if (!partial || typeof partial !== "object") return { ok: false, error: "参数无效" };
    const next = {};
    for (const k of TUNABLE_KEYS) {
      if (partial[k] === undefined || partial[k] === null || partial[k] === "") continue;
      const v = Number(partial[k]);
      if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${k} 需为非负数字` };
      next[k] = Math.round(v);
    }
    Object.assign(config, next);
    state.tunable = { ...(state.tunable ?? {}), ...next };
    persist();
    info(`参数已更新 ${JSON.stringify(getConfig())}`);
    return { ok: true, config: getConfig() };
  }

  return {
    login, loginQr, search, detail, buyers,
    createTask, listTasks, startTask, stopTask, deleteTask, status,
    getConfig, updateConfig,
    start, dispose
  };
}
