// B 站 WBI 签名。
// 算法参考 SocialSisterYi/bilibili-API-collect 的逆向文档（社区权威资料）：
//   1. img_key + sub_key 从 x/web-interface/nav 返回的 wbi_img.img_url/sub_url 取文件名；
//   2. 拼接后按固定 64 位重排表 MIXIN_KEY_ENC_TAB 重排，取前 32 位得 mixin_key；
//   3. 参数按 key 升序、过滤 value 中 !'()* 字符、追加 wts 时间戳后拼成 query；
//   4. w_rid = MD5(query + mixin_key)。
// 注意：img_key/sub_key 每日更替，需缓存并刷新；编码细节（大写十六进制、空格 %20）需以实测为准。

import { createHash } from "node:crypto";

/** B 站固定的 WBI mixin key 重排表（64 位）。 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/** 小写十六进制 MD5。 */
export function md5(text) {
  return createHash("md5").update(text).digest("hex");
}

/** 由 img_key + sub_key 计算 mixin_key。 */
export function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

/** 过滤参数 value 中 WBI 算法要求剔除的字符。 */
function filterValue(value) {
  return String(value).replace(/[!'()*]/g, "");
}

/** URL 编码（大写十六进制、空格为 %20）。 */
function enc(value) {
  return encodeURIComponent(value);
}

/**
 * 对参数集合做 WBI 签名，返回可直接拼到 URL 后的 query 串（含 wts 与 w_rid）。
 * @param {Record<string, string|number>} params 业务参数（不含 wts/w_rid）
 * @param {string} imgKey nav 接口返回的 img_key
 * @param {string} subKey nav 接口返回的 sub_key
 * @returns {string} 形如 `a=1&b=2&wts=...&w_rid=...`
 */
export function signWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.round(Date.now() / 1000);
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((key) => `${enc(key)}=${enc(filterValue(merged[key]))}`)
    .join("&");
  const wRid = md5(`${query}${mixinKey}`);
  return `${query}&w_rid=${wRid}`;
}
