// 把文本渲染成二维码，供用户用手机扫码。
// 依赖成熟的 qrcode 库（battle-tested），避免手写 Reed-Solomon 出错。
// 提供两种形态：
//   - qrToPngBuffer: PNG 图片字节（供 DSH 附件服务 saveImage 用，网页里显示成真正的图片）
//   - qrToText: Unicode 半块字符画（终端 / 纯文本兜底）

import QRCode from "qrcode";

/** PNG 图片字节（Buffer / Uint8Array）。width 给足 400 便于扫码。 */
export async function qrToPngBuffer(text) {
  return QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 400,
    color: { dark: "#000000", light: "#ffffff" }
  });
}

/** Unicode 半块字符画二维码（margin 必须为偶数，否则 qrcode 的 utf8 渲染器会报错）。 */
export async function qrToText(text) {
  return QRCode.toString(text, {
    type: "utf8",
    errorCorrectionLevel: "M",
    margin: 2
  });
}
