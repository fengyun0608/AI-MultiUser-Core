import { FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE, CHANNEL_VERSION, QR_LONG_POLL_TIMEOUT_MS, ACTIVE_LOGIN_TTL_MS } from './config.js'

export async function qrcode(token) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/qrcode`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message || '获取二维码失败')
  return data.data
}

export async function longpollCheck(token, qrcodeId, ctx) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/qrcode/longpoll`
  const now = Date.now()
  const exp = now + QR_LONG_POLL_TIMEOUT_MS + 30000
  const signal = AbortSignal.timeout(QR_LONG_POLL_TIMEOUT_MS)
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const body = JSON.stringify({
    qrcodeId,
    exp: Math.floor(exp / 1000),
    scene: 'normal'
  })
  const res = await fetch(url, { method: 'POST', headers, body, signal })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message || '轮询失败')
  return data.data
}

export async function getOnlineList(token) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/bot/onlinelist`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message)
  return data.data || []
}

export async function stopBot(token, accountId) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/bot/stop`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ accountId }) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message)
  return data
}

export async function startBot(token, accountId) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/bot/start`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ accountId }) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message)
  return data
}

export async function logoutBot(token, accountId) {
  const url = `${FIXED_BASE_URL}/ilink/openapi/bot/logout`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ accountId }) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message)
  return data
}

export async function sendWeixinMessage(token, accountId, toUserName, content) {
  const url = `${FIXED_BASE_URL}/ilink/bot/sendmessage`
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE,
    'X-ILink-Bot-Id': accountId
  }
  const payload = {
    accountId,
    toUserName,
    content,
    msgType: 1,
    channelVersion: CHANNEL_VERSION
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message || '发送失败')
  return data
}

export async function sendWeixinMessageSplit(token, accountId, toUserName, text) {
  if (!text) return
  const parts = text.split(/\n/).filter(x => x.trim())
  const maxLen = 400
  const segments = []
  for (const part of parts) {
    if (part.length <= maxLen) {
      segments.push(part)
    } else {
      for (let i = 0; i < part.length; i += maxLen) {
        segments.push(part.slice(i, i + maxLen))
      }
    }
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    console.log(`[多用户微信机器人] 发送段落 ${i + 1}/${segments.length}: ${seg.slice(0, 50)}...`)
    try {
      await sendWeixinMessage(token, accountId, toUserName, seg)
    } catch (e) {
      console.warn('[多用户微信机器人] 单条发送失败', e)
      throw e
    }
    if (i < segments.length - 1) {
      const wait = 1000 + Math.floor(Math.random() * 700)
      console.log(`[多用户微信机器人] 等待 ${wait}ms 后发送下一段...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  console.log('[多用户微信机器人] 微信消息发送完成')
}

export async function longpollMessages(token, accountId, ctx, emit) {
  const url = `${FIXED_BASE_URL}/ilink/bot/sync`
  const now = Date.now()
  const exp = now + 30000 + 30000
  const signal = AbortSignal.timeout(30000)
  const headers = {
    'Content-Type': 'application/json',
    'X-ILink-Bot-Token': token,
    'X-ILink-Bot-Type': DEFAULT_ILINK_BOT_TYPE,
    'X-ILink-Bot-Id': accountId
  }
  const body = JSON.stringify({ accountId, channelVersion: CHANNEL_VERSION, exp: Math.floor(exp / 1000), scene: 'normal' })
  const res = await fetch(url, { method: 'POST', headers, body, signal })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.msg || data.message)
  const addMsg = data.data?.AddMsg || []
  for (const msg of addMsg) {
    if (msg.type !== 1) continue
    const from = msg.fromUserName
    const to = msg.toUserName
    if (msg.isSendMsg) continue
    if (from.endsWith('@im.qq.com') || from.endsWith('@chatroom')) continue
    ctx.lastActiveMs = Date.now()
    emit('multiuserWeixinMessage', { userId: ctx.userId, accountId, from, to, content: msg.content, raw: msg })
  }
}