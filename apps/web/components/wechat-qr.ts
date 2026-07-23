import QRCode from "qrcode";

export function encodeWechatQr(content: string) {
  return QRCode.toDataURL(content, { width: 440, margin: 2, errorCorrectionLevel: "M" });
}
