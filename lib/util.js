// 通用工具：睡眠、随机抖动、时间、Cookie 解析、身份证号打码等。
// 抢票关键路径上避免引入任何外部依赖，全部用 Node 内置能力。

/** 异步睡眠。 */
export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 在 base 基础上加 [0, spread] 毫秒随机抖动，用于降低请求规律性、缓解风控。 */
export function jitter(base, spread = 0) {
  return base + (spread <= 0 ? 0 : Math.floor(Math.random() * (spread + 1)));
}

/** 当前毫秒时间戳。 */
export function nowMs() {
  return Date.now();
}

/** ISO 时间字符串。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 将任意值安全转成可读字符串（用于日志）。 */
export function errText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && typeof error.message === "string") return error.message;
  return String(error);
}

/** 生成短随机任务 ID。 */
export function newTaskId() {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 解析 Cookie 字符串，提取会员购下单所需的几个关键字段。
 * 返回 { raw, sessdata, csrf, dedeuserid, buvid3 }，缺失字段为 null。
 */
export function parseCookie(raw) {
  const out = { raw: String(raw ?? "").trim(), sessdata: null, csrf: null, dedeuserid: null, buvid3: null };
  if (!out.raw) return out;
  const pairs = out.raw.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    switch (key) {
      case "SESSDATA": out.sessdata = value; break;
      case "bili_jct": out.csrf = value; break;
      case "DedeUserID": out.dedeuserid = value; break;
      case "buvid3": out.buvid3 = value; break;
      default: break;
    }
  }
  return out;
}

/** 把解析后的 cookie 重新拼成请求头 Cookie 值（只保留关键字段，其余原样透传）。 */
export function cookieHeader(cookie) {
  if (!cookie) return "";
  return cookie.raw || "";
}

/**
 * 从扫码登录成功后的 Set-Cookie 响应头数组解析关键 cookie 字段。
 * 每个 Set-Cookie 头只含一个 cookie，取第一个 ";" 前的 name=value；值保持原样不二次解码。
 * 解析不到关键字段时返回 null（由调用方回退到 data.url 解析）。
 */
export function parseSetCookies(setCookies) {
  if (!Array.isArray(setCookies) || setCookies.length === 0) return null;
  const out = { sessdata: null, csrf: null, dedeuserid: null };
  let hit = false;
  for (const header of setCookies) {
    const firstPair = String(header).split(";")[0];
    const eq = firstPair.indexOf("=");
    if (eq < 0) continue;
    const key = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    switch (key) {
      case "SESSDATA": out.sessdata = value; hit = true; break;
      case "bili_jct": out.csrf = value; hit = true; break;
      case "DedeUserID": out.dedeuserid = value; hit = true; break;
      default: break;
    }
  }
  return hit ? out : null;
}

/** 从 B 站扫码登录成功后的 crossDomain URL 解析关键 cookie 字段（值保持原样，不二次解码）。 */
export function parseQrCookie(url) {
  const out = { sessdata: null, csrf: null, dedeuserid: null };
  if (!url) return out;
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return out;
  const params = new URLSearchParams(url.slice(qIdx + 1));
  out.sessdata = params.get("SESSDATA");
  out.csrf = params.get("bili_jct");
  out.dedeuserid = params.get("DedeUserID");
  return out;
}

/** 由 cookie 字段拼成完整 Cookie 头字符串（跳过空值）。 */
export function buildCookieString(parts) {
  const map = [
    ["SESSDATA", parts.sessdata],
    ["bili_jct", parts.csrf],
    ["DedeUserID", parts.dedeuserid],
    ["buvid3", parts.buvid3],
    ["buvid4", parts.buvid4],
    ["b_nut", parts.bnut],
    ["bili_ticket", parts.biliTicket]
  ];
  return map.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 身份证号打码：保留前 3 后 2，中间用 * 替换。 */
export function maskIdNo(idNo) {
  const s = String(idNo ?? "");
  if (s.length <= 6) return s;
  return `${s.slice(0, 3)}${"*".repeat(Math.max(s.length - 5, 0))}${s.slice(-2)}`;
}

/** 手机号打码。 */
export function maskPhone(phone) {
  const s = String(phone ?? "");
  if (s.length < 7) return s;
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/** 判断值是否为真（处理 "false"/0 等字符串形式）。 */
export function isTruthy(value) {
  if (typeof value === "string") return value.toLowerCase() !== "false" && value !== "0";
  return Boolean(value);
}

/** 从毫秒时间戳格式化一个本地时间字符串。 */
export function fmtTs(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}
