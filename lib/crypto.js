import { scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'

const ENCRYPTION_KEY = process.env.MULTIUSER_ENCRYPTION_KEY || 'xrk-agt-wechat-bot-key-2025'
const ENCRYPTION_ALGORITHM = 'aes-256-cbc'
const KEY_LENGTH = 32

function getEncryptionKey() {
  return scryptSync(ENCRYPTION_KEY, 'salt', KEY_LENGTH)
}

export function encryptData(text) {
  const key = getEncryptionKey()
  const iv = Buffer.alloc(16, 0)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
  let encrypted = cipher.update(String(text || ''), 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return 'enc:' + encrypted
}

export function decryptData(encryptedHex) {
  if (!encryptedHex) return ''
  
  let data = encryptedHex
  if (data.startsWith('enc:')) {
    data = data.substring(4)
  }
  
  const key = getEncryptionKey()
  const iv = Buffer.alloc(16, 0)
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
  let decrypted = decipher.update(data, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}