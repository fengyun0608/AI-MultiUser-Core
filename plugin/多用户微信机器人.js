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
          qrRefreshCount++
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            console.log('[多用户微信机器人] 二维码刷新次数过多')
            try {
              if (login.pluginInstance) {
                await login.pluginInstance.reply('二维码过期次数过多，请重新发送 #登录微信AI')
              }
            } catch (e) {}
            activeLogins.delete(sessionKey)
            break
          }
          
          console.log('[多用户微信机器人] 二维码过期，刷新中...')
          const newQrResponse = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE)
          login.qrcode = newQrResponse.qrcode
          login.qrcodeUrl = newQrResponse.qrcode_img_content
          login.startedAt = Date.now()
          console.log('[多用户微信机器人] 二维码已刷新')
          
          try {
            if (login.pluginInstance) {
              try {
                const filename = `qrcode_${sessionKey}_${Date.now()}.png`
                const filepath = path.join(TEMP_DIR, filename)
                
                await login.pluginInstance.reply('二维码已过期，新二维码已生成：')
                
                try {
                  await screenshotUrl(newQrResponse.qrcode_img_content, filepath)
                  await login.pluginInstance.reply(segment.image(filepath))
                } catch (e) {
                  await login.pluginInstance.reply(newQrResponse.qrcode_img_content)
                }
                
                setTimeout(() => { try { fs.unlinkSync(filepath) } catch (e) { } }, 120000)
              } catch (e) {
                console.error('[多用户微信机器人] 刷新二维码失败', e)
                await login.pluginInstance.reply([
                  '二维码已过期，新二维码已生成：',
                  '',
                  newQrResponse.qrcode_img_content
                ].join('\n'))
              }
            }
          } catch (e) { }
          continue
          
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
          
          const account = {
            userId: sessionKey, accountId: statusResponse.ilink_bot_id, token: statusResponse.bot_token,
            baseUrl: statusResponse.base_url || FIXED_BASE_URL, userIdFromWeixin: statusResponse.ilink_user_id,
            createdAt: Date.now(), enabled: true, get_updates_buf: '',
          }
          
          saveAccount(sessionKey, account)
          activeLogins.delete(sessionKey)
          
          try {
            if (login.pluginInstance) {
              await login.pluginInstance.reply('✅ 登录成功！微信机器人已启动！')
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
  const paragraphs = text.split(/\n\n+|\r\n\r\n+/).filter(p => p.trim())
  
  for (const para of paragraphs) {
    if (segments.length >= 10) break
    
    if (para.trim().length <= 10) {
      segments.push(para.trim())
    } else {
      const sentences = para.split(/(?<=[。！？!?])\s*/).filter(s => s.trim())
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
    
    addChatLog(userId, 'user', text)
    
    const personaText = loadPersona(userId)
    const history = getChatHistoryString(userId)
    
    const now = new Date()
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
    
    const prompt = `你现在完全扮演这个角色，一言一行都要符合这个人设，不能让别人看出来你是AI：

【你的人设】
${personaText}

【当前时间】${timeStr}

【聊天记录】
${history || '（还没有聊天记录）'}

【对方现在说】
${text}

请直接按照人设回复，语气自然，像真实的人在聊天，不要解释，不要提到"AI"或"人设"。

重要提醒：
1. 无论谈论什么，请牢记，你是一个人，并非AI或机器造物
2. 发言例句仅供参考，无需按照示例格式输出
3. 说话长度限制：
   - 日常对话：1句话，或总字数不超过30字
   - 专业/探讨内容：最多3句话，或总字数不超过50字
4. 说话请去掉句末的句号
5. 严格按照人设说话，人设是最高优先级
6. 分成短段落（每段10字内），最多不超过10段
7. 语气真诚，像真人在聊天一样`

    console.log('[多用户微信机器人] 调用AI中...')
    const aiResponse = await callAI(prompt)
    console.log('[多用户微信机器人] AI回复:', aiResponse)
    
    if (aiResponse && aiResponse.trim()) {
      addChatLog(userId, 'assistant', aiResponse.trim())
      console.log('[多用户微信机器人] 准备发送微信消息...')
      await sendToWeixin({
        userId,
        toUser: fromUser,
        text: aiResponse.trim(),
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
        { reg: '^#登录微信AI$', fnc: 'loginWeixin' },
        { reg: '^#更改人设', fnc: 'changePersona' },
        { reg: '^#微信机器人在线列表$', fnc: 'listOnlineBots' },
        { reg: '^#停止机器人(.*)$', fnc: 'stopBot' },
        { reg: '^#启动机器人(.*)$', fnc: 'startBot' },
        { reg: '^#删除机器人(.*)$', fnc: 'deleteBot' },
        { reg: '^#帮助多用户$', fnc: 'showHelp' }
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
  
  async showHelp() {
    await this.reply(
      `多用户微信机器人帮助:\n\n#登录微信AI - 获取二维码登录微信\n#更改人设 人设内容 - 修改自己的人设（需已登录并运行）\n  （支持多行、任意长度的人设内容）\n#微信机器人在线列表 - 查看所有账号状态\n#停止机器人 [用户ID] - 停止指定账号\n#启动机器人 [用户ID] - 启动指定账号\n#删除机器人 [用户ID] - 删除账号\n\n普通用户: #登录微信AI 登录自己的微信\n主人: 可以管理所有账号`
    )
    return true
  }
}
