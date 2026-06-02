/**
 * AES-128-CBC 解密模块（queue-guard package）
 *
 * 输入格式: Base64( IV(16 bytes) + Ciphertext )
 * 填充方式: PKCS7（Node.js crypto 默认）
 * 密钥: XOR 混淆存储，运行时还原（与 Electron 主进程 aes-encrypt.ts 完全一致）
 */

import crypto from 'node:crypto'

// --- AES-128 密钥（XOR 混淆存储，运行时还原，与 aes-encrypt.ts 完全一致） ---
const _m = [0x5a, 0x7c, 0x1f, 0x4e, 0x2d, 0xa3, 0x8b, 0xf1, 0x47, 0x6e, 0x92, 0xd8, 0xb5, 0x53, 0xc6, 0x71]
const _k = [0x6a, 0x1e, 0x7d, 0x7e, 0x15, 0xc7, 0xee, 0xc0, 0x22, 0x08, 0xf1, 0xea, 0x85, 0x6a, 0xf2, 0x48]

function getAesKey(): Buffer {
  return Buffer.from(_k.map((v, i) => v ^ _m[i]!))
}

/**
 * AES-128-CBC 解密
 *
 * @param encrypted Base64(IV + Ciphertext)
 * @returns 明文字符串
 * @throws 解密失败时抛出异常
 */
export function decryptAesCbc(encrypted: string): string {
  const key = getAesKey()
  const buf = Buffer.from(encrypted, 'base64')

  // 前 16 字节是 IV，剩余部分是密文
  const iv = buf.subarray(0, 16)
  const ciphertext = buf.subarray(16)

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return decrypted.toString('utf-8')
}
