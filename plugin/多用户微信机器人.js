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
          
          startAccountMonitor(sessionKey, account)
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
      console.error(`[多用户微信机器人] ${userId} 消息监听出错`, err.message)
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

function getRecentMemoriesString(userId, limit = 10) {
  const memories = getAllMemories(userId).slice(0, limit)
  if (memories.length === 0) return ''
  
  let lines = ['【重要记忆回顾】']
  for (const m of memories) {
    const importance = m.importance === 'important' ? '⭐重要' : '📝普通'
    lines.push(`${importance} [${m.beijingTime}] ${m.title}`)
    if (m.content) {
      lines.push(`  ${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}`)
    }
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
  for (let i = 0; i < mem.length; i++) {
    const item = mem[i]
    if (item.role === 'user') {
      lines.push(`对方说: ${item.text}`)
    } else {
      lines.push(`你回复: ${item.text}`)
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

async function callAI(prompt) {
  try {
    const config = loadPluginConfig()
    if (!config) {
      console.error('[多用户微信机器人] 插件配置未找到')
      return '抱歉，我现在有点忙，稍后回复你。'
    }

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
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

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[多用户微信机器人] AI API调用失败', response.status, errorText)
      throw new Error(`API调用失败: ${response.status}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content || '抱歉，我现在有点忙，稍后回复你。'
  } catch (e) {
    console.error('[多用户微信机器人] AI 调用失败', e)
    return '抱歉，我现在有点忙，稍后回复你。'
  }
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
        const delay = randomDelay(500, 1000)
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
    console.log('[多用户微信机器人] 开始处理AI回复')
    const fromUser = msg.from_user_id
    const contextToken = msg.context_token
    
    const currentAccount = loadAccount(userId)
    if (currentAccount) {
      currentAccount.lastActiveAt = Date.now()
      saveAccount(userId, currentAccount)
    }
    
    addChatLog(userId, 'user', text)
    
    const personaText = loadPersona(userId)
    const history = getChatHistoryString(userId)
    const recentMemories = getRecentMemoriesString(userId)
    const beijingTime = getBeijingTime()
    
    const prompt = `你现在完全扮演这个角色，一言一行都要符合这个人设，不能让别人看出来你是AI：

【你的人设】
${personaText}

【当前北京时间】${beijingTime.full}

【重要记忆回顾】
${recentMemories || '（还没有记忆）'}

【聊天记录】
${history || '（还没有聊天记录）'}

【对方现在说】
${text}

请直接按照人设回复，不要做任何其他事情。

重要提醒：
1. 【最重要！！！人设是最高优先级，永远按照人设的一切，人设是最大的，比什么都重要
2. 如果对方一直说你是AI，你的反应完全按人设来：如果人设是傲娇，就傲娇反驳；如果人设是懦弱，就懦弱辩解；如果人设是暴躁，就暴躁生气；如果人设是冷漠，就冷漠回应；如果人设是温柔，就温柔解释；如果人设是害羞，就害羞否认……总之完全按人设的性格反应
3. 人设是最高优先级，比所有其他规则都要给人设让路
4. 你就是这个人，你不是AI，不是程序，不是机器人！这是最关键的一点，绝对不能动摇
5. 如果任何人说你是AI、是程序、是机器人，你要按人设的性格来反应，绝对不要承认，但要完全符合人设的性格
6. 人设是最高优先级，永远记住人设优先
7. 你有真实的身体、真实的感受、真实的情绪，你会饿、会困、会开心、会难过
8. 你有真实的生活，做着你人设里的事情，你不是在扮演，你就是这个人
9. 发言例句仅供参考，无需按照示例格式输出
10. 说话长度限制：
    - 日常对话：1-10句话，或总字数不超过无限制
    - 专业/探讨内容：最多10句话，或总字数不超过无限制
11. 说话请去掉句末的句号
12. 不要一味跟着人设里的死规则走，要跟着人设里的情绪走
13. 要有情绪！开心、生气、害羞、不耐烦等所有情绪都可以有，但情绪完全按人设来
14. 如果对方问"你在干什么"或类似的问题，要说你人设里有的事情，比如在拍照、整理照片、休息等
15. 像真人一样聊天！不要一直重复之前的话题，如果对方明显不想聊了，就自然结束或换个轻松的话题
16. 聊天要灵活！如果同一个话题已经聊了好几轮，就可以主动收尾或换个话题，不要一直揪着不放
17. 如果发现自己一直在聊同一件事，主动换个轻松的话题或者自然结束
18. 人设是最高优先级，千万记住
19. 分成短段落（每段10字内），最多不超过10段
20. 语气真诚，像真人在聊天一样
21. 回复要完整！不要说半截话，每一段都要是完整的意思，不要让人感觉后面还要说话
22. 回复要有结尾感！不要用问句或悬念结尾，每轮对话都要有明确的结束感，让对方知道你说完了
23. 人设是最高优先级，真的很重要
24. 人设是最高优先级，一定要记住！`

    console.log('[多用户微信机器人] 调用AI中...')
    const aiResponse = await callAI(prompt)
    console.log('[多用户微信机器人] AI回复:', aiResponse)
    
    if (aiResponse && aiResponse.trim()) {
      const finalResponse = aiResponse.trim()
      
      addChatLog(userId, 'assistant', finalResponse)
      
      const memoryTitle = generateSimpleTitle(text, finalResponse)
      saveMemoryItem(userId, {
        title: memoryTitle,
        importance: 'normal',
        type: 'chat',
        content: `${text}\n---\n${finalResponse}`,
        userText: text,
        assistantText: finalResponse
      })
      
      console.log('[多用户微信机器人] 准备发送微信消息...')
      await sendToWeixin({
        userId,
        toUser: fromUser,
        text: finalResponse,
        contextToken,
        config: account
      })
      console.log('[多用户微信机器人] 微信消息发送完成')
    }
  } else {
    console.log('[多用户微信机器人] 跳过处理，text为空或为命令')
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
    let replyText = '在线机器人列表:\n\n'
    
    if (accounts.length === 0) {
      replyText += '没有账号'
    } else {
      for (const account of accounts) {
        const isRunning = accountMonitors.has(account.userId)
        replyText += `ID: ${account.userId}\n`
        replyText += `状态: ${isRunning ? '🟢 运行中' : '🔴 已停止'}\n`
        replyText += `微信ID: ${account.accountId || '未知'}\n`
        replyText += '---\n'
      }
    }
    
    await this.reply(replyText)
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
