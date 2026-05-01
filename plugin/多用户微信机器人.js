import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer'

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

// 限流控制：更宽松的设置
let apiRequestTimes = []
const MAX_REQUESTS_PER_MINUTE = 240 // 3个API，每个80次
const MIN_INTERVAL_PER_USER = 3000 // 同一个用户至少间隔3秒

// 记录每个用户最后请求时间
const userLastRequestTimes = new Map()

// API轮询索引
let currentApiIndex = 0

function checkRateLimit(userId) {
  // 先检查用户最小间隔
  const now = Date.now()
  const lastTime = userLastRequestTimes.get(userId)
  if (lastTime && now - lastTime < MIN_INTERVAL_PER_USER) {
    console.log(`[多用户微信机器人] ${userId} 请求太快，跳过`)
    return false
  }
  
  // 再检查全局限流
  const oneMinuteAgo = now - 60 * 1000
  apiRequestTimes = apiRequestTimes.filter(t => t > oneMinuteAgo)
  if (apiRequestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
    console.log('[多用户微信机器人] 全局限流已达上限，跳过')
    return false
  }
  
  return true
}

function addRateLimit(userId) {
  const now = Date.now()
  userLastRequestTimes.set(userId, now)
  apiRequestTimes.push(now)
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

async function startWeixinLogin(userId, pluginInstance) {
  const sessionKey = userId
  
  purgeExpiredLogins()
  
  const existing = activeLogins.get(sessionKey)
  if (existing && isLoginFresh(existing)) {
    return { status: 'exists', qrcodeUrl: existing.qrcodeUrl, message: '二维码已就绪，请使用微信扫描' }
  }
  
  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE)
    console.log('[多用户微信机器人] 二维码获取成功')
    
    const login = {
      userId,
      qrcode: qrResponse.qrcode, qrcodeUrl: qrResponse.qrcode_img_content, startedAt: Date.now(),
      currentApiBaseUrl: FIXED_BASE_URL, status: 'wait', pluginInstance,
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
            if (login.pluginInstance) {
              await login.pluginInstance.reply('已扫码，请在微信中确认登录！')
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
            if (login.pluginInstance) {
              await login.pluginInstance.reply('二维码已过期，请重新发送 #登录微信AI')
            }
          } catch (e) {}
          activeLogins.delete(sessionKey)
          break
          
        case 'confirmed':
          if (!statusResponse.ilink_bot_id) {
            console.error('[多用户微信机器人] 登录成功但缺少 ilink_bot_id')
            try {
              if (login.pluginInstance) {
                await login.pluginInstance.reply('登录失败：未获取到账号信息')
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
            if (login.pluginInstance) {
              let replyMsg = '✅ 登录成功！微信机器人已启动！\n\n'
              replyMsg += '💡 提示：现在可以发送 #更改人设 来设置你的专属人设哦！\n'
              replyMsg += '（也可以发送 #当前人设 查看当前人设）'
              await login.pluginInstance.reply(replyMsg)
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
  // 先检查限流
  if (!checkRateLimit(userId)) {
    return null
  }
  
  const config = loadPluginConfig()
  if (!config || !config.apis || config.apis.length === 0) {
    console.error('[多用户微信机器人] 插件配置未找到')
    return null
  }

  // 尝试所有API，直到成功
  for (let i = 0; i < config.apis.length; i++) {
    const apiIndex = (currentApiIndex + i) % config.apis.length
    const api = config.apis[apiIndex]
    
    console.log(`[多用户微信机器人] 尝试API: ${apiIndex}`)
    
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
          temperature: config.temperature || 0.7,
          max_tokens: config.maxTokens || 1000
        })
      })

      if (response.ok) {
        const data = await response.json()
        const result = data.choices?.[0]?.message?.content
        
        if (result) {
          // 成功了，更新索引，记录限流
          currentApiIndex = apiIndex + 1
          addRateLimit(userId)
          console.log(`[多用户微信机器人] API ${apiIndex} 调用成功`)
          return result
        }
      } else {
        const errorText = await response.text()
        console.warn(`[多用户微信机器人] API ${apiIndex} 失败: ${response.status}`, errorText)
      }
    } catch (e) {
      console.warn(`[多用户微信机器人] API ${apiIndex} 异常:`, e.message)
    }
  }
  
  // 所有API都失败了
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
  
  return segments.slice(0, 10).length > 0 ? segments.slice(0, 10) : [text.trim()]
}

async function sendToWeixin({ userId, toUser, text, contextToken, config }) {
  try {
    if (!text || !text.trim()) return
    
    const segments = splitTextToSegments(text)
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
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
  
  if (text && text.trim() && !text.trim().startsWith('#')) {
    const fromUser = msg.from_user_id
    const contextToken = msg.context_token
    
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
    
  } else {
    console.log('[多用户微信机器人] 跳过处理，text为空或为命令')
  }
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
  
  // 检查人设是否要求使用动作描述
  const allowActions = /动作|（|）|\(|\)/.test(personaText)
  
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
3. ${allowActions ? '可以用动作描述' : '只说纯文本，不要加动作描述括号'}
4. 不要加人名前缀
5. 别编其他角色的话
6. 别重复用户的话，也别编用户没说的
7. 记忆只是让你记住的信息，别当成对话说出来
8. 只回现在的话，别扯别的
9. 日常聊天3-5句，每句别太长
10. 别一直重复旧话题
11. 回复要有结尾，别说半截话
12. 如果有人说你是AI，按人设反应（傲娇就怼，温柔就解释）
13. 重要对话：用户说名字、地址、重要约定、重要事情才是重要，普通闲聊不重要`
  
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
    // 1. 只有当人设不允许动作时，才移除括号内容
    if (!allowActions) {
      finalResponse = finalResponse.replace(/（[^）]*）/g, '') // 中文括号
      finalResponse = finalResponse.replace(/\([^)]*\)/g, '') // 英文括号
    }
    
    // 2. 移除人名前缀（比如 "纪文川 操" → "操"）
    finalResponse = finalResponse.replace(/^[^\n：:]+[：:]\s*/gm, '')
    finalResponse = finalResponse.replace(/^[^\n]+\s+/gm, (match) => {
      // 如果看起来像是人名（不长，没有标点），就移除
      if (match.trim().length < 10 && !/[，。！？,.!?]/.test(match)) {
        return ''
      }
      return match
    })
    
    // 3. 移除空行
    finalResponse = finalResponse.replace(/\n\s*\n/g, '\n').trim()
    
    console.log('[多用户微信机器人] 清理后回复:', finalResponse)
    console.log('[多用户微信机器人] 是否保存记忆:', isImportant)
    
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
      config: account
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
        { reg: '^[#＃]登[陆录]微信[Aa][Ii]$', fnc: 'loginWeixin' },
        { reg: '^[#＃]微信登[陆录][Aa][Ii]$', fnc: 'loginWeixin' },
        { reg: '^[#＃]更改人设', fnc: 'changePersona' },
        { reg: '^[#＃]当前人设$', fnc: 'showCurrentPersona' },
        { reg: '^[#＃]清除记忆$', fnc: 'clearMemoryCmd' },
        { reg: '^[#＃]我的信息$', fnc: 'showMyInfo' },
        { reg: '^[#＃]微信机器人在线列表$', fnc: 'listOnlineBots' },
        { reg: '^[#＃]在线用户$', fnc: 'showOnlineUsers' },
        { reg: '^[#＃]停止机器人(.*)$', fnc: 'stopBot' },
        { reg: '^[#＃]启动机器人(.*)$', fnc: 'startBot' },
        { reg: '^[#＃]删除机器人(.*)$', fnc: 'deleteBot' },
        { reg: '^[#＃]关于$', fnc: 'showAbout' },
        { reg: '^[#＃]推广$', fnc: 'showPromotion' },
        { reg: '^[#＃]帮助多用户$', fnc: 'showHelp' }
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
  }
  
  async loginWeixin() {
    const userId = this.e.user_id
    const result = await startWeixinLogin(userId, this)
    
    if (result.status === 'success' || result.status === 'exists') {
      await this.reply(result.message)
      
      try {
        const filename = `qrcode_${userId}_${Date.now()}.png`
        const filepath = path.join(TEMP_DIR, filename)
        
        await screenshotUrl(result.qrcodeUrl, filepath)
        await this.reply(segment.image(filepath))
        
        setTimeout(() => {
          try { fs.unlinkSync(filepath) } catch (e) { }
        }, 120000)
      } catch (e) {
        console.error('[多用户微信机器人] 发送失败', e)
        await this.reply(result.qrcodeUrl)
      }
    } else {
      await this.reply(result.message)
    }
    
    return true
  }
  
  async listOnlineBots() {
    const accounts = getAllAccounts()
    
    if (accounts.length === 0) {
      await this.reply('没有账号')
      return true
    }
    
    // 分成两条消息发送，避免太长
    const halfIndex = Math.ceil(accounts.length / 2)
    const part1 = accounts.slice(0, halfIndex)
    const part2 = accounts.slice(halfIndex)
    
    // 第一条消息
    let replyText1 = '在线机器人列表（上半部分）:\n\n'
    for (const account of part1) {
      const isRunning = accountMonitors.has(account.userId)
      replyText1 += `ID: ${account.userId}\n`
      replyText1 += `状态: ${isRunning ? '🟢 运行中' : '🔴 已停止'}\n`
      replyText1 += `微信ID: ${account.accountId || '未知'}\n`
      replyText1 += '---\n'
    }
    await this.reply(replyText1)
    
    // 第二条消息
    if (part2.length > 0) {
      let replyText2 = '在线机器人列表（下半部分）:\n\n'
      for (const account of part2) {
        const isRunning = accountMonitors.has(account.userId)
        replyText2 += `ID: ${account.userId}\n`
        replyText2 += `状态: ${isRunning ? '🟢 运行中' : '🔴 已停止'}\n`
        replyText2 += `微信ID: ${account.accountId || '未知'}\n`
        replyText2 += '---\n'
      }
      await this.reply(replyText2)
    }
    
    return true
  }
  
  async showOnlineUsers() {
    const accounts = getAllAccounts()
    
    let onlineText = '🟢 在线用户:\n'
    let offlineText = '🔴 离线用户:\n'
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
    
    let finalReply = `📊 机器人在线情况\n\n`
    finalReply += `🟢 在线: ${onlineCount} 人\n`
    finalReply += `🔴 离线: ${offlineCount} 人\n\n`
    
    if (onlineCount > 0) {
      finalReply += `${onlineText}\n`
    }
    
    if (offlineCount > 0) {
      finalReply += `${offlineText}\n`
    }
    
    if (accounts.length === 0) {
      finalReply += '没有任何账号'
    }
    
    await this.reply(finalReply)
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
    
    await this.reply(infoText)
    return true
  }

  async changePersona() {
    const userId = this.e.user_id
    const account = loadAccount(userId)
    
    if (!account || !account.token) {
      await this.reply('未找到账号或未登录，请先发送 #登录微信AI 登录')
      return true
    }
    
    const isRunning = accountMonitors.has(userId)
    if (!isRunning) {
      await this.reply('账号未运行，请先发送 #启动机器人 启动账号')
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
      await this.reply('请输入人设内容，格式：\n#更改人设 你的人设内容\n\n提示：支持多行、任意长度的人设')
      return true
    }
    
    // 保存人设
    savePersona(userId, newPersona)
    console.log('[多用户微信机器人] 人设已保存')
    
    await this.reply('人设已更新！立即生效')
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
      `多用户微信机器人帮助:\n\n📱 登录与人设\n#登录微信AI - 获取二维码登录微信\n#更改人设 人设内容 - 修改自己的人设（需已登录并运行）\n  （支持多行、任意长度的人设内容）\n\n📝 人设与记忆\n#当前人设 - 查看当前人设（需已登录）\n#清除记忆 - 清除自己的聊天记忆（需已登录）\n#我的信息 - 查看个人信息和统计数据（需已登录）\n\n🤖 机器人管理\n#微信机器人在线列表 - 查看所有账号状态\n#停止机器人 [用户ID] - 停止指定账号\n#启动机器人 [用户ID] - 启动指定账号\n#删除机器人 [用户ID] - 删除账号\n\n📖 其他\n#关于 - 查看项目信息和开源说明\n#推广 - 查看推广计划，帮我们宣传\n#帮助多用户 - 查看此帮助\n\n普通用户: #登录微信AI 登录自己的微信\n主人: 可以管理所有账号`
    )
    return true
  }
}
