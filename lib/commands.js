import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { 
  AI_MULTIUSER_DIR, 
  TEMP_DIR, 
  PLUGIN_CONFIG_FILE, 
  ACTIVE_LOGIN_TTL_MS 
} from './config.js'
import { 
  loadMasters, 
  isAdmin, 
  loadNameBindings, 
  saveNameBindings 
} from './admin.js'
import { 
  loadUserAccountConfig, 
  saveUserAccountConfig, 
  loadUserPersona, 
  saveUserPersona, 
  loadUserChatMemory, 
  saveUserChatMemory, 
  getUserDir, 
  ensureUserDir 
} from './account.js'
import { 
  qrcode, 
  longpollCheck, 
  getOnlineList, 
  stopBot, 
  startBot, 
  logoutBot, 
  longpollMessages 
} from './weixin.js'
import { screenshotUrl } from './browser.js'
import { callAI, loadPluginConfig, apiHealth } from './api.js'
import { 
  processAccountMessage, 
  handleWeixinCommand, 
  checkAllUsersForAutoMsg, 
  cleanupUserData, 
  cleanUp, 
  userApiStates, 
  userMessageQueues, 
  userMessageTimers, 
  userNextAutoMsgTime 
} from './message.js'
import { sendWeixinMessageSplit } from './weixin.js'
import { closeBrowser } from './browser.js'
import fs from 'node:fs'

const activeLogins = new Map()
const botContextMap = new Map()
let autoMsgInterval = null

export async function handleLoginWeixinCommand(e, pluginData) {
  const userId = e.user_id
  if (!isAdmin(userId)) {
    await e.reply('❌ 你没有管理员权限，无法使用此命令')
    return
  }
  
  const rawText = e.raw_message || e.message
  let tokenMatch = rawText.match(/sk-[^\s]+/)
  if (!tokenMatch) {
    const existing = loadUserAccountConfig(userId)
    if (existing?.token) {
      tokenMatch = [existing.token]
    }
  }
  if (!tokenMatch) {
    await e.reply('请在登录命令中带上你的API Token，例如：#登录微信AI sk-xxxxx')
    return
  }
  const token = tokenMatch[0]
  saveUserAccountConfig(userId, { token })
  const cached = loadUserAccountConfig(userId)
  if (cached?.accountId && cached?.online) {
    const list = await getOnlineList(token).catch(() => [])
    const stillOnline = list.some(x => x.accountId === cached.accountId)
    if (stillOnline) {
      await e.reply('您当前已在登录运行中，请勿重复登录～')
      return
    }
  }
  
  await e.reply('正在获取二维码...')
  
  const loginId = randomUUID()
  const qrResult = await qrcode(token)
  const qrcodeId = qrResult.qrcodeId
  const qrcodeUrl = qrResult.url
  const qrcodeBase64 = qrResult.qrcodeBase64
  
  activeLogins.set(loginId, { userId, token, qrcodeId, createdAt: Date.now() })
  
  if (qrcodeBase64) {
    try {
      const dataStart = qrcodeBase64.indexOf(',')
      const b64 = dataStart !== -1 ? qrcodeBase64.slice(dataStart + 1) : qrcodeBase64
      const buf = Buffer.from(b64, 'base64')
      const tempPath = path.join(TEMP_DIR, `qrcode-${loginId}.png`)
      ensureUserDir(userId)
      fs.writeFileSync(tempPath, buf)
      await e.reply(['二维码已生成，请使用微信扫描登录', segment.image(`file://${tempPath}`)])
    } catch (e) {
      console.warn('[多用户微信机器人] 保存二维码图片失败', e)
      await e.reply(['二维码已生成，请使用微信扫描登录', segment.image(qrcodeBase64)])
    }
  } else if (qrcodeUrl) {
    try {
      const tempPath = path.join(TEMP_DIR, `qrcode-${loginId}.png`)
      await screenshotUrl(qrcodeUrl, tempPath)
      await e.reply(['二维码已生成，请使用微信扫描登录', segment.image(`file://${tempPath}`)])
    } catch (err) {
      console.warn('[多用户微信机器人] 截图二维码失败，使用文本链接', err)
      await e.reply(`二维码已生成，请访问: ${qrcodeUrl}`)
    }
  } else {
    await e.reply('获取二维码失败，请稍后重试')
    return
  }
  
  const nameBindings = loadNameBindings()
  let botName = nameBindings[String(userId)] || '葵宝'
  const ctx = { userId, token, accountId: '', online: false, lastActiveMs: Date.now(), botName }
  
  pollLogin(loginId, ctx, e, pluginData)
}

async function pollLogin(loginId, ctx, e, pluginData) {
  try {
    const state = activeLogins.get(loginId)
    if (!state) return
    const { userId, token, qrcodeId, createdAt } = state
    if (Date.now() - createdAt > ACTIVE_LOGIN_TTL_MS) {
      activeLogins.delete(loginId)
      return
    }
    
    const data = await longpollCheck(token, qrcodeId)
    if (!data || !data.status) {
      setTimeout(() => pollLogin(loginId, ctx, e, pluginData), 2000)
      return
    }
    
    const status = data.status
    if (status === 'expired') {
      await e.reply('二维码已过期，请重新发起登录')
      activeLogins.delete(loginId)
      return
    }
    if (status === 'waitScan') {
      setTimeout(() => pollLogin(loginId, ctx, e, pluginData), 2000)
      return
    }
    if (status === 'waitConfirm') {
      await e.reply('请在微信中点击登录确认')
      setTimeout(() => pollLogin(loginId, ctx, e, pluginData), 2000)
      return
    }
    if (status === 'done') {
      const accountId = data.accountId
      const botName = data.nickName || ctx.botName
      ctx.accountId = accountId
      ctx.botName = botName
      ctx.online = true
      
      const nameBindings = loadNameBindings()
      nameBindings[String(userId)] = botName
      saveNameBindings(nameBindings)
      
      const config = loadUserAccountConfig(userId) || {}
      saveUserAccountConfig(userId, { ...config, accountId, online: true })
      
      botContextMap.set(userId, ctx)
      activeLogins.delete(loginId)
      
      await e.reply(`✅ 登录成功！${ctx.botName}已上线！\n\n💡 提示：现在可以发送 #更改人设 来设置你的专属人设哦～\n（也可以发送 #当前人设 查看当前人设）`)
      
      await sendWelcomeInstructionsToUser(ctx)
      
      startAccountMessageLoop(ctx, pluginData)
      
      if (!autoMsgInterval) {
        autoMsgInterval = setInterval(() => checkAllUsersForAutoMsg(botContextMap, sendWeixinMessageSplit), 60 * 1000)
      }
      
      return
    }
    setTimeout(() => pollLogin(loginId, ctx, e, pluginData), 2000)
  } catch (err) {
    console.error('[多用户微信机器人] 轮询登录状态异常', err)
    setTimeout(() => pollLogin(loginId, ctx, e, pluginData), 3000)
  }
}

async function sendWelcomeInstructionsToUser(ctx) {
  try {
    const welcomeText = `🎉 恭喜登录成功！这里是我的指令说明：

📝 人设与记忆：
- #更改人设 [内容] → 更改我的人设描述
- #当前人设 → 查看当前人设
- #清除记忆 → 清除聊天记忆
- #我的信息 → 查看你的信息

⚙️ API配置：
- #配置API [url] [key] [model] → 配置你的自定义API
- #切换官方 → 使用官方API
- #切换自定义 → 使用你配置的API

💬 主动消息：
- #开启AI主动发送消息 → 开启主动消息
- #关闭AI主动发送消息 → 关闭主动消息

🎮 其他：
- #帮助 → 显示帮助信息
- #关于 → 关于本机器人
- #推广 → 推广本项目

直接发消息就能和我聊天啦！快来和我说话吧~`
    
    await sendWeixinMessageSplit(ctx.token, ctx.accountId, ctx.userId, welcomeText)
    console.log('[多用户微信机器人] 已向用户发送登录成功后的指令说明')
  } catch (e) {
    console.warn('[多用户微信机器人] 发送指令说明失败', e)
  }
}

async function startAccountMessageLoop(ctx, pluginData) {
  const emit = pluginData.emit
  const userId = ctx.userId
  
  while (botContextMap.has(userId)) {
    const currentCtx = botContextMap.get(userId)
    if (!currentCtx) break
    if (!currentCtx.online) break
    try {
      await longpollMessages(currentCtx.token, currentCtx.accountId, currentCtx, emit)
    } catch (e) {
      if (e.name === 'AbortError') {
      } else {
        console.warn('[多用户微信机器人] 消息轮询出错', e)
      }
    }
  }
  
  console.log(`[多用户微信机器人] ${ctx.botName} 消息监听已停止`)
}

export async function handleOnlineListCommand(e) {
  const userId = e.user_id
  if (!isAdmin(userId)) {
    await e.reply('❌ 你没有管理员权限，无法使用此命令')
    return
  }
  
  const masters = loadMasters()
  const allAccounts = []
  for (const adminId of masters) {
    const cfg = loadUserAccountConfig(adminId)
    if (cfg?.token) {
      try {
        const list = await getOnlineList(cfg.token)
        allAccounts.push(...list.map(x => ({ ...x, adminId })))
      } catch (e) {
        console.warn('[多用户微信机器人] 获取在线列表失败', e)
      }
    }
  }
  if (allAccounts.length === 0) {
    await e.reply('当前没有机器人在线')
    return
  }
  let text = '📍 微信机器人在线列表\n\n'
  for (const acc of allAccounts) {
    const nameBindings = loadNameBindings()
    const name = nameBindings[String(acc.adminId)] || '葵宝'
    text += `${name} (${acc.nickName || acc.accountId.slice(0, 8)}...): ${acc.online ? '🟢 在线' : '🔴 离线'}\n`
  }
  const lines = text.split('\n')
  const maxLineLen = 200
  let chunks = ['']
  for (const line of lines) {
    if ((chunks[chunks.length - 1] + '\n' + line).length > maxLineLen) {
      chunks.push('')
    }
    if (chunks[chunks.length - 1]) chunks[chunks.length - 1] += '\n'
    chunks[chunks.length - 1] += line
  }
  for (const chunk of chunks) {
    if (chunk.trim()) await e.reply(chunk)
  }
}

export async function handleStopCommand(e, cmd, pluginData) {
  const userId = e.user_id
  if (!isAdmin(userId)) {
    await e.reply('❌ 你没有管理员权限，无法使用此命令')
    return
  }
  
  const rest = cmd.slice(4).trim()
  const cfg = loadUserAccountConfig(userId)
  if (!cfg?.token) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  const accountId = rest || cfg.accountId
  if (!accountId) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  await stopBot(cfg.token, accountId)
  const newCfg = { ...cfg, online: false }
  saveUserAccountConfig(userId, newCfg)
  const ctx = botContextMap.get(userId)
  if (ctx) {
    ctx.online = false
  }
  await e.reply('已停止机器人')
}

export async function handleStartCommand(e, cmd, pluginData) {
  const userId = e.user_id
  if (!isAdmin(userId)) {
    await e.reply('❌ 你没有管理员权限，无法使用此命令')
    return
  }
  
  const rest = cmd.slice(5).trim()
  const cfg = loadUserAccountConfig(userId)
  if (!cfg?.token) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  const accountId = rest || cfg.accountId
  if (!accountId) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  await startBot(cfg.token, accountId)
  const newCfg = { ...cfg, online: true }
  saveUserAccountConfig(userId, newCfg)
  
  const nameBindings = loadNameBindings()
  const botName = nameBindings[String(userId)] || '葵宝'
  
  if (!botContextMap.has(userId)) {
    const ctx = { userId, token: cfg.token, accountId, online: true, lastActiveMs: Date.now(), botName }
    botContextMap.set(userId, ctx)
    startAccountMessageLoop(ctx, pluginData)
    
    if (!autoMsgInterval) {
      autoMsgInterval = setInterval(() => checkAllUsersForAutoMsg(botContextMap, sendWeixinMessageSplit), 60 * 1000)
    }
  } else {
    const ctx = botContextMap.get(userId)
    ctx.accountId = accountId
    ctx.online = true
  }
  
  await e.reply('已启动机器人')
}

export async function handleDeleteCommand(e, cmd, pluginData) {
  const userId = e.user_id
  if (!isAdmin(userId)) {
    await e.reply('❌ 你没有管理员权限，无法使用此命令')
    return
  }
  
  const rest = cmd.slice(5).trim()
  const cfg = loadUserAccountConfig(userId)
  if (!cfg?.token) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  const accountId = rest || cfg.accountId
  if (!accountId) {
    await e.reply('未找到你的登录信息，请先登录')
    return
  }
  await logoutBot(cfg.token, accountId)
  const userDir = getUserDir(userId)
  const configPath = path.join(userDir, 'config.json')
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath)
  }
  botContextMap.delete(userId)
  await e.reply('已删除机器人')
}

export async function handleChangePersonaCommand(e, cmd, pluginData) {
  const userId = e.user_id
  const personaText = cmd.slice(5).trim()
  if (!personaText) {
    await e.reply('请在 #更改人设 后面加上你想要设置的人设内容～')
    return
  }
  const existingPersona = loadUserPersona(userId)
  const newPersona = `${existingPersona}\n\n${personaText}`.trim()
  saveUserPersona(userId, newPersona)
  await e.reply('好的！已经帮你更新人设啦～ 来和我聊聊天吧')
}

export async function handleShowPersonaCommand(e) {
  const userId = e.user_id
  const persona = loadUserPersona(userId)
  await e.reply(`👤 当前人设\n────────────────\n${persona}`)
}

export async function handleClearMemoryCommand(e) {
  const userId = e.user_id
  saveUserChatMemory(userId, [])
  await e.reply('好的！已经帮你清除聊天记忆啦～')
}

export async function handleMyInfoCommand(e) {
  const userId = e.user_id
  const chatMemory = loadUserChatMemory(userId)
  const cfg = loadUserAccountConfig(userId)
  const msgCount = Math.floor(chatMemory.length / 2)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  let todayMsgs = 0
  for (const m of chatMemory) {
    if (m.role === 'user' && m.time && m.time >= todayStart.getTime()) todayMsgs++
  }
  let text = `📊 我的信息\n────────────────\n你的QQ: ${userId}\n`
  if (cfg?.accountId) {
    text += `机器人ID: ${cfg.accountId}\n在线状态: ${cfg.online ? '🟢 在线' : '🔴 离线'}\n`
  }
  text += `对话总数: ${msgCount}\n今日对话: ${todayMsgs}`
  await e.reply(text)
}

export async function handleHelpCommand(e) {
  const helpText = `📖 帮助信息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【登录与人设】
#登录微信AI [token] → 登录微信机器人
#更改人设 [内容] → 更改机器人的人设
#当前人设 → 查看当前人设

【记忆与信息】
#清除记忆 → 清除聊天记忆
#我的信息 → 查看你的信息

【管理机器人】（仅管理员）
#微信机器人在线列表 → 查看在线的机器人
#停止机器人 [可选ID] → 停止机器人
#启动机器人 [可选ID] → 启动机器人
#删除机器人 [可选ID] → 删除机器人

【其他】
#帮助 → 显示帮助信息
#关于 → 关于本项目
#推广 → 推广本项目
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  await e.reply(helpText)
}

export async function handleAboutCommand(e) {
  const about = `【关于】
向日葵AGT - 多用户微信机器人
版本: v13.0.0
作者: 风云科技

项目地址: https://github.com/sunflowermm/XRK-AGT

鸣谢: 陈家锐 (仙桃二中长虹路校区)
开源许可证: MIT`
  await e.reply(about)
}

export async function handlePromoCommand(e) {
  const promo = `喜欢这个机器人吗？快来推广一下吧！
录制一段你和机器人聊天的视频或图片，发布到抖音等平台～
记得@风云云哦！
快手号: Japappp1`
  await e.reply(promo)
}

export async function handleWeixinMessage(event, pluginData) {
  const { userId, accountId, from, to, content, raw } = event
  const ctx = botContextMap.get(userId)
  if (!ctx) {
    console.warn('[多用户微信机器人] 未找到用户上下文', userId)
    return
  }
  const emit = pluginData.emit
  processAccountMessage({ accountId, AddMsg: [raw] }, userId, ctx, emit)
}

export function pluginCleanup() {
  cleanUp()
  for (const ctx of botContextMap.values()) {
    ctx.online = false
  }
  if (autoMsgInterval) {
    clearInterval(autoMsgInterval)
    autoMsgInterval = null
  }
  closeBrowser()
}