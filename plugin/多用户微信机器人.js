import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer'
import common from '#utils/common.js'

const TEMP_DIR = path.join(process.cwd(), 'data', 'temp', 'multiuser-wechat')

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
}

let browser = null

async function getBrowser() {
  if (browser && (await browser.pages()).length > 0) return browser
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage']
  })
  console.log('[多用户微信机器人] Puppeteer 浏览器已启动')
  return browser
}

async function screenshotUrl(url, filepath) {
  const br = await getBrowser()
  const page = await br.newPage()
  await page.setViewport({ width: 400, height: 600 })
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.evaluate(() => new Promise(r => setTimeout(r, 1000)))
  await page.screenshot({ path: filepath, type: 'png' })
  await page.close()
  return filepath
}

const DATA_DIR = path.join(process.cwd(), 'core', 'AI-MultiUser-Core', 'accounts')
const MASTER_FILE = path.join(process.cwd(), 'core', 'AI-MultiUser-Core', 'masters.json')
const DEFAULT_PERSONA_FILE = path.join(process.cwd(), 'core', 'AI-MultiUser-Core', 'default-persona.md')
const AI_MULTIUSER_DIR = path.join(process.cwd(), 'core', 'AI-MultiUser-Core')
const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_ILINK_BOT_TYPE = '3'
const QR_LONG_POLL_TIMEOUT_MS = 35000
const ACTIVE_LOGIN_TTL_MS = 5 * 60000
const CHANNEL_VERSION = '2.1.10'
const ILINK_APP_ID = ''

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const activeLogins = new Map()
const accountMonitors = new Map()

// 消息合并：每个用户的消息队列
const userMessageQueues = new Map()
// 防抖计时器
const userDebounceTimers = new Map()
// 消息合并等待时间（毫秒）
const MESSAGE_MERGE_WAIT_MS = 3000

// API配置状态管理：{ [userId]: { step: 'url'|'key'|'model', data: { url?: string, key?: string } } }
const apiConfigStates = new Map()

// 自动发消息配置
const AUTO_MSG_ENABLED_KEY = 'autoMsgEnabled'
const AUTO_MSG_LAST_ACTIVE_KEY = 'autoMsgLastActive'
const AUTO_MSG_LAST_SENT_KEY = 'autoMsgLastSent'

// 名称与QQ绑定配置
const NAME_BINDING_FILE = path.join(AI_MULTIUSER_DIR, 'name-bindings.json')

// API轮询索引
let currentApiIndex = 0

// 自动发消息的定时器
let autoMsgTimeout = null
// 下次自动发消息的时间
let nextAutoMsgTime = null

// 加载名称绑定
function loadNameBindings() {
  if (!fs.existsSync(NAME_BINDING_FILE)) {
    return {}
  }
  try {
    const content = fs.readFileSync(NAME_BINDING_FILE, 'utf8')
    return JSON.parse(content)
  } catch (e) {
    return {}
  }
}

// 保存名称绑定
function saveNameBindings(bindings) {
  fs.writeFileSync(NAME_BINDING_FILE, JSON.stringify(bindings, null, 2))
}

function randomWechatUin() {
  const uint32 = new Uint32Array(1)
  uint32[0] = Math.random() * 0xFFFFFF
  return Buffer.from(String(uint32[0]), 'utf8').toString('base64')
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

function buildHeaders({ token, body }) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CHANNEL_VERSION,
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }
  return headers
}

async function apiGetFetch({ baseUrl, endpoint, timeoutMs, label }) {
  const base = ensureTrailingSlash(baseUrl)
  const url = new URL(endpoint, base)
  const hdrs = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CHANNEL_VERSION,
  }
  const timeout = timeoutMs
  const controller = timeout != null && timeout > 0 ? new AbortController() : undefined
  const t = controller != null && timeout != null ? setTimeout(() => controller.abort(), timeout) : undefined
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (t !== undefined) clearTimeout(t)
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`${label} ${res.status}`)
    }
    return rawText
  } catch (err) {
    if (t !== undefined) clearTimeout(t)
    throw err
  }
}

async function apiPostFetch({ baseUrl, endpoint, body, token, timeoutMs, label }) {
  const base = ensureTrailingSlash(baseUrl)
  const url = new URL(endpoint, base)
  const hdrs = buildHeaders({ token, body })
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: hdrs,
      body,
      signal: controller.signal,
    })
    clearTimeout(t)
    const rawText = await res.text()
    if (!res.ok) {
      throw new Error(`${label} ${res.status}`)
    }
    try {
      return JSON.parse(rawText)
    } catch (parseErr) {
      return rawText
    }
  } catch (err) {
    clearTimeout(t)
    throw err
  }
}

function getAccountDir(userId) {
  return path.join(DATA_DIR, `user-${userId}`)
}

function loadAccount(userId) {
  const configPath = path.join(getAccountDir(userId), 'config.json')
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (err) {
    console.error('[多用户微信机器人] 加载账号配置失败', err)
  }
  return null
}

function saveAccount(userId, config) {
  const dir = getAccountDir(userId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  
  const personaPath = path.join(dir, 'persona.md')
  if (!fs.existsSync(personaPath) && fs.existsSync(DEFAULT_PERSONA_FILE)) {
    fs.copyFileSync(DEFAULT_PERSONA_FILE, personaPath)
  }
}

function deleteAccountDir(userId) {
  const dir = getAccountDir(userId)
  if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }) }
}

function getAllAccounts() {
  const accounts = []
  try {
    if (fs.existsSync(DATA_DIR)) {
      const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
      for (const dir of dirs) {
        if (dir.isDirectory() && dir.name.startsWith('user-')) {
          const userId = dir.name.substring('user-'.length)
          const account = loadAccount(userId)
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

function isLoginFresh(login) {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS
}

function purgeExpiredLogins() {
  for (const [key, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(key)
    }
  }
}

async function fetchQRCode(baseUrl, botType) {
  console.log('[多用户微信机器人] 获取二维码...')
  const rawText = await apiGetFetch({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: 15000,
    label: 'fetchQRCode',
  })
  return JSON.parse(rawText)
}

async function pollQRStatus(baseUrl, qrcode) {
  try {
    const rawText = await apiGetFetch({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
    })
    return JSON.parse(rawText)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' }
    }
    console.warn('[多用户微信机器人] 轮询状态错误', String(err))
    return { status: 'wait' }
  }
}

async function startWeixinLogin(userId, pluginInstance, messageId) {
  const sessionKey = userId
  
  purgeExpiredLogins()
  
  const existing = activeLogins.get(sessionKey)
  if (existing && isLoginFresh(existing)) {
    // 更新 messageId
    existing.messageId = messageId
    activeLogins.set(sessionKey, existing)
    return { status: 'exists', qrcodeUrl: existing.qrcodeUrl, message: '二维码已就绪，请使用微信扫描' }
  }
  
  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE)
    console.log('[多用户微信机器人] 二维码获取成功')
    
    const login = {
      userId,
      qrcode: qrResponse.qrcode, qrcodeUrl: qrResponse.qrcode_img_content, startedAt: Date.now(),
      currentApiBaseUrl: FIXED_BASE_URL, status: 'wait', pluginInstance,
      messageId,
    }
    
    activeLogins.set(sessionKey, login)
    
    pollQRCodeLoop(sessionKey).catch(err => {
      console.error('[多用户微信机器人] 轮询失败', err.message)
      activeLogins.delete(sessionKey)
    })
    
    return { status: 'success', qrcodeUrl: qrResponse.qrcode_img_content, message: '二维码已生成，请使用微信扫描登录' }
  } catch (err) {
    console.error('[多用户微信机器人] 获取二维码失败', err.message)
    return { status: 'error', message: `获取二维码失败: ${err.message}` }
  }
}

async function pollQRCodeLoop(sessionKey) {
  const MAX_QR_REFRESH_COUNT = 3
  let qrRefreshCount = 0
  
  while (activeLogins.has(sessionKey)) {
    const login = activeLogins.get(sessionKey)
    if (!login) break
    
    if (!isLoginFresh(login)) {
      console.log('[多用户微信机器人] 二维码超时')
      try {
        if (login.pluginInstance) {
          await login.pluginInstance.reply('登录超时，请重新发送 #登录微信AI')
        }
      } catch (e) {}
      activeLogins.delete(sessionKey)
      break
    }
    
    try {
      const statusResponse = await pollQRStatus(login.currentApiBaseUrl, login.qrcode)
      login.status = statusResponse.status
      
      switch (statusResponse.status) {
        case 'wait':
          await new Promise(r => setTimeout(r, 1000))
          continue
          
        case 'scaned':
          console.log('[多用户微信机器人] 已扫码，等待确认')
          try {
            if (login.pluginInstance && login.messageId) {
              await login.pluginInstance.reply([
                segment.reply(login.messageId),
                segment.at(login.userId),
                ' ',
                '已扫码，请在微信中确认登录！'
              ])
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 1000))
          continue
          
        case 'scaned_but_redirect':
          if (statusResponse.redirect_host) {
            login.currentApiBaseUrl = `https://${statusResponse.redirect_host}`
            console.log(`[多用户微信机器人] 重定向到 ${login.currentApiBaseUrl}`)
          }
          continue
          
        case 'expired':
          console.log('[多用户微信机器人] 二维码已过期')
          try {
            if (login.pluginInstance && login.messageId) {
              await login.pluginInstance.reply([
                segment.reply(login.messageId),
                segment.at(login.userId),
                ' ',
                '二维码已过期，请重新发送 #登录微信AI'
              ])
            }
          } catch (e) {}
          activeLogins.delete(sessionKey)
          break
          
        case 'confirmed':
          if (!statusResponse.ilink_bot_id) {
            console.error('[多用户微信机器人] 登录成功但缺少 ilink_bot_id')
            try {
              if (login.pluginInstance && login.messageId) {
                await login.pluginInstance.reply([
                  segment.reply(login.messageId),
                  segment.at(login.userId),
                  ' ',
                  '登录失败：未获取到账号信息'
                ])
              }
            } catch (e) {}
            activeLogins.delete(sessionKey)
            break
          }
          
          console.log(`[多用户微信机器人] 登录成功！accountId=${statusResponse.ilink_bot_id}`)
          
          const existingAccount = loadAccount(sessionKey)
          const account = {
            userId: sessionKey, accountId: statusResponse.ilink_bot_id, token: statusResponse.bot_token,
            baseUrl: statusResponse.base_url || FIXED_BASE_URL, userIdFromWeixin: statusResponse.ilink_user_id,
            createdAt: existingAccount?.createdAt || Date.now(),
            lastActiveAt: Date.now(),
            enabled: true, get_updates_buf: '',
            ...(existingAccount?.age ? { age: existingAccount.age } : {})
          }
          
          saveAccount(sessionKey, account)
          activeLogins.delete(sessionKey)
          
          try {
            if (login.pluginInstance && login.messageId) {
              let replyMsg = '✅ 登录成功！微信机器人已启动！\n\n'
              replyMsg += '💡 提示：现在可以发送 #更改人设 来设置你的专属人设哦！\n'
              replyMsg += '（也可以发送 #当前人设 查看当前人设）'
              await login.pluginInstance.reply([
                segment.reply(login.messageId),
                segment.at(login.userId),
                ' ',
                replyMsg
              ])
            }
          } catch (e) {}
          
          // 先停止旧的监听，确保新的监听能启动
          stopAccountMonitor(sessionKey)
          // 等待一小会儿再启动新的监听
          await new Promise(r => setTimeout(r, 500))
          startAccountMonitor(sessionKey, account)
          console.log(`[多用户微信机器人] ${sessionKey} 监听已重启`)
          break
      }
    } catch (err) {
      console.error('[多用户微信机器人] 轮询出错', err.message)
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

function startAccountMonitor(userId, account) {
  if (accountMonitors.has(userId)) {
    console.log(`[多用户微信机器人] ${userId} 已有监听在运行`)
    return
  }
  
  console.log(`[多用户微信机器人] 启动 ${userId} 消息监听...`)
  
  const abort = new AbortController()
  accountMonitors.set(userId, abort)
  
  monitorAccountLoop(userId, account, abort.signal).catch(err => {
    console.error(`[多用户微信机器人] ${userId} 监听出错`, err.message)
    accountMonitors.delete(userId)
  })
}

function stopAccountMonitor(userId) {
  const abort = accountMonitors.get(userId)
  if (abort) {
    abort.abort()
    accountMonitors.delete(userId)
    console.log(`[多用户微信机器人] ${userId} 已停止`)
  }
}

async function monitorAccountLoop(userId, account, signal) {
  let errorCount = 0
  const MAX_ERRORS = 5
  
  while (!signal.aborted) {
    try {
      const currentAccount = loadAccount(userId) || account
      if (!currentAccount.token) {
        console.warn(`[多用户微信机器人] ${userId} 没有 token`)
        break
      }
      
      const baseUrl = currentAccount.baseUrl || FIXED_BASE_URL
      
      const reqBody = JSON.stringify({
        get_updates_buf: currentAccount.get_updates_buf ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      })
      
      const resp = await apiPostFetch({
        baseUrl,
        endpoint: 'ilink/bot/getupdates',
        body: reqBody,
        token: currentAccount.token,
        timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
        label: 'getUpdates',
      })
      
      // 成功了，重置错误计数
      errorCount = 0
      
      if (resp.get_updates_buf) {
        currentAccount.get_updates_buf = resp.get_updates_buf
        saveAccount(userId, currentAccount)
      }
      
      if (resp.msgs && resp.msgs.length > 0) {
        console.log(`[多用户微信机器人] ${userId} 收到 ${resp.msgs.length} 条新消息`)
        for (const msg of resp.msgs) {
          await processAccountMessage(userId, currentAccount, msg)
        }
      }
      
    } catch (err) {
      errorCount++
      console.error(`[多用户微信机器人] ${userId} 消息监听出错 (${errorCount}/${MAX_ERRORS})`, err.message)
      
      if (errorCount >= MAX_ERRORS) {
        console.error(`[多用户微信机器人] ${userId} 错误次数过多，重启监听`)
        // 停止当前监听，然后重新启动
        stopAccountMonitor(userId)
        // 重新加载账号并启动
        const freshAccount = loadAccount(userId)
        if (freshAccount && freshAccount.token && freshAccount.enabled) {
          await new Promise(r => setTimeout(r, 1000))
          startAccountMonitor(userId, freshAccount)
          console.log(`[多用户微信机器人] ${userId} 监听已重启`)
        }
        break
      }
      
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

function getPersonaPath(userId) {
  return path.join(getAccountDir(userId), 'persona.md')
}

function getMemoryPath(userId) {
  return path.join(getAccountDir(userId), 'chat-memory.json')
}

function getMemoriesDir(userId) {
  return path.join(getAccountDir(userId), 'memories')
}

function getUserApiConfigPath(userId) {
  return path.join(getAccountDir(userId), 'api-config.json')
}

function loadUserApiConfig(userId) {
  const configPath = getUserApiConfigPath(userId)
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (err) {
    console.error('[多用户微信机器人] 加载用户API配置失败', err)
  }
  return null
}

function saveUserApiConfig(userId, config) {
  const configPath = getUserApiConfigPath(userId)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function getBeijingTime() {
  const now = new Date()
  const beijingOffset = 8 * 60 * 60 * 1000
  const beijingTime = new Date(now.getTime() + beijingOffset)
  const year = beijingTime.getUTCFullYear()
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0')
  const day = String(beijingTime.getUTCDate()).padStart(2, '0')
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0')
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0')
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0')
  return {
    full: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}:${seconds}`,
    timestamp: beijingTime.getTime(),
    year, month, day, hours, minutes, seconds
  }
}

function loadPersona(userId) {
  const personaPath = getPersonaPath(userId)
  if (fs.existsSync(personaPath)) {
    return fs.readFileSync(personaPath, 'utf8').trim()
  }
  
  if (fs.existsSync(DEFAULT_PERSONA_FILE)) {
    const defaultPersona = fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8').trim()
    if (defaultPersona) {
      return defaultPersona
    }
  }
  
  return '你是一个友好、有趣的微信聊天伙伴，喜欢分享日常，说话自然不生硬。'
}

function savePersona(userId, persona) {
  const personaPath = getPersonaPath(userId)
  fs.writeFileSync(personaPath, persona, 'utf8')
  console.log(`[多用户微信机器人] ${userId} 人设已更新`)
}

function loadMemory(userId) {
  const memPath = getMemoryPath(userId)
  if (fs.existsSync(memPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(memPath, 'utf8'))
      if (Array.isArray(data) && data.length > 0) {
        const now = Date.now()
        const maxAge = 7 * 24 * 60 * 60 * 1000
        const filtered = data.filter(m => (now - (m.timestamp || 0)) < maxAge)
        return filtered.slice(-30)
      }
    } catch (e) {}
  }
  return []
}

function saveMemory(userId, memory) {
  const dir = getAccountDir(userId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(getMemoryPath(userId), JSON.stringify(memory, null, 2))
}

function addChatLog(userId, role, text) {
  let mem = loadMemory(userId)
  mem.push({ role, text, timestamp: Date.now() })
  if (mem.length > 50) mem = mem.slice(-50)
  saveMemory(userId, mem)
}

function clearMemory(userId) {
  saveMemory(userId, [])
  
  const memoriesDir = getMemoriesDir(userId)
  if (fs.existsSync(memoriesDir)) {
    const files = fs.readdirSync(memoriesDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(memoriesDir, file))
      } catch (e) {}
    }
  }
  
  console.log(`[多用户微信机器人] ${userId} 聊天记忆和记忆文件已清除`)
}

function ensureMemoriesDir(userId) {
  const dir = getMemoriesDir(userId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getAllMemories(userId) {
  const dir = getMemoriesDir(userId)
  if (!fs.existsSync(dir)) return []
  
  const files = fs.readdirSync(dir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
  const memories = []
  
  for (const file of files.sort().reverse()) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8')
      const dayMemories = JSON.parse(content)
      if (Array.isArray(dayMemories)) {
        memories.push(...dayMemories.reverse())
      }
    } catch (e) {}
  }
  
  return memories
}

function saveMemoryItem(userId, memoryItem) {
  const dir = ensureMemoriesDir(userId)
  const beijingTime = getBeijingTime()
  const filename = `${beijingTime.date}.json`
  const filepath = path.join(dir, filename)
  
  const fullMemory = {
    ...memoryItem,
    timestamp: beijingTime.timestamp,
    beijingTime: beijingTime.full,
    date: beijingTime.date,
    time: beijingTime.time
  }
  
  let dayMemories = []
  if (fs.existsSync(filepath)) {
    try {
      dayMemories = JSON.parse(fs.readFileSync(filepath, 'utf8'))
      if (!Array.isArray(dayMemories)) dayMemories = []
    } catch (e) {}
  }
  
  dayMemories.push(fullMemory)
  fs.writeFileSync(filepath, JSON.stringify(dayMemories, null, 2))
  console.log(`[多用户微信机器人] ${userId} 保存记忆: ${memoryItem.title}`)
  return fullMemory
}

function getRecentMemoriesString(userId, limit = 3) {
  const memories = getAllMemories(userId).slice(0, limit)
  if (memories.length === 0) return ''
  
  let lines = ['记住这几件事：']
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    const importance = m.importance === 'important' ? '⭐' : ''
    lines.push(`记忆${i + 1}: ${m.title}`)
  }
  return lines.join('\n')
}

// 自动发消息的辅助函数
function getUserAutoMsgConfig(userId) {
  const account = loadAccount(userId)
  return {
    enabled: account?.[AUTO_MSG_ENABLED_KEY] || false,
    lastActive: account?.[AUTO_MSG_LAST_ACTIVE_KEY] || 0,
    lastSent: account?.[AUTO_MSG_LAST_SENT_KEY] || 0,
    lastChatFromUser: account?.lastChatFromUser,
  }
}

function setUserAutoMsgConfig(userId, updates) {
  const account = loadAccount(userId) || {}
  const newAccount = {
    ...account,
    ...updates,
  }
  saveAccount(userId, newAccount)
}

function updateUserLastActive(userId) {
  setUserAutoMsgConfig(userId, { [AUTO_MSG_LAST_ACTIVE_KEY]: Date.now() })
}

// 格式化时间差（比如：30分钟、1小时、2小时30分）
function formatTimeDiff(ms) {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  
  if (hours > 0) {
    if (remainingMinutes > 0) {
      return `${hours}小时${remainingMinutes}分`
    }
    return `${hours}小时`
  }
  return `${minutes}分钟`
}

// 生成随机分钟（15-45分钟）
function getRandomMinutes() {
  return 15 + Math.floor(Math.random() * 31) // 15到45分钟
}

// 生成主动发的消息
async function generateAutoMessage(userId, account) {
  try {
    const config = getUserAutoMsgConfig(userId)
    const now = Date.now()
    const idleTime = now - (config.lastActive || now)
    const idleTimeStr = formatTimeDiff(idleTime)
    
    const personaText = loadPersona(userId)
    const history = getChatHistoryString(userId)
    const recentMemories = getRecentMemoriesString(userId, 2)
    const beijingTime = getBeijingTime()
    
    const prompt = `现在请主动和用户说话！

【你的人设】
${personaText}

【现在的时间】${beijingTime.full}

【用户空闲时间】${idleTimeStr}没理你了

${recentMemories ? recentMemories : ''}

【刚才的聊天记录】
${history || ''}

---

请完全按照人设，主动和用户说句话（自然口语，像真人一样），不要加任何括号，不要加任何格式，直接说内容！`
    
    const aiResponse = await callAI(prompt, userId)
    
    if (!aiResponse) return null
    
    // 清理括号
    let finalResponse = aiResponse.trim()
    finalResponse = finalResponse.replace(/（[^）]*）/g, '')
    finalResponse = finalResponse.replace(/\([^)]*\)/g, '')
    finalResponse = finalResponse.replace(/\[[^\]]*\]/g, '')
    finalResponse = finalResponse.replace(/<[^>]*>/g, '')
    finalResponse = finalResponse.replace(/\n\s*\n/g, '\n').trim()
    
    return finalResponse || null
  } catch (e) {
    console.error(`[多用户微信机器人] 生成消息出错`, e)
    return null
  }
}

// 给用户发送主动消息
async function sendAutoMessages() {
  console.log('[多用户微信机器人] 开始给用户发送主动消息')
  
  // 获取所有开启的用户
  const accounts = getAllAccounts()
  const enabledAccounts = accounts.filter(a => a.enabled && a[AUTO_MSG_ENABLED_KEY] && a.lastChatFromUser)
  
  if (enabledAccounts.length === 0) {
    console.log('[多用户微信机器人] 没有开启自动发消息的用户')
    scheduleNextAutoMessage()
    return
  }
  
  // 随机选1-2个用户
  const numToSelect = Math.min(enabledAccounts.length, 1 + Math.floor(Math.random() * 2))
  const selected = []
  const used = new Set()
  
  while (selected.length < numToSelect) {
    const idx = Math.floor(Math.random() * enabledAccounts.length)
    if (!used.has(idx)) {
      used.add(idx)
      selected.push(enabledAccounts[idx])
    }
  }
  
  console.log(`[多用户微信机器人] 选中了 ${selected.length} 个用户`)
  
  for (const account of selected) {
    try {
      const userId = account.userId
      const message = await generateAutoMessage(userId, account)
      
      if (message) {
        const config = getUserAutoMsgConfig(userId)
        
        console.log(`[多用户微信机器人] 给用户${userId}主动发消息: ${message}`)
        
        // 发送
        await sendToWeixin({
          userId,
          toUser: config.lastChatFromUser,
          text: message,
          contextToken: null,
          config: account,
        })
        
        // 更新lastSent
        setUserAutoMsgConfig(userId, { [AUTO_MSG_LAST_SENT_KEY]: Date.now() })
      }
    } catch (e) {
      console.error(`[多用户微信机器人] 发送消息出错`, e)
    }
  }
  
  // 安排下次
  scheduleNextAutoMessage()
}

// 安排下次自动发消息
function scheduleNextAutoMessage() {
  if (autoMsgTimeout) {
    clearTimeout(autoMsgTimeout)
  }
  
  // 计算下次两小时后的时间
  const now = new Date()
  const nextHour = now.getHours() + 2
  const targetHour = nextHour % 24
  const targetMinutes = getRandomMinutes() // 随机15-45分钟
  
  const targetTime = new Date(now)
  targetTime.setHours(targetHour)
  targetTime.setMinutes(targetMinutes)
  targetTime.setSeconds(0)
  targetTime.setMilliseconds(0)
  
  // 如果已经过了，加一天
  if (targetTime <= now) {
    targetTime.setDate(targetTime.getDate() + 1)
  }
  
  const delay = targetTime - now
  
  console.log(`[多用户微信机器人] 下次自动发消息时间: ${targetTime.toLocaleString()}`)
  
  // 保存到全局变量
  nextAutoMsgTime = targetTime
  
  autoMsgTimeout = setTimeout(() => {
    sendAutoMessages().catch(e => console.error('[多用户微信机器人] 发送主动消息出错', e))
  }, delay)
}

// 启动自动发消息
function startAutoMsgTimer() {
  console.log('[多用户微信机器人] 启动自动发消息功能')
  scheduleNextAutoMessage()
}

// 停止自动发消息
function stopAutoMsgTimer() {
  if (autoMsgTimeout) {
    clearTimeout(autoMsgTimeout)
    autoMsgTimeout = null
  }
  console.log('[多用户微信机器人] 停止自动发消息功能')
}

function generateSimpleTitle(userText, aiText) {
  const combined = (userText + ' ' + aiText).trim()
  if (combined.length <= 20) return combined
  return combined.substring(0, 17) + '...'
}

function getChatHistoryString(userId) {
  const mem = loadMemory(userId)
  if (!mem.length) return ''
  
  let lines = []
  // 取最近的8条历史
  const recentMem = mem.slice(-8)
  for (let i = 0; i < recentMem.length; i++) {
    const item = recentMem[i]
    if (item.role === 'user') {
      lines.push(`用户: ${item.text}`)
    } else {
      lines.push(`你: ${item.text}`)
    }
  }
  return lines.join('\n')
}

let cachedConfig = null

// 记录每个API的健康状态和最后检查时间
const apiHealth = new Map() // key: api url, value: { ok: boolean, lastCheck: number }
const API_CHECK_INTERVAL = 120000 // 2分钟检查一次

async function checkApiHealth(api) {
  const now = Date.now()
  const cached = apiHealth.get(api.url)
  
  // 如果最近检查过，直接返回缓存
  if (cached && (now - cached.lastCheck) < API_CHECK_INTERVAL) {
    return cached.ok
  }
  
  // 快速检查：发送一个简单请求（max_tokens=1）
    try {
      const response = await fetch(api.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api.key}`
        },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          temperature: 0
        }),
        signal: AbortSignal.timeout(10000) // 10秒超时
      })
    
    const ok = response.ok
    apiHealth.set(api.url, { ok, lastCheck: now })
    console.log(`[多用户微信机器人] API ${api.url} 健康检查: ${ok ? '✅' : '❌'}`)
    return ok
  } catch (e) {
    apiHealth.set(api.url, { ok: false, lastCheck: now })
    console.log(`[多用户微信机器人] API ${api.url} 健康检查: ❌ (${e.message})`)
    return false
  }
}

async function getAvailableApis(config) {
  const available = []
  for (const api of config.apis) {
    const ok = await checkApiHealth(api)
    if (ok) {
      available.push(api)
    }
  }
  return available
}

function loadPluginConfig() {
  if (cachedConfig) return cachedConfig
  try {
    const configPath = path.join(process.cwd(), 'core', 'AI-MultiUser-Core', 'plugin-config.json')
    if (fs.existsSync(configPath)) {
      cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      console.log('[多用户微信机器人] 加载插件配置成功')
    }
  } catch (e) {
    console.error('[多用户微信机器人] 加载插件配置失败', e)
  }
  return cachedConfig
}

async function callAI(prompt, userId) {
  // 先看用户有没有配置自定义API且启用
  const userApiConfig = loadUserApiConfig(userId)
  let useUserApi = false
  let apisToUse = []
  
  const officialConfig = loadPluginConfig()
  const officialApiUrls = (officialConfig?.apis || []).map(api => api.url)
  
  if (userApiConfig && userApiConfig.enabled && userApiConfig.apis && userApiConfig.apis.length > 0) {
    // 使用用户自定义的API
    useUserApi = true
    apisToUse = userApiConfig.apis
    console.log(`[多用户微信机器人] 用户 ${userId} 使用自定义API`)
  } else {
    // 使用官方配置的API
    if (!officialConfig || !officialConfig.apis || officialConfig.apis.length === 0) {
      console.error('[多用户微信机器人] 插件配置未找到')
      return null
    }
    apisToUse = officialConfig.apis
  }

  // 获取可用的API（优先用缓存，没有再检查）
  const availableApis = []
  const now = Date.now()
  for (const api of apisToUse) {
    // 用户自定义API：跳过健康检查，直接加入可用列表！
    if (useUserApi) {
      availableApis.push(api)
      continue
    }
    
    // 官方API才检查健康
    const cached = apiHealth.get(api.url)
    if (cached && (now - cached.lastCheck) < API_CHECK_INTERVAL) {
      if (cached.ok) {
        availableApis.push(api)
      }
    } else {
      // 没有缓存或过期，快速检查
      const ok = await checkApiHealth(api)
      if (ok) {
        availableApis.push(api)
      }
    }
  }
  
  // 用户自定义API即使全部失败也用
  if (availableApis.length === 0 && !useUserApi) {
    console.error('[多用户微信机器人] 没有可用的API')
    return null
  }
  
  // 如果是用户自定义API但没有可用的，直接用用户配置的全部
  if (availableApis.length === 0 && useUserApi) {
    availableApis.push(...apisToUse)
  }
  
  console.log(`[多用户微信机器人] 可用API数量: ${availableApis.length}/${apisToUse.length}`)

  // 只在可用的API中轮询
  const originalIndex = currentApiIndex % availableApis.length
  for (let i = 0; i < availableApis.length; i++) {
    const apiIndex = (originalIndex + i) % availableApis.length
    const api = availableApis[apiIndex]
    
    console.log(`[多用户微信机器人] 尝试API: ${api.url}`)
    
    try {
      const response = await fetch(api.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api.key}`
        },
        body: JSON.stringify({
          model: api.model,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 1000
        }),
        signal: AbortSignal.timeout(30000) // 30秒超时
      })

      if (response.ok) {
        const data = await response.json()
        console.log(`[多用户微信机器人] API ${api.url} 完整返回:`, JSON.stringify(data, null, 2))
        
        let result = null
        
        // 尝试多种返回格式
        if (data.choices?.[0]?.message?.content) {
          result = data.choices[0].message.content
        } else if (data.message?.content) {
          result = data.message.content
        } else if (data.content) {
          result = data.content
        } else if (data.text) {
          result = data.text
        } else if (data.response) {
          result = data.response
        }
        
        // 用户自定义 API 放宽检查！
        if (!result && useUserApi) {
          console.warn(`[多用户微信机器人] 用户自定义 API 返回非常规格式，尝试直接转字符串`)
          result = JSON.stringify(data)
        }
        
        if (!result) {
          console.warn(`[多用户微信机器人] API ${api.url} 返回空内容:`, data)
          // 用户自定义 API 即使返回空也继续尝试下一个，不要标记！
          if (!useUserApi) {
            apiHealth.set(api.url, { ok: false, lastCheck: Date.now() })
          }
          continue
        }
        
        // 成功了，更新索引
        const originalApiIndex = apisToUse.findIndex(a => a.url === api.url)
        currentApiIndex = originalApiIndex + 1
        console.log(`[多用户微信机器人] API ${api.url} 调用成功`)
        return result
      } else {
        const errorText = await response.text()
        console.warn(`[多用户微信机器人] API ${api.url} 失败: ${response.status}`, errorText)
        // 标记这个API失败
        apiHealth.set(api.url, { ok: false, lastCheck: Date.now() })
      }
    } catch (e) {
      console.warn(`[多用户微信机器人] API ${api.url} 异常:`, e.message)
      // 标记这个API失败
      apiHealth.set(api.url, { ok: false, lastCheck: Date.now() })
    }
  }
  
  // 所有可用API都失败了
  console.error('[多用户微信机器人] 所有API调用失败')
  return null
}

function randomDelay(min, max) {
  return Math.random() * (max - min) + min
}

function splitTextToSegments(text) {
  const segments = []
  
  // 先按单个换行符拆分，然后按行处理
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line)
  
  for (const line of lines) {
    if (segments.length >= 10) break
    
    if (line.length <= 10) {
      segments.push(line)
    } else {
      const sentences = line.split(/(?<=[。！？!?])\s*/).filter(s => s.trim())
      for (const sentence of sentences) {
        if (segments.length >= 10) break
        if (sentence.trim()) {
          segments.push(sentence.trim())
        }
      }
    }
  }
  
  // 确保至少有一段
  if (segments.length === 0) {
    // 如果处理后没有内容，把原文本trim后放进去
    if (text.trim()) {
      segments.push(text.trim())
    }
  }
  
  return segments.slice(0, 10)
}

async function sendToWeixin({ userId, toUser, text, contextToken, config, disableSplit = false }) {
  try {
    if (!text || !text.trim()) return
    
    let segments = disableSplit ? [text.trim()] : splitTextToSegments(text)
    
    // 双重检查：如果还是空的，直接用原文本
    if (!segments || segments.length === 0) {
      segments = [text.trim()]
    }
    
    for (let i = 0; i < segments.length; i++) {
      let segment = segments[i]
      if (!segment || !segment.trim()) continue
      
      if (i > 0) {
        const delay = randomDelay(1000, 1700)
        console.log(`[多用户微信机器人] 等待 ${Math.round(delay)}ms 后发送下一段...`)
        await new Promise(r => setTimeout(r, delay))
      }
      
      const clientId = randomUUID()
      const item_list = [{ type: 1, text_item: { text: segment } }]
      
      const body = JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: toUser,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: item_list,
          context_token: contextToken
        },
        base_info: { channel_version: CHANNEL_VERSION }
      })
      
      await apiPostFetch({
        baseUrl: config.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token: config.token,
        body: body,
        timeoutMs: 15000,
        label: 'sendWeixin'
      })
      
      console.log(`[多用户微信机器人] 发送段落 ${i + 1}/${segments.length}: ${segment.substring(0, 30)}${segment.length > 30 ? '...' : ''}`)
    }
    
    console.log('[多用户微信机器人] 微信消息发送完成')
  } catch (e) {
    console.error('[多用户微信机器人] 发送微信消息失败', e)
  }
}

async function processAccountMessage(userId, account, msg) {
  const safeMsg = { 
    seq: msg.seq,
    from_user_id: msg.from_user_id ? '[USER_ID]' : undefined,
    to_user_id: msg.to_user_id ? '[BOT_ID]' : undefined,
    client_id: msg.client_id ? '[REDACTED]' : undefined,
    message_type: msg.message_type,
    message_state: msg.message_state,
    item_list: msg.item_list ? msg.item_list.map(item => ({
      type: item.type,
      text_item: item.text_item ? { text: item.text_item.text } : undefined
    })) : undefined,
    context_token: '[REDACTED]'
  }
  console.log('[多用户微信机器人] processAccountMessage 开始处理', JSON.stringify(safeMsg))
  
  let text = ''
  if (msg.item_list && msg.item_list.length > 0) {
    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item?.text) {
        text = item.text_item.text
        console.log('[多用户微信机器人] 提取到文本:', text)
        break
      } else if (item.type === 3 && item.voice_item?.text) {
        text = item.voice_item.text
        console.log(`[多用户微信机器人] ${userId} 识别到语音: ${text}`)
        break
      }
    }
  }
  
  console.log('[多用户微信机器人] 最终提取的 text:', text)
  
  if (text && text.trim()) {
    const fromUser = msg.from_user_id
    const contextToken = msg.context_token
    const trimmedText = text.trim()
    
    // 更新用户最后活跃时间
    updateUserLastActive(userId)
    // 记录最后聊天的用户
    setUserAutoMsgConfig(userId, { lastChatFromUser: fromUser })
    
    // 先检查用户是否正在配置 API
    if (apiConfigStates.has(userId)) {
      await handleApiConfigStep(userId, account, fromUser, contextToken, trimmedText)
      return
    }
    
    // 先判断是不是系统命令
    if (trimmedText.startsWith('#') || trimmedText.startsWith('＃')) {
      await processSystemCommand(userId, account, fromUser, contextToken, trimmedText)
    } else {
      // 用户唯一标识（用userId+fromUser区分不同微信用户）
      const userKey = `${userId}_${fromUser}`
      
      // 加入消息队列
      if (!userMessageQueues.has(userKey)) {
        userMessageQueues.set(userKey, [])
      }
      userMessageQueues.get(userKey).push({
        text,
        fromUser,
        contextToken,
        timestamp: Date.now()
      })
      
      console.log(`[多用户微信机器人] ${userKey} 消息已加入队列，当前队列长度: ${userMessageQueues.get(userKey).length}`)
      
      // 清除之前的计时器
      if (userDebounceTimers.has(userKey)) {
        clearTimeout(userDebounceTimers.get(userKey))
      }
      
      // 设置新的计时器，等待一段时间后处理合并后的消息
      const timer = setTimeout(async () => {
        await processMergedMessages(userId, account, userKey)
      }, MESSAGE_MERGE_WAIT_MS)
      
      userDebounceTimers.set(userKey, timer)
    }
  } else {
    console.log('[多用户微信机器人] 跳过处理，text为空')
  }
}

// 处理 API 配置步骤
async function handleApiConfigStep(userId, account, fromUser, contextToken, userInput) {
  const state = apiConfigStates.get(userId)
  
  if (!state) return
  
  // 检查是否取消配置
  if (userInput.startsWith('#取消') || userInput.startsWith('＃取消')) {
    apiConfigStates.delete(userId)
    await sendToWeixin({ userId, toUser: fromUser, text: '已取消配置 API', contextToken, config: account, disableSplit: true })
    return
  }
  
  if (state.step === 'confirm') {
    // 处理用户确认
    const confirmText = userInput.trim().toLowerCase()
    
    if (confirmText === '是' || confirmText === 'yes' || confirmText === 'y' || confirmText === '继续') {
      // 用户选择继续，进入 key 步骤
      apiConfigStates.set(userId, { step: 'key', data: { url: state.data.url } })
      await sendToWeixin({ userId, toUser: fromUser, text: '好的，API 地址已记录！现在请输入你的 API Key（密钥）', contextToken, config: account, disableSplit: true })
    } else {
      // 用户选择取消
      apiConfigStates.delete(userId)
      await sendToWeixin({ userId, toUser: fromUser, text: '已取消配置 API', contextToken, config: account, disableSplit: true })
    }
    return
  }
  
  if (state.step === 'url') {
    // 处理 URL
    let url = userInput.trim()
    
    // 检查是否有 http
    if (!url.startsWith('http')) {
      await sendToWeixin({ userId, toUser: fromUser, text: '请输入有效的 API 地址，需要以 http 或 https 开头哦', contextToken, config: account, disableSplit: true })
      return
    }
    
    // 自动补全 URL
    if (!url.includes('/chat/completions')) {
      if (url.endsWith('/v1')) {
        url = url + '/chat/completions'
      } else if (url.endsWith('/v1/')) {
        url = url + 'chat/completions'
      } else if (url.endsWith('/')) {
        url = url + 'v1/chat/completions'
      } else {
        url = url + '/v1/chat/completions'
      }
      console.log(`[多用户微信机器人] 自动补全URL为: ${url}`)
    }
    
    // 检查是否与官方API冲突
    const officialConfig = loadPluginConfig()
    const officialApiUrls = (officialConfig?.apis || []).map(api => api.url)
    if (officialApiUrls.includes(url)) {
      // 保存URL和冲突警告状态，等待用户确认
      apiConfigStates.set(userId, { step: 'confirm', data: { url, isConflict: true } })
      await sendToWeixin({ 
        userId, 
        toUser: fromUser, 
        text: '⚠️ 提示\n\n该API供应商可能和官方的API调用相同，调用相同时可能还会出现429限流等问题。\n\n是否继续配置？\n回复 "是" 继续，回复 "否" 取消', 
        contextToken, 
        config: account, 
        disableSplit: true 
      })
      return
    }
    
    // 保存 URL，进入下一步
    apiConfigStates.set(userId, { step: 'key', data: { url } })
    await sendToWeixin({ userId, toUser: fromUser, text: '好的，API 地址已记录！现在请输入你的 API Key（密钥）', contextToken, config: account, disableSplit: true })
    
  } else if (state.step === 'key') {
    // 处理 KEY
    const key = userInput.trim()
    
    if (!key) {
      await sendToWeixin({ userId, toUser: fromUser, text: '请输入你的 API Key', contextToken, config: account, disableSplit: true })
      return
    }
    
    // 保存 KEY，进入下一步
    apiConfigStates.set(userId, { step: 'model', data: { ...state.data, key } })
    await sendToWeixin({ userId, toUser: fromUser, text: '密钥已保存！最后请输入你想使用的模型名称，例如：deepseek-v4-pro、gpt-4o 等', contextToken, config: account, disableSplit: true })
    
  } else if (state.step === 'model') {
    // 处理模型
    const model = userInput.trim()
    
    if (!model) {
      await sendToWeixin({ userId, toUser: fromUser, text: '请输入模型名称', contextToken, config: account, disableSplit: true })
      return
    }
    
    // 保存全部配置
    const { url, key } = state.data
    let currentConfig = loadUserApiConfig(userId) || { enabled: false, apis: [] }
    currentConfig.apis = [{ url, key, model }]
    currentConfig.enabled = true
    saveUserApiConfig(userId, currentConfig)
    
    // 清除状态
    apiConfigStates.delete(userId)
    
    const successText = `✅ API 配置成功！\n\n已保存配置：\n地址: ${url}\n模型: ${model}\n\n现在已切换到自定义 API 模式`
    await sendToWeixin({ userId, toUser: fromUser, text: successText, contextToken, config: account, disableSplit: true })
  }
}

// 处理微信系统命令
async function processSystemCommand(userId, account, fromUser, contextToken, commandText) {
  const originalCmd = commandText.replace(/^[#＃]/, '').trim()
  const cmd = originalCmd.toLowerCase().replace(/\s+/g, '') // 转小写并移除所有空格
  console.log(`[多用户微信机器人] 处理系统命令: ${originalCmd}`)
  
  // 命令1: #清除记忆
  if (cmd.startsWith('清除记忆')) {
    clearMemory(userId)
    await sendToWeixin({ userId, toUser: fromUser, text: '聊天记忆已清除', contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令2: #更改人设 xxxx
  if (cmd.startsWith('更改人设')) {
    // 移除命令前缀，支持任意空格
    let newPersona = originalCmd.replace(/^[#＃]?\s*更改人设\s*/i, '').trim()
    if (newPersona) {
      const personaDir = path.join(getAccountDir(userId), 'persona.md')
      fs.writeFileSync(personaDir, newPersona, 'utf-8')
      await sendToWeixin({ userId, toUser: fromUser, text: '人设已更新', contextToken, config: account, disableSplit: true })
    } else {
      await sendToWeixin({ userId, toUser: fromUser, text: '请在命令后加上人设内容，例如：#更改人设 你是一个温柔的女孩', contextToken, config: account, disableSplit: true })
    }
    return
  }
  
  // 命令3: #当前人设
  if (cmd === '当前人设') {
    const personaDir = path.join(getAccountDir(userId), 'persona.md')
    let personaText = ''
    if (fs.existsSync(personaDir)) {
      personaText = fs.readFileSync(personaDir, 'utf-8')
    }
    if (personaText.trim()) {
      await sendToWeixin({ userId, toUser: fromUser, text: `当前人设:\n\n${personaText}`, contextToken, config: account, disableSplit: true })
    } else {
      await sendToWeixin({ userId, toUser: fromUser, text: '还没有设置人设，请使用 #更改人设 来设置', contextToken, config: account, disableSplit: true })
    }
    return
  }
  
  // 命令4: #我的信息
  if (cmd === '我的信息') {
    const currentAccount = loadAccount(userId)
    const chatMemory = loadMemory(userId)
    const memoriesDir = getMemoriesDir(userId)
    let memoryFilesCount = 0
    if (fs.existsSync(memoriesDir)) {
      const files = fs.readdirSync(memoriesDir).filter(f => f.endsWith('.json'))
      memoryFilesCount = files.length
    }
    
    const autoMsgConfig = getUserAutoMsgConfig(userId)
    const autoMsgEnabled = currentAccount?.[AUTO_MSG_ENABLED_KEY] || false
    
    let infoText = '📋 我的信息\n\n'
    infoText += `QQ ID: ${userId}\n`
    infoText += `微信 ID: ${currentAccount?.accountId || '未知'}\n`
    infoText += `机器人状态: ${accountMonitors.has(userId) ? '🟢 运行中' : '🔴 已停止'}\n`
    infoText += `聊天记录数: ${chatMemory.length}\n`
    infoText += `记忆文件数: ${memoryFilesCount}\n`
    
    if (currentAccount?.createdAt) {
      const date = new Date(currentAccount.createdAt)
      infoText += `注册时间: ${date.toLocaleString('zh-CN')}\n`
    }
    if (currentAccount?.lastActiveAt) {
      const date = new Date(currentAccount.lastActiveAt)
      infoText += `最后活跃: ${date.toLocaleString('zh-CN')}\n`
    }
    
    // 自动发消息状态
    infoText += `\n📬 AI主动发消息\n`
    infoText += `状态: ${autoMsgEnabled ? '✅ 已开启' : '❌ 已关闭'}\n`
    
    if (autoMsgConfig.lastActive > 0) {
      const lastActiveDate = new Date(autoMsgConfig.lastActive)
      const idleTime = Date.now() - autoMsgConfig.lastActive
      infoText += `你最后说话: ${lastActiveDate.toLocaleString('zh-CN')} (${formatTimeDiff(idleTime)}前)\n`
    }
    
    if (autoMsgConfig.lastSent > 0) {
      const lastSentDate = new Date(autoMsgConfig.lastSent)
      infoText += `AI最后主动说: ${lastSentDate.toLocaleString('zh-CN')}\n`
    } else {
      infoText += `AI最后主动说: 从未主动说过\n`
    }
    
    if (autoMsgConfig.lastChatFromUser) {
      infoText += `最后聊天对象: ${autoMsgConfig.lastChatFromUser.substring(0, 20)}...\n`
    }
    
    await sendToWeixin({ userId, toUser: fromUser, text: infoText, contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令5: #切换官方
  if (cmd === '切换官方') {
    let currentConfig = loadUserApiConfig(userId) || {}
    currentConfig.enabled = false
    saveUserApiConfig(userId, currentConfig)
    await sendToWeixin({ userId, toUser: fromUser, text: '已切换为官方提供的API', contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令6: #切换自定义
  if (cmd === '切换自定义') {
    let currentConfig = loadUserApiConfig(userId) || {}
    if (!currentConfig.apis || currentConfig.apis.length === 0) {
      await sendToWeixin({ userId, toUser: fromUser, text: '还没有配置自定义API，请先使用 #配置API 来设置', contextToken, config: account, disableSplit: true })
      return
    }
    currentConfig.enabled = true
    saveUserApiConfig(userId, currentConfig)
    await sendToWeixin({ userId, toUser: fromUser, text: '已切换为使用自定义API', contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令7: #配置API
  if (cmd.startsWith('配置api')) {
    // 开始对话式配置
    apiConfigStates.set(userId, { step: 'url', data: {} })
    await sendToWeixin({ 
      userId, 
      toUser: fromUser, 
      text: '好的，我们来一步步配置API！\n\n第一步，请输入你的API地址\n\n示例：\nhttps://api.example.com\nhttps://api.example.com/v1\n\n随时可以发送 #取消配置 来取消', 
      contextToken, 
      config: account, 
      disableSplit: true 
    })
    return
  }
  
  // 命令8: #我的API
  if (cmd === '我的api') {
    const currentConfig = loadUserApiConfig(userId)
    if (!currentConfig || !currentConfig.apis || currentConfig.apis.length === 0) {
      await sendToWeixin({ userId, toUser: fromUser, text: '还没有配置自定义API', contextToken, config: account, disableSplit: true })
      return
    }
    let apiText = '📋 我的API配置\n\n'
    apiText += `模式: ${currentConfig.enabled ? '🟢 自定义API' : '🔴 官方API'}\n\n`
    for (let i = 0; i < currentConfig.apis.length; i++) {
      const api = currentConfig.apis[i]
      apiText += `${i + 1}. ${api.url}\n   模型: ${api.model}\n`
    }
    await sendToWeixin({ userId, toUser: fromUser, text: apiText, contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令9: #开启AI主动发送消息
  if (cmd === '开启ai主动发送消息' || cmd === '开启自动发送消息') {
    setUserAutoMsgConfig(userId, { [AUTO_MSG_ENABLED_KEY]: true })
    await sendToWeixin({ userId, toUser: fromUser, text: '✅ 已开启AI主动发送消息！\n\n每两小时AI会随机选择时间，主动和你聊天', contextToken, config: account, disableSplit: true })
    return
  }
  
  // 命令10: #关闭AI主动发送消息
  if (cmd === '关闭ai主动发送消息' || cmd === '关闭自动发送消息') {
    setUserAutoMsgConfig(userId, { [AUTO_MSG_ENABLED_KEY]: false })
    await sendToWeixin({ userId, toUser: fromUser, text: '已关闭AI主动发送消息', contextToken, config: account, disableSplit: true })
    return
  }
  
  // 未知命令
  const helpText = '可用命令：\n\n#清除记忆\n#更改人设 [人设内容]\n#当前人设\n#我的信息\n#配置API\n#我的API\n#切换官方\n#切换自定义\n#开启AI主动发送消息\n#关闭AI主动发送消息'
  await sendToWeixin({ userId, toUser: fromUser, text: helpText, contextToken, config: account, disableSplit: true })
}

// 处理合并后的消息
async function processMergedMessages(userId, account, userKey) {
  // 获取并清空队列
  const messages = userMessageQueues.get(userKey) || []
  userMessageQueues.delete(userKey)
  userDebounceTimers.delete(userKey)
  
  if (messages.length === 0) return
  
  console.log(`[多用户微信机器人] ${userKey} 开始处理合并消息，共 ${messages.length} 条`)
  
  // 合并消息
  const mergedText = messages.map(m => m.text).join('\n')
  const lastMessage = messages[messages.length - 1]
  const firstMessage = messages[0]
  const fromUser = firstMessage.fromUser
  const contextToken = lastMessage.contextToken
  
  // 更新账号活跃时间
  const currentAccount = loadAccount(userId)
  if (currentAccount) {
    currentAccount.lastActiveAt = Date.now()
    saveAccount(userId, currentAccount)
  }
  
  // 添加合并后的消息到聊天记录
  addChatLog(userId, 'user', mergedText)
  
  // 生成prompt
  const personaText = loadPersona(userId)
  const history = getChatHistoryString(userId)
  const recentMemories = getRecentMemoriesString(userId, 2)
  const beijingTime = getBeijingTime()
  
  const prompt = `你现在就是这个人，完全按照人设说话，别让人看出你是AI：

【你的人设】
${personaText}

【现在的时间】${beijingTime.full}

${recentMemories ? recentMemories : ''}

【刚才的聊天记录】
${history || ''}

---
用户说：
${mergedText}

回复格式：
1. 先判断这段对话是否重要（重要→true，不重要→false）
2. 然后是你的回复内容
3. 格式：
[重要: true/false]
[你的回复内容]

直接用第一人称回复，自然口语，像真人一样聊天。

注意：
1. 人设优先，完全按人设说
2. 你就是真实存在，不是AI
3. 不要用任何括号（包括（）、[]、<>）来写动作描述，只说纯文本
4. 不要加人名前缀
5. 别编其他角色的话
6. 别重复用户的话，也别编用户没说的
7. 记忆只是让你记住的信息，别当成对话说出来
8. 只回现在的话，别扯别的
9. 日常聊天3-5句，每句别太长
10. 别一直重复旧话题
11. 回复要有结尾，别说半截话
12. 如果有人说你是AI，按人设反应（傲娇就怼，温柔就解释）
13. 重要对话：用户说名字、地址、重要约定、重要事情才是重要，普通闲聊不重要
14. 别主动说换话题，别主动邀请聊别的话题
15. 只回应当前用户说的话，别主动提别的`
  
  console.log('[多用户微信机器人] 调用AI中...')
  const aiResponse = await callAI(prompt, userId)
  console.log('[多用户微信机器人] AI回复:', aiResponse)
  
  if (aiResponse && aiResponse.trim()) {
    // 解析AI回复，提取重要性
    let isImportant = false
    let finalResponse = aiResponse.trim()
    
    // 尝试匹配 [重要: true/false] 格式
    const importantMatch = finalResponse.match(/\[重要\s*:\s*(true|false)\]/i)
    if (importantMatch) {
      isImportant = importantMatch[1].toLowerCase() === 'true'
      finalResponse = finalResponse.replace(importantMatch[0], '').trim()
    }
    
    // 后处理：清理违规内容
    // 1. 无论人设如何，都彻底移除所有括号内容
    finalResponse = finalResponse.replace(/（[^）]*）/g, '') // 中文括号
    finalResponse = finalResponse.replace(/\([^)]*\)/g, '') // 英文括号
    finalResponse = finalResponse.replace(/\[[^\]]*\]/g, '') // 方括号
    finalResponse = finalResponse.replace(/<[^>]*>/g, '') // 尖括号
    
    // 2. 移除人名前缀
    finalResponse = finalResponse.replace(/^[^\n：:]+[：:]\s*/gm, '')
    finalResponse = finalResponse.replace(/^[^\n]+\s+/gm, (match) => {
      if (match.trim().length < 10 && !/[，。！？,.!?]/.test(match)) {
        return ''
      }
      return match
    })
    
    // 3. 移除空行
    finalResponse = finalResponse.replace(/\n\s*\n/g, '\n').trim()
    
    console.log('[多用户微信机器人] 清理后回复:', finalResponse)
    console.log('[多用户微信机器人] 是否保存记忆:', isImportant)
    
    // 如果清理后回复是空的，使用清理标签后的纯文本（去掉[重要:xx]）
    if (!finalResponse || !finalResponse.trim()) {
      // 从原 AI 回复去掉 [重要:xx] 标签
      finalResponse = aiResponse.replace(/\[重要\s*:\s*(true|false)\]/i, '').trim()
    }
    
    addChatLog(userId, 'assistant', finalResponse)
    
    // 只有AI判断重要的才保存记忆
    if (isImportant) {
      const memoryTitle = generateSimpleTitle(mergedText, finalResponse)
      saveMemoryItem(userId, {
        title: memoryTitle,
        importance: 'normal',
        type: 'chat',
        content: `${mergedText}\n---\n${finalResponse}`,
        userText: mergedText,
        assistantText: finalResponse
      })
    }
    
    console.log('[多用户微信机器人] 准备发送微信消息...')
    await sendToWeixin({
      userId,
      toUser: fromUser,
      text: finalResponse,
      contextToken: lastMessage.contextToken,
      config: account
    })
    console.log('[多用户微信机器人] 微信消息发送完成')
  } else {
    // AI调用失败，发个可爱的消息，但不存记忆
    const cuteFailureMsg = '嗷呜~对话被风云吃掉啦🥺'
    console.log('[多用户微信机器人] 发送失败消息:', cuteFailureMsg)
    await sendToWeixin({
      userId,
      toUser: fromUser,
      text: cuteFailureMsg,
      contextToken: lastMessage.contextToken,
      config: account,
      disableSplit: true
    })
  }
}

let existingAccountsLoaded = false

export class AI_MultiUser_Bot extends plugin {
  constructor() {
    super({
      name: '多用户微信机器人',
      dsc: '多用户独立登录微信，独立人设配置和聊天记忆',
      event: 'message', priority: 4000,
      rule: [
        { reg: '^[#＃]\\s*登[陆录]\\s*微信\\s*[Aa][Ii]$', fnc: 'loginWeixin' },
        { reg: '^[#＃]\\s*微信\\s*登[陆录]\\s*[Aa][Ii]$', fnc: 'loginWeixin' },
        { reg: '^[#＃]\\s*更改\\s*人设', fnc: 'changePersona' },
        { reg: '^[#＃]\\s*当前\\s*人设$', fnc: 'showCurrentPersona' },
        { reg: '^[#＃]\\s*清除\\s*记忆$', fnc: 'clearMemoryCmd' },
        { reg: '^[#＃]\\s*我的\\s*信息$', fnc: 'showMyInfo' },
        { reg: '^[#＃]\\s*站点\\s*状态$', fnc: 'showApiStatus' },
        { reg: '^[#＃]\\s*微信\\s*机器人\\s*在线\\s*列表$', fnc: 'listOnlineBots' },
        { reg: '^[#＃]\\s*在线\\s*用户$', fnc: 'showOnlineUsers' },
        { reg: '^[#＃]\\s*停止\\s*机器人', fnc: 'stopBot' },
        { reg: '^[#＃]\\s*启动\\s*机器人', fnc: 'startBot' },
        { reg: '^[#＃]\\s*删除\\s*机器人', fnc: 'deleteBot' },
        { reg: '^[#＃]\\s*关于$', fnc: 'showAbout' },
        { reg: '^[#＃]\\s*推广$', fnc: 'showPromotion' },
        { reg: '^[#＃]\\s*帮助\\s*多用户$', fnc: 'showHelp' },
        { reg: '^[#＃]\\s*微信\\s*机器人\\s*登录', fnc: 'adminLoginWeixin' },
        { reg: '^[#＃]\\s*查询\\s*用户', fnc: 'queryUser' },
        { reg: '^[#＃]\\s*预知\\s*下次\\s*主动\\s*发送$', fnc: 'predictNextAutoMsg' }
      ]
    })
    
    if (!existingAccountsLoaded) {
      existingAccountsLoaded = true
      this.loadExistingAccounts()
    }
  }
  
  loadExistingAccounts() {
    const accounts = getAllAccounts()
    console.log(`[多用户微信机器人] 找到 ${accounts.length} 个已登录账号`)
    
    for (const account of accounts) {
      if (account.token && account.enabled) {
        startAccountMonitor(account.userId, account)
      }
    }
    
    // 启动自动发消息定时器
    startAutoMsgTimer()
  }
  
  async loginWeixin() {
    const userId = this.e.user_id
    const messageId = this.e.message_id
    const result = await startWeixinLogin(userId, this, messageId)
    
    if (result.status === 'success' || result.status === 'exists') {
      // 先发送带艾特和引用的文本
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        result.message
      ])
      
      try {
        const filename = `qrcode_${userId}_${Date.now()}.png`
        const filepath = path.join(TEMP_DIR, filename)
        
        await screenshotUrl(result.qrcodeUrl, filepath)
        
        // 发送带艾特和引用的图片
        await this.reply([
          segment.reply(messageId),
          segment.at(userId),
          ' ',
          segment.image(filepath)
        ])
        
        setTimeout(() => {
          try { fs.unlinkSync(filepath) } catch (e) { }
        }, 120000)
      } catch (e) {
        console.error('[多用户微信机器人] 发送失败', e)
        await this.reply([
          segment.reply(messageId),
          segment.at(userId),
          ' ',
          result.qrcodeUrl
        ])
      }
    } else {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        result.message
      ])
    }
    
    return true
  }
  
  async listOnlineBots() {
    const accounts = getAllAccounts()
    
    if (accounts.length === 0) {
      await this.reply('没有账号')
      return true
    }
    
    // 构建消息数组
    const messages = []
    
    // 第一条：上半部分
    const halfIndex = Math.ceil(accounts.length / 2)
    const part1 = accounts.slice(0, halfIndex)
    let replyText1 = '在线机器人列表（上半部分）:\n\n'
    for (const account of part1) {
      const isRunning = accountMonitors.has(account.userId)
      replyText1 += `ID: ${account.userId}\n`
      replyText1 += `状态: ${isRunning ? '🟢 运行中' : '🔴 已停止'}\n`
      replyText1 += `微信ID: ${account.accountId || '未知'}\n`
      replyText1 += '---\n'
    }
    messages.push(replyText1)
    
    // 第二条：下半部分
    if (halfIndex < accounts.length) {
      const part2 = accounts.slice(halfIndex)
      let replyText2 = '在线机器人列表（下半部分）:\n\n'
      for (const account of part2) {
        const isRunning = accountMonitors.has(account.userId)
        replyText2 += `ID: ${account.userId}\n`
        replyText2 += `状态: ${isRunning ? '🟢 运行中' : '🔴 已停止'}\n`
        replyText2 += `微信ID: ${account.accountId || '未知'}\n`
        replyText2 += '---\n'
      }
      messages.push(replyText2)
    }
    
    // 用转发消息发送
    const forwardMsg = await common.makeForwardMsg(this.e, messages, '在线机器人列表')
    await this.reply(forwardMsg)
    
    return true
  }
  
  async showApiStatus() {
    const config = loadPluginConfig()
    if (!config || !config.apis) {
      await this.reply('未找到配置')
      return true
    }
    
    await this.reply('正在检查站点状态，请稍候...')
    
    // 检查每个API
    const statusList = []
    for (let i = 0; i < config.apis.length; i++) {
      const api = config.apis[i]
      const ok = await checkApiHealth(api)
      statusList.push({
        index: i + 1,
        url: api.url,
        model: api.model,
        ok
      })
    }
    
    // 分类
    const online = statusList.filter(s => s.ok)
    const offline = statusList.filter(s => !s.ok)
    
    // 构建回复
    let reply = '📍 站点状态\n\n'
    
    reply += `🟢 在线站点 (${online.length}个):\n`
    for (const s of online) {
      reply += `  ${s.index}号: ${s.model}\n`
    }
    
    reply += `\n🔴 离线站点 (${offline.length}个):\n`
    for (const s of offline) {
      reply += `  ${s.index}号: ${s.model}\n`
    }
    
    reply += '\n📄 详细信息:\n'
    for (const s of statusList) {
      const status = s.ok ? '🟢 在线' : '🔴 离线'
      reply += `${s.index}号: ${status} | 模型: ${s.model}\n`
    }
    
    await this.reply(reply)
    return true
  }
  
  async showOnlineUsers() {
    const accounts = getAllAccounts()
    
    let onlineText = ''
    let offlineText = ''
    let onlineCount = 0
    let offlineCount = 0
    
    for (const account of accounts) {
      const isRunning = accountMonitors.has(account.userId)
      if (isRunning) {
        onlineText += `${account.userId} (微信: ${account.accountId || '未知'})\n`
        onlineCount++
      } else {
        offlineText += `${account.userId} (微信: ${account.accountId || '未知'})\n`
        offlineCount++
      }
    }
    
    // 构建三段消息
    const msg1 = `📊 机器人在线情况\n\n🟢 在线: ${onlineCount} 人\n🔴 离线: ${offlineCount} 人`
    const msg2 = onlineCount > 0 
      ? `🟢 在线用户:\n\n${onlineText}` 
      : '🟢 在线用户:\n\n(暂无)'
    const msg3 = offlineCount > 0 
      ? `🔴 离线用户:\n\n${offlineText}` 
      : '🔴 离线用户:\n\n(暂无)'
    
    // 用转发消息发送
    const forwardMsg = await common.makeForwardMsg(this.e, [msg1, msg2, msg3], '机器人在线状态')
    await this.reply(forwardMsg)
    return true
  }
  
  async stopBot() {
    const args = this.e.msg.replace('#停止机器人', '').trim()
    const targetUserId = args || this.e.user_id
    
    const account = loadAccount(targetUserId)
    if (!account) {
      await this.reply('未找到该账号')
      return true
    }
    
    stopAccountMonitor(targetUserId)
    
    account.enabled = false
    saveAccount(targetUserId, account)
    
    await this.reply('账号已停止')
    return true
  }
  
  async startBot() {
    const args = this.e.msg.replace('#启动机器人', '').trim()
    const targetUserId = args || this.e.user_id
    
    const account = loadAccount(targetUserId)
    if (!account || !account.token) {
      await this.reply('未找到该账号或未登录')
      return true
    }
    
    account.enabled = true
    saveAccount(targetUserId, account)
    
    startAccountMonitor(targetUserId, account)
    
    await this.reply('账号已启动')
    return true
  }
  
  async deleteBot() {
    const args = this.e.msg.replace('#删除机器人', '').trim()
    const targetUserId = args || this.e.user_id
    
    stopAccountMonitor(targetUserId)
    deleteAccountDir(targetUserId)
    
    await this.reply('账号已删除')
    return true
  }

  async clearMemoryCmd() {
    const userId = this.e.user_id
    const account = loadAccount(userId)
    
    if (!account || !account.token) {
      await this.reply('未找到账号或未登录，请先发送 #登录微信AI 登录')
      return true
    }
    
    clearMemory(userId)
    
    await this.reply('聊天记忆已清除')
    return true
  }

  async showMyInfo() {
    const userId = this.e.user_id
    const account = loadAccount(userId)
    
    if (!account || !account.token) {
      await this.reply('您当前未注册机器人，请先发送 #登录微信AI 登录')
      return true
    }
    
    const now = Date.now()
    const isOnline = accountMonitors.has(userId)
    
    const chatMem = loadMemory(userId)
    let totalMsgs = chatMem.length
    let userMsgs = 0
    let assistantMsgs = 0
    for (const msg of chatMem) {
      if (msg.role === 'user') userMsgs++
      else if (msg.role === 'assistant') assistantMsgs++
    }
    
    const allMemories = getAllMemories(userId)
    const memoryCount = allMemories.length
    
    const createdAt = account.createdAt || now
    const lastActiveAt = account.lastActiveAt || createdAt
    
    const daysSinceCreation = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24))
    const daysSinceLastActive = Math.floor((now - lastActiveAt) / (1000 * 60 * 60 * 24))
    
    const autoMsgConfig = getUserAutoMsgConfig(userId)
    const autoMsgEnabled = account[AUTO_MSG_ENABLED_KEY] || false
    
    let infoText = '📊 我的信息\n'
    infoText += '────────────────\n'
    infoText += `QQ号：${userId}\n`
    if (account.age) {
      infoText += `年龄：${account.age}\n`
    }
    infoText += '────────────────\n'
    infoText += `🤖 机器人信息\n`
    infoText += `机器人ID：${account.accountId || '未知'}\n`
    infoText += `在线状态：${isOnline ? '🟢 在线' : '🔴 离线'}\n`
    infoText += '────────────────\n'
    infoText += `💬 对话统计\n`
    infoText += `总消息数：${totalMsgs} 条\n`
    infoText += `你发送：${userMsgs} 条\n`
    infoText += `机器人回复：${assistantMsgs} 条\n`
    infoText += '────────────────\n'
    infoText += `⏰ 时间统计\n`
    infoText += `认识天数：${daysSinceCreation} 天\n`
    infoText += `距上次在线：${daysSinceLastActive} 天\n`
    infoText += '────────────────\n'
    infoText += `🧠 记忆条数：${memoryCount} 条\n`
    infoText += '────────────────\n'
    infoText += `📬 AI主动发消息\n`
    infoText += `状态：${autoMsgEnabled ? '✅ 已开启' : '❌ 已关闭'}\n`
    
    if (autoMsgConfig.lastActive > 0) {
      const lastActiveDate = new Date(autoMsgConfig.lastActive)
      const idleTime = Date.now() - autoMsgConfig.lastActive
      infoText += `你最后说话：${lastActiveDate.toLocaleString('zh-CN')} (${formatTimeDiff(idleTime)}前)\n`
    }
    
    if (autoMsgConfig.lastSent > 0) {
      const lastSentDate = new Date(autoMsgConfig.lastSent)
      infoText += `AI最后主动说：${lastSentDate.toLocaleString('zh-CN')}\n`
    } else {
      infoText += `AI最后主动说：从未主动说过\n`
    }
    
    if (autoMsgConfig.lastChatFromUser) {
      infoText += `最后聊天对象：${autoMsgConfig.lastChatFromUser.substring(0, 20)}...\n`
    }
    
    await this.reply(infoText)
    return true
  }

  async changePersona() {
    const userId = this.e.user_id
    const messageId = this.e.message_id
    const account = loadAccount(userId)
    
    if (!account || !account.token) {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '未找到账号或未登录，请先发送 #登录微信AI 登录'
      ])
      return true
    }
    
    const isRunning = accountMonitors.has(userId)
    if (!isRunning) {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '账号未运行，请先发送 #启动机器人 启动账号'
      ])
      return true
    }
    
    console.log('[多用户微信机器人] changePersona 开始处理')
    console.log('[多用户微信机器人] this.e.message:', JSON.stringify(this.e.message))
    console.log('[多用户微信机器人] this.e.msg:', JSON.stringify(this.e.msg))
    
    // 获取完整的人设内容
    let newPersona = ''
    
    // 方式1: 尝试使用 this.e.message 数组格式（最完整）
    if (this.e.message && Array.isArray(this.e.message)) {
      console.log('[多用户微信机器人] 使用 this.e.message 数组格式')
      
      // 检查是否有多个文本段
      const msgParts = []
      for (const seg of this.e.message) {
        if (seg.type === 'text' && seg.text !== undefined) {
          console.log('[多用户微信机器人] 找到文本段:', JSON.stringify(seg.text))
          msgParts.push(seg.text)
        }
      }
      
      if (msgParts.length > 0) {
        // 直接用每个文本段拼接，保持原样
        const fullMsg = msgParts.join('')
        console.log('[多用户微信机器人] 拼接后的完整消息:', JSON.stringify(fullMsg))
        
        // 找到 #更改人设 的位置
        const commandIndex = fullMsg.indexOf('#更改人设')
        if (commandIndex !== -1) {
          // 提取命令后的所有内容，不要 trim()，保留换行和首尾空格
          newPersona = fullMsg.substring(commandIndex + '#更改人设'.length)
          console.log('[多用户微信机器人] 提取到的人设内容:', JSON.stringify(newPersona))
        } else {
          // 没有找到命令，使用全部内容
          newPersona = fullMsg
        }
      }
    }
    
    // 方式2: 尝试使用 this.e.msg
    if (!newPersona && this.e.msg) {
      console.log('[多用户微信机器人] 回退到使用 this.e.msg')
      console.log('[多用户微信机器人] this.e.msg:', JSON.stringify(this.e.msg))
      
      const commandIndex = this.e.msg.indexOf('#更改人设')
      if (commandIndex !== -1) {
        newPersona = this.e.msg.substring(commandIndex + '#更改人设'.length)
      } else {
        newPersona = this.e.msg
      }
    }
    
    console.log('[多用户微信机器人] 最终人设内容（长度:', newPersona.length, '）:', JSON.stringify(newPersona))
    
    // 检查人设内容是否有效
    if (!newPersona || newPersona.trim() === '') {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '请输入人设内容，格式：\n#更改人设 你的人设内容\n\n提示：支持多行、任意长度的人设'
      ])
      return true
    }
    
    // 保存人设
    savePersona(userId, newPersona)
    console.log('[多用户微信机器人] 人设已保存')
    
    await this.reply([
      segment.reply(messageId),
      segment.at(userId),
      ' ',
      '人设已更新！立即生效'
    ])
    return true
  }
  
  async showCurrentPersona() {
    const userId = this.e.user_id
    const account = loadAccount(userId)
    
    if (!account || !account.token) {
      await this.reply('未找到账号或未登录，请先发送 #登录微信AI 登录')
      return true
    }
    
    const persona = loadPersona(userId)
    
    let response = '👤 当前人设\n'
    response += '────────────────\n'
    response += persona
    
    await this.reply(response)
    return true
  }
  
  async showPromotion() {
    await this.reply(
      `🎉 推广计划\n\n💫 如果你喜欢这个机器人，欢迎帮我们宣传！\n\n📱 如何推广\n1. 截取一张你和机器人聊天的图片，或录制一段视频\n2. 发布到抖音、快手等平台\n3. 在视频或文案中 @风云云\n4. 抖音号：35380349051\n5. 快手号：Japappp1\n\n🎁 推广文案参考\n「发现一个超级好玩的微信机器人！\n可以自己设定人设，聊天像真人一样！\n完全免费使用，快来试试吧！」\n\n🙏 感谢支持\n你的每一次分享都是对我们最大的认可！\n让更多人发现这个有趣的项目吧！`
    )
    return true
  }
  
  async showAbout() {
    await this.reply(
      `🌸 关于多用户微信机器人\n\n👤 开发者\n本插件由 风云科技 开发制作，专注于打造优秀的智能机器人体验！\n\n📋 项目介绍\n这是一个基于 XRK-AGT 框架的多用户微信机器人系统，支持独立登录、独立人设配置和聊天记忆管理。\n\n🛠️ 技术框架\n- XRK-AGT - 智能机器人框架\n- OpenClaw Weixin API - 微信消息接口\n- 完全使用 JavaScript 开发\n\n📜 开源说明\n本项目采用 MIT 许可证开源，**完全免费！**\n任何人都可以自由使用、修改和分发。\n\n🎯 项目仓库\n- 依赖框架: https://github.com/sunflowermm/XRK-AGT\n- 插件仓库: https://github.com/fengyun0608/AI-MultiUser-Core\n\n💡 功能特点\n✅ 多用户独立登录\n✅ 独立人设配置\n✅ 聊天记忆管理\n✅ 智能记忆系统\n✅ 完全免费使用\n\n💖 祝您使用愉快！`
    )
    return true
  }
  
  async showHelp() {
    await this.reply(
      `多用户微信机器人帮助:\n\n📱 登录与人设\n#登录微信AI - 获取二维码登录微信\n#微信机器人登录 <名称> - 管理员通过名称登录（绑定到当前QQ）\n#更改人设 人设内容 - 修改自己的人设（需已登录并运行）\n  （支持多行、任意长度的人设内容）\n\n📝 人设与记忆\n#当前人设 - 查看当前人设（需已登录）\n#清除记忆 - 清除自己的聊天记忆（需已登录）\n#我的信息 - 查看个人信息和统计数据（需已登录）\n#查询用户 <名称/QQ号> - 查询用户绑定关系\n\n🤖 机器人管理\n#微信机器人在线列表 - 查看所有账号状态\n#停止机器人 [用户ID] - 停止指定账号\n#启动机器人 [用户ID] - 启动指定账号\n#删除机器人 [用户ID] - 删除账号\n\n📅 其他功能\n#预知下次主动发送 - 查看下次 AI 主动发消息的时间（需已开启）\n#站点状态 - 查看 API 站点状态\n#关于 - 查看项目信息和开源说明\n#推广 - 查看推广计划，帮我们宣传\n#帮助多用户 - 查看此帮助\n\n普通用户: #登录微信AI 登录自己的微信\n主人: 可以管理所有账号`
    )
    return true
  }
  
  async adminLoginWeixin() {
    const cmd = this.e.msg.replace('#微信机器人登录', '').replace('＃微信机器人登录', '').trim()
    
    if (!cmd) {
      await this.reply('请输入要绑定的名称，格式：\n#微信机器人登录 <名称>')
      return true
    }
    
    const name = cmd
    const userId = this.e.user_id.toString()
    
    // 检查名称是否已被绑定
    const bindings = loadNameBindings()
    
    if (bindings[name] && bindings[name] !== userId) {
      await this.reply('该名称已被其他用户绑定')
      return true
    }
    
    // 保存绑定
    bindings[name] = userId
    saveNameBindings(bindings)
    
    // 开始登录
    const messageId = this.e.message_id
    const result = await startWeixinLogin(userId, this, messageId)
    
    if (result.status === 'success' || result.status === 'exists') {
      // 先发送带艾特和引用的文本
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        result.message
      ])
      
      try {
        const filename = `qrcode_${userId}_${Date.now()}.png`
        const filepath = path.join(TEMP_DIR, filename)
        
        await screenshotUrl(result.qrcodeUrl, filepath)
        
        // 发送带艾特和引用的图片
        await this.reply([
          segment.reply(messageId),
          segment.at(userId),
          ' ',
          segment.image(filepath)
        ])
        
        setTimeout(() => {
          try { fs.unlinkSync(filepath) } catch (e) {}
        }, 120000)
      } catch (e) {
        console.error('[多用户微信机器人] 发送失败', e)
        await this.reply([
          segment.reply(messageId),
          segment.at(userId),
          ' ',
          result.qrcodeUrl
        ])
      }
    } else {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        result.message
      ])
    }
    
    return true
  }
  
  async queryUser() {
    const cmd = this.e.msg.replace('#查询用户', '').replace('＃查询用户', '').trim()
    
    if (!cmd) {
      await this.reply('请输入要查询的名称或QQ号，格式：\n#查询用户 <名称/QQ号>')
      return true
    }
    
    const bindings = loadNameBindings()
    const query = cmd.trim()
    
    let result = ''
    
    // 检查是否是数字（QQ号）
    if (/^\d+$/.test(query)) {
      // 查询QQ号对应的名称
      const qq = query
      const foundNames = []
      for (const [name, id] of Object.entries(bindings)) {
        if (id === qq) {
          foundNames.push(name)
        }
      }
      
      if (foundNames.length > 0) {
        result = '🔍 查询结果\n────────────────\n'
        result += `QQ号：${qq}\n`
        result += `绑定名称：${foundNames.join('、')}\n`
      } else {
        result = '未找到该QQ号的绑定记录'
      }
    } else {
      // 查询名称对应的QQ号
      const name = query
      if (bindings[name]) {
        const account = loadAccount(bindings[name])
        const isOnline = accountMonitors.has(bindings[name])
        
        result = '🔍 查询结果\n────────────────\n'
        result += `名称：${name}\n`
        result += `QQ号：${bindings[name]}\n`
        
        if (account) {
          result += `机器人ID：${account.accountId || '未知'}\n`
          result += `在线状态：${isOnline ? '🟢 在线' : '🔴 离线'}\n`
        } else {
          result += `状态：未登录\n`
        }
      } else {
        result = '未找到该名称的绑定记录'
      }
    }
    
    await this.reply(result)
    return true
  }
  
  async predictNextAutoMsg() {
    const userId = this.e.user_id
    const messageId = this.e.message_id
    
    // 检查是否登录了微信
    const account = loadAccount(userId)
    if (!account) {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '您还没有注册微信机器人，请先发送 #登录微信AI'
      ])
      return true
    }
    
    // 检查是否开启了自动发消息
    const autoMsgEnabled = account[AUTO_MSG_ENABLED_KEY] || false
    if (!autoMsgEnabled) {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '您还没有开启 AI 主动发送消息功能\n请先在微信中发送 #开启AI主动发送消息'
      ])
      return true
    }
    
    // 检查是否有下次发送时间
    if (!nextAutoMsgTime) {
      await this.reply([
        segment.reply(messageId),
        segment.at(userId),
        ' ',
        '还没有安排下次主动发消息的时间，请稍后再试'
      ])
      return true
    }
    
    // 计算剩余时间
    const now = new Date()
    const diff = nextAutoMsgTime - now
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((diff % (1000 * 60)) / 1000)
    
    let timeText = ''
    if (hours > 0) timeText += `${hours}小时`
    if (minutes > 0) timeText += `${minutes}分钟`
    if (seconds > 0) timeText += `${seconds}秒`
    if (!timeText) timeText = '即将'
    
    const result = `📅 下次主动发消息\n────────────────\n时间：${nextAutoMsgTime.toLocaleString('zh-CN')}\n剩余：${timeText}`
    
    await this.reply([
      segment.reply(messageId),
      segment.at(userId),
      ' ',
      result
    ])
    return true
  }
}
