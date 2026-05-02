import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DEFAULT_PERSONA_FILE } from './config.js'
import { safeWriteFileSync } from './storage.js'
import { decryptData, encryptData } from './crypto.js'

export function getUserDir(userId) {
  return path.join(DATA_DIR, `user-${userId}`)
}

export function ensureUserDir(userId) {
  const userDir = getUserDir(userId)
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true })
  }
  return userDir
}

export function loadUserAccountConfig(userId) {
  const userDir = ensureUserDir(userId)
  const configPath = path.join(userDir, 'config.json')
  if (!fs.existsSync(configPath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw)
    if (config.token && !config.token.startsWith('enc:')) {
      const decrypted = config.token
      config.token = encryptData(decrypted)
      saveUserAccountConfig(userId, config)
    } else if (config.token) {
      try {
        config.token = decryptData(config.token)
      } catch (e) {
        console.warn('[多用户微信机器人] 解密Token失败，使用原始值')
      }
    }
    return config
  } catch (e) {
    console.warn('[多用户微信机器人] 加载用户配置失败', e)
    return null
  }
}

export function saveUserAccountConfig(userId, config) {
  const userDir = ensureUserDir(userId)
  const configPath = path.join(userDir, 'config.json')
  const toSave = { ...config }
  if (toSave.token) {
    toSave.token = encryptData(toSave.token)
  }
  return safeWriteFileSync(configPath, JSON.stringify(toSave, null, 2))
}

export function loadUserPersona(userId) {
  const userDir = ensureUserDir(userId)
  const personaPath = path.join(userDir, 'persona.md')
  if (fs.existsSync(personaPath)) {
    return fs.readFileSync(personaPath, 'utf8')
  }
  if (fs.existsSync(DEFAULT_PERSONA_FILE)) {
    return fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8')
  }
  return '你是一个友好、有趣的微信聊天伙伴，喜欢分享日常，说话自然不生硬。'
}

export function saveUserPersona(userId, persona) {
  const userDir = ensureUserDir(userId)
  const personaPath = path.join(userDir, 'persona.md')
  return safeWriteFileSync(personaPath, persona)
}

export function loadUserChatMemory(userId) {
  const userDir = ensureUserDir(userId)
  const memPath = path.join(userDir, 'chat-memory.json')
  if (!fs.existsSync(memPath)) {
    return []
  }
  try {
    return JSON.parse(fs.readFileSync(memPath, 'utf8'))
  } catch (e) {
    return []
  }
}

export function saveUserChatMemory(userId, memory) {
  const userDir = ensureUserDir(userId)
  const memPath = path.join(userDir, 'chat-memory.json')
  return safeWriteFileSync(memPath, JSON.stringify(memory, null, 2))
}

export function loadUserMemoriesDir(userId) {
  const userDir = ensureUserDir(userId)
  return path.join(userDir, 'memories')
}

export function loadUserAutoMsgConfig(userId) {
  const userDir = ensureUserDir(userId)
  const configPath = path.join(userDir, 'auto-msg-config.json')
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (e) {
      return {}
    }
  }
  return {}
}

export function saveUserAutoMsgConfig(userId, cfg) {
  const userDir = ensureUserDir(userId)
  const configPath = path.join(userDir, 'auto-msg-config.json')
  return safeWriteFileSync(configPath, JSON.stringify(cfg, null, 2))
}

export function loadUserApiConfig(userId) {
  const userDir = ensureUserDir(userId)
  const apiPath = path.join(userDir, 'api-config.json')
  if (!fs.existsSync(apiPath)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(apiPath, 'utf8'))
  } catch (e) {
    return {}
  }
}

export function saveUserApiConfig(userId, cfg) {
  const userDir = ensureUserDir(userId)
  const apiPath = path.join(userDir, 'api-config.json')
  return safeWriteFileSync(apiPath, JSON.stringify(cfg, null, 2))
}

export function getAllAccounts() {
  const accounts = []
  try {
    if (fs.existsSync(DATA_DIR)) {
      const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
      for (const dir of dirs) {
        if (dir.isDirectory() && dir.name.startsWith('user-')) {
          const userId = dir.name.substring('user-'.length)
          const account = loadUserAccountConfig(userId)
          if (account) {
            accounts.push({ userId, ...account })
          }
        }
      }
    }
  } catch (err) {
    console.error('[多用户微信机器人] 读取所有账号失败', err)
  }
  return accounts
}

export function deleteUserDir(userId) {
  const dir = getUserDir(userId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function ensureUserMemoriesDir(userId) {
  const memDir = loadUserMemoriesDir(userId)
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true })
  }
  return memDir
}