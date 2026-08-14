// 会员购 HTTP 客户端：登录态、设备指纹、风控票据、WBI key，以及会员购查询/下单接口。
// 只依赖 Node 内置 fetch（Node 18+）与 node:crypto。
// 接口分「旧版 show.bilibili.com/api/ticket/* (errno 风格)」与「2025 新版 (code 风格)」，
// 本文件尽量兼容两代，并对易变处标注 ⚠️/🔬（需实测）。

import { createHmac } from "node:crypto";
import { cookieHeader, errText, jitter, parseQrCookie, parseSetCookies } from "./util.js";
import { signWbi } from "./wbi.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** 创建客户端。getCookie 返回解析后的 cookie（见 util.parseCookie）。 */
export function createClient({ getCookie, log }) {
  const state = {
    wbiKeys: null,
    biliTicket: null,
    buvid: null
  };
  const info = (msg) => log?.("info", msg);
  const warn = (msg) => log?.("warn", msg);

  // -------------------------------------------------------------------------
  // 基础请求
  // -------------------------------------------------------------------------

  async function request(url, { method = "GET", params, body, headers = {}, referer, origin, retries = 2 } = {}) {
    let target = url;
    if (params && Object.keys(params).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      target = `${url}${url.includes("?") ? "&" : "?"}${qs.toString()}`;
    }
    const cookie = getCookie();
    const baseHeaders = {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json, text/plain, */*",
      ...cookie ? { Cookie: cookieHeader(cookie) } : {},
      ...headers
    };
    if (referer) baseHeaders.Referer = referer;
    if (origin) baseHeaders.Origin = origin;

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const init = { method, headers: baseHeaders };
        if (body !== undefined) {
          const isForm = body instanceof URLSearchParams;
          init.body = isForm ? body.toString() : JSON.stringify(body);
          baseHeaders["Content-Type"] = isForm ? "application/x-www-form-urlencoded" : "application/json";
        }
        const res = await fetch(target, init);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        if (!res.ok) {
          const e = new Error(`HTTP ${res.status}${json?.msg || json?.message ? `: ${json?.msg ?? json?.message}` : ""}`);
          e.status = res.status;
          e.json = json;
          throw e;
        }
        // 捕获 Set-Cookie（扫码登录成功时 B 站主要靠响应头下发 SESSDATA/bili_jct）。
        let setCookies = [];
        try {
          setCookies = res.headers.getSetCookie?.() ?? [];
          if (!setCookies.length) {
            const one = res.headers.get("set-cookie");
            if (one) setCookies = [one];
          }
        } catch { /* 某些环境 headers 只读或缺少 getSetCookie，忽略 */ }
        return { status: res.status, json, text, setCookies };
      } catch (error) {
        lastError = error;
        // 4xx 客户端错误（登录失效/风控/参数错误）不盲目重试。
        if (error?.status >= 400 && error?.status < 500) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, jitter(300, 300)));
      }
    }
    throw lastError;
  }

  // -------------------------------------------------------------------------
  // 登录态 / WBI / 指纹 / 风控票据
  // -------------------------------------------------------------------------

  async function fetchNav() {
    const { json } = await request("https://api.bilibili.com/x/web-interface/nav", {
      referer: "https://www.bilibili.com/"
    });
    const data = json?.data ?? {};
    const img = data.wbi_img?.img_url;
    const sub = data.wbi_img?.sub_url;
    if (img && sub) {
      const imgKey = String(img).split("/").pop().split(".")[0];
      const subKey = String(sub).split("/").pop().split(".")[0];
      state.wbiKeys = { imgKey, subKey, ts: Date.now() };
    }
    return { isLogin: data.isLogin === true, mid: data.mid, uname: data.uname };
  }

  async function getWbiKeys() {
    if (state.wbiKeys && Date.now() - state.wbiKeys.ts < 24 * 3600 * 1000) return state.wbiKeys;
    await fetchNav();
    return state.wbiKeys;
  }

  async function checkLogin() {
    try {
      const nav = await fetchNav();
      if (!nav.isLogin) return { ok: false, error: "未登录或 SESSDATA 失效" };
      return { ok: true, uid: nav.mid != null ? String(nav.mid) : null, userName: nav.uname };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  async function fetchBuvid() {
    try {
      const { json } = await request("https://api.bilibili.com/x/frontend/finger/spi", {
        referer: "https://www.bilibili.com/"
      });
      const b3 = json?.data?.b_3;
      const b4 = json?.data?.b_4;
      if (b3) state.buvid = { b3, b4: b4 ?? null };
      return state.buvid;
    } catch (error) {
      warn(`获取 buvid 失败: ${errText(error)}`);
      return state.buvid;
    }
  }

  async function genBiliTicket() {
    if (state.biliTicket && Date.now() - state.biliTicket.ts < 2.5 * 24 * 3600 * 1000) return state.biliTicket.ticket;
    try {
      const ts = Math.round(Date.now() / 1000);
      const hexsign = createHmac("sha256", "XgwSnGZ1p").update(`ts${ts}`).digest("hex");
      const { json } = await request("https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket", {
        method: "POST",
        referer: "https://www.bilibili.com/",
        params: { key_id: "ec02", hexsign, "context[ts]": ts, csrf: getCookie()?.csrf ?? "" }
      });
      const ticket = json?.data?.ticket;
      if (ticket) { state.biliTicket = { ticket, ts: Date.now() }; return ticket; }
      warn("生成 bili_ticket 未返回 ticket");
      return null;
    } catch (error) {
      warn(`生成 bili_ticket 失败: ${errText(error)}`);
      return null;
    }
  }

  /** 对通用 api.bilibili.com 查询接口做 WBI 签名（会员购主流程一般不需要）。 */
  async function signedGet(url, params, { referer = "https://www.bilibili.com/" } = {}) {
    const keys = await getWbiKeys();
    if (!keys) return request(url, { params, referer });
    const signed = signWbi(params, keys.imgKey, keys.subKey);
    const out = {};
    for (const pair of signed.split("&")) {
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    }
    return request(url, { params: out, referer });
  }

  // -------------------------------------------------------------------------
  // 会员购业务接口
  // -------------------------------------------------------------------------

  /** 搜索演出/活动（正确端点 search/list，keyword 真实生效）。 */
  async function search(keyword) {
    const kw = String(keyword ?? "").trim();
    const { json } = await request("https://show.bilibili.com/api/ticket/search/list", {
      params: { version: 134, keyword: kw, page: 1, pagesize: 20, platform: "web" },
      referer: `https://show.bilibili.com/platform/search.html?searchValue=${encodeURIComponent(kw)}`
    });
    const list = json?.data?.result ?? [];
    return {
      items: list.map((it) => {
        const low = it.price_low != null ? Number(it.price_low) : null;
        const high = it.price_high != null ? Number(it.price_high) : null;
        return {
          projectId: String(it.id ?? it.ticket_id ?? ""),
          title: it.title ?? it.project_name ?? "",
          ...(it.city ? { city: it.city } : {}),
          ...(it.venue_name ? { venue: it.venue_name } : {}),
          ...(low != null ? { price: high != null && high !== low ? `${low / 100}~${high / 100}元` : `${low / 100}元` } : {}),
          ...(it.tlabel ? { saleTime: String(it.tlabel) } : {})
        };
      }).filter((it) => it.projectId)
    };
  }

  /** 项目详情：兼容 getV2（camelCase）与 get（snake_case）。价格单位「分」。 */
  async function getProjectDetail(projectId, screenId) {
    let json;
    try {
      ({ json } = await request("https://show.bilibili.com/api/ticket/project/getV2", {
        params: { version: 134, id: projectId, requestSource: "neul-next" },
        referer: "https://show.bilibili.com/"
      }));
    } catch {
      ({ json } = await request("https://show.bilibili.com/api/ticket/project/get", {
        params: { version: 134, id: projectId, project_id: projectId },
        referer: "https://show.bilibili.com/"
      }));
    }
    const data = json?.data ?? {};
    const title = data.name ?? data.project_name ?? data.projectName ?? String(projectId);
    const bsTime = data.bsTime ?? data.bs_time ?? undefined;
    const screens = (data.screenList ?? data.screen_list ?? []).map((s) => ({
      screenId: String(s.id ?? ""),
      name: s.name ?? "",
      tickets: (s.ticketList ?? s.ticket_list ?? []).map(parseTicket)
    }));

    const tickets = screens.flatMap((s) => s.tickets.map((t) => ({ ...t, screenId: t.screenId ?? s.screenId })));

    return {
      projectId,
      title,
      bsTime,
      screens,
      tickets: screenId ? tickets.filter((t) => !t.screenId || t.screenId === screenId) : tickets
    };
  }

  function parseTicket(t) {
    const raw = t.price ?? t.price_fen ?? t.priceInCent;
    return {
      skuId: String(t.id ?? t.sku_id ?? t.skuId ?? ""),
      name: t.desc ?? t.name ?? t.ticket_name ?? "",
      price: raw != null ? Number(raw) / 100 : undefined,
      priceFen: raw != null ? Number(raw) : undefined,
      saleFlag: t.sale_flag ?? t.saleFlag ?? undefined,
      stock: undefined, // 精确库存走 stock/check
      screenId: t.screen_id != null || t.screenId != null ? String(t.screen_id ?? t.screenId) : undefined
    };
  }

  /** 票档库存检查（2025 新版，蹲回流轻量轮询端点）。🔬 字段以实测为准。 */
  async function checkStock({ projectId, screenId, skuId }) {
    try {
      const { json } = await request("https://show.bilibili.com/api/ticket/stock/check", {
        method: "POST",
        body: { projectId: String(projectId), screenId: String(screenId ?? ""), skuId: Number(skuId) },
        referer: "https://show.bilibili.com/",
        origin: "https://show.bilibili.com",
        retries: 0
      });
      const hasStock = json?.data?.hasStock === true;
      return { ok: true, hasStock };
    } catch (error) {
      // 旧版可能无此端点：返回未知，交由详情 sale_flag 兜底。
      return { ok: false, hasStock: null, error: errText(error) };
    }
  }

  /** 购票人列表（nomask=1 取完整字段，用于下单组装；⚠️ 完整实名信息仅存内存，不落盘）。 */
  async function getBuyers() {
    const { json } = await request("https://show.bilibili.com/api/ticket/buyer/list", {
      params: { nomask: 1 },
      referer: "https://show.bilibili.com/"
    });
    const list = json?.data?.list ?? json?.data?.buyers ?? [];
    return {
      buyers: list.map((b) => ({
        id: String(b.id ?? b.buyer_id ?? ""),
        name: b.name ?? "",
        tel: b.tel ?? b.phone ?? "",
        personalId: b.personal_id ?? b.id_no ?? b.identity ?? "",
        idType: b.id_type ?? undefined
      })).filter((b) => b.id)
    };
  }

  /**
   * 下单预检 / 取令牌（旧版核心）。返回 { token } 或 { needsCaptcha, riskParams }。
   * ⚠️ 2025 新版可能退化，token 可由本地计算兜底。
   */
  async function prepareOrder({ projectId, screenId, skuId, count }) {
    const cookie = getCookie();
    const form = new URLSearchParams();
    form.set("count", String(count));
    form.set("order_type", "1");
    form.set("project_id", String(projectId));
    if (screenId) form.set("screen_id", String(screenId));
    form.set("sku_id", String(skuId));
    form.set("token", "");
    form.set("newRisk", "true");
    form.set("csrf", cookie?.csrf ?? "");
    try {
      const { json } = await request(`https://show.bilibili.com/api/ticket/order/prepare?project_id=${projectId}`, {
        method: "POST",
        body: form,
        referer: "https://show.bilibili.com/",
        origin: "https://show.bilibili.com",
        retries: 0
      });
      const errno = json?.errno ?? json?.code ?? 0;
      if (errno === 0) return { ok: true, token: json?.data?.token ?? null };
      if (errno === -401 || (json?.data?.ga_data?.riskParams)) {
        return { ok: false, needsCaptcha: true, riskParams: json?.data?.ga_data?.riskParams, error: "触发验证码" };
      }
      return { ok: false, error: json?.msg ?? json?.message ?? `prepare 失败 code=${errno}` };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  /** 整数转大端字节。 */
  function intToBytesBE(n, len) {
    const out = new Uint8Array(len);
    let v = BigInt(Math.trunc(Number(n)));
    for (let i = len - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  /**
   * 本地确定性下单令牌（2025 第三方逆向，⚠️ 易变、需实测）。
   * 结构：0xC0 头 + ts(4) + project_id(4) + screen_id(4) + order_type(1) + count(2) + sku_id(4)，
   * 再用自定义 base64（+/→-_，=→.）。
   */
  function computeLocalToken({ projectId, screenId, orderType, count, skuId }) {
    const ts = Math.round(Date.now() / 1000);
    const parts = [
      new Uint8Array([0xc0]),
      intToBytesBE(ts, 4),
      intToBytesBE(projectId, 4),
      intToBytesBE(screenId ?? 0, 4),
      intToBytesBE(orderType ?? 1, 1),
      intToBytesBE(count, 2),
      intToBytesBE(skuId, 4)
    ];
    const buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
  }

  /** 创建订单（两代共用 createV2）。buyer 传完整购票人对象数组（来自 getBuyers）。 */
  async function createOrder({ projectId, screenId, skuId, num, buyers, priceFen }) {
    const cookie = getCookie();
    if (!cookie?.csrf) return { ok: false, error: "缺少 bili_jct(csrf)，请重新导入 Cookie" };

    // 1) 令牌：优先 prepare（服务端签发），失败则本地计算兜底。
    let token = null;
    const prep = await prepareOrder({ projectId, screenId, skuId, count: num });
    if (prep.ok) token = prep.token;
    if (prep.needsCaptcha) return { ok: false, needsCaptcha: true, error: prep.error, riskParams: prep.riskParams };
    if (!token) token = computeLocalToken({ projectId, screenId, orderType: 1, count: num, skuId });

    // 2) 组装 createV2 JSON。
    const body = {
      project_id: String(projectId),
      screen_id: String(screenId ?? ""),
      sku_id: String(skuId),
      count: num,
      order_type: 1,
      timestamp: Date.now(),
      token,
      deviceId: (await fetchBuvid())?.b3 ?? "",
      pay_money: priceFen != null ? Math.round(priceFen) * num : 0,
      requestSource: "neul-next",
      again: 0,
      clickPosition: { x: Math.floor(Math.random() * 400), y: Math.floor(Math.random() * 600), origin: Date.now(), now: Date.now() }
    };
    if (buyers?.length) {
      // 实名项目：提交购票人（提交时敏感字段按平台要求脱敏）。
      body.id_bind = 1;
      body.buyer_info = JSON.stringify(buyers.map((b) => ({
        id: b.id,
        name: b.name,
        tel: maskTel(b.tel),
        personal_id: maskId(b.personalId),
        id_type: b.idType ?? 1
      })));
    } else {
      body.id_bind = 0;
    }

    try {
      const { json } = await request(`https://show.bilibili.com/api/ticket/order/createV2?project_id=${projectId}`, {
        method: "POST",
        body,
        referer: "https://show.bilibili.com/",
        origin: "https://show.bilibili.com",
        retries: 0
      });
      const code = json?.errno ?? json?.code ?? 0;
      const orderId = json?.data?.orderId ?? json?.data?.order_id ?? json?.data?.orderIdStr;
      if (code === 0) return { ok: true, orderId: orderId != null ? String(orderId) : undefined, raw: json };
      if (String(code) === "-352" || String(code) === "-401" || (json?.data && typeof json.data === "object" && json.data.v_voucher)) {
        return { ok: false, needsCaptcha: true, error: json?.msg ?? "触发风控/验证码", code, raw: json };
      }
      return { ok: false, error: json?.msg ?? json?.message ?? `下单失败 code=${code}`, code, raw: json };
    } catch (error) {
      return { ok: false, error: errText(error), code: error?.status };
    }
  }

  /** 订单状态确认（createstatus，二次确认锁票、防“假票”）。 */
  async function getOrderStatus({ orderId, projectId, token }) {
    try {
      const { json } = await request("https://show.bilibili.com/api/ticket/order/createstatus", {
        params: { orderId: String(orderId), project_id: String(projectId), token: token ?? "" },
        referer: "https://show.bilibili.com/"
      });
      return { ok: true, data: json?.data ?? null, code: json?.code ?? json?.errno ?? 0 };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  }

  // -------------------------------------------------------------------------
  // 扫码登录
  // -------------------------------------------------------------------------

  /** 生成登录二维码，返回 { qrcodeKey, url }。url 打开即可看到二维码。 */
  async function generateQr() {
    const { json } = await request("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", {
      referer: "https://passport.bilibili.com/login"
    });
    const data = json?.data ?? {};
    if (json?.code !== 0 || !data.qrcode_key) throw new Error(json?.message ?? "生成登录二维码失败");
    return { qrcodeKey: data.qrcode_key, url: data.url };
  }

  /**
   * 轮询扫码结果。
   * 返回 { state, cookie }：state ∈ waiting(86101)/scanned(86090)/expired(86038)/success。
   * success 时 cookie 为 { sessdata, csrf, dedeuserid }（值保持原样）。
   */
  async function pollQr(qrcodeKey) {
    const { json, setCookies } = await request("https://passport.bilibili.com/x/passport-login/web/qrcode/poll", {
      params: { qrcode_key: qrcodeKey },
      referer: "https://passport.bilibili.com/login"
    });
    const data = json?.data ?? {};
    const inner = data.code;
    if (inner === 0) {
      // 优先从 Set-Cookie 响应头解析（当前 B 站扫码成功主要靠响应头下发），
      // data.url(crossDomain) 作为兜底。
      const cookie = parseSetCookies(setCookies) ?? parseQrCookie(data.url);
      return { state: "success", cookie };
    }
    if (inner === 86090) return { state: "scanned" };
    if (inner === 86038) return { state: "expired" };
    return { state: "waiting", message: data.message ?? "" };
  }

  // 脱敏工具（下单提交用；与展示层 maskIdNo/maskPhone 略有差异，按平台格式）。
  function maskTel(tel) {
    const s = String(tel ?? "");
    if (s.length < 7) return s;
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
  }
  function maskId(idNo) {
    const s = String(idNo ?? "");
    if (s.length < 8) return s;
    return `${s.slice(0, 4)}${"*".repeat(s.length - 5)}${s.slice(-1)}`;
  }

  return {
    checkLogin, search, getProjectDetail, checkStock, getBuyers,
    prepareOrder, createOrder, getOrderStatus,
    generateQr, pollQr,
    fetchBuvid, genBiliTicket, signedGet,
    _debug: () => ({ ...state })
  };
}
