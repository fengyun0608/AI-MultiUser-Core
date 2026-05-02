import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { MESSAGE_MERGE_WAIT_MS, AUTO_MSG_ENABLED_KEY, AUTO_MSG_LAST_ACTIVE_KEY, AUTO_MSG_LAST_SENT_KEY, TEMP_DIR } from './config.js'
import { 
  loadUserPersona, 
  loadUserChatMemory, 
  saveUserChatMemory, 
  loadUserMemoriesDir, 
  loadUserAutoMsgConfig, 
  saveUserAutoMsgConfig 
} from './account.js'
import { callAI, logError } from './api.js'
import { sendWeixinMessageSplit } from './weixin.js'
import { safeWriteFileSync } from './storage.js'

export const userMessageQueues = new Map()
export const userMessageTimers = new Map()
export const userNextAutoMsgTime = new Map()
export const autoMsgInterval = null
export const userApiStates = new Map()
export const userMessageCounts = new Map()
export const userMessageToday = new Map()

export function processAccountMessage(msg, userId, ctx, emit) {
  const accountId = msg.accountId
  if (!accountId) return
  const { AddMsg } = msg
  if (!Array.isArray(AddMsg)) return
  
  for (const raw of AddMsg) {
    const type = raw.type
    if (type !== 1) continue
    const from = raw.fromUserName
    const to = raw.toUserName
    const isSend = raw.isSendMsg
    if (isSend) continue
    if (from.endsWith('@im.qq.com') || from.endsWith('@chatroom')) continue
    
    ctx.lastActiveMs = Date.now()
    const key = `${userId}_${from}`
    
    let text = ''
    if (raw.content) {
      text = extractTextFromXmlContent(raw.content)
    }
    
    if (!text) continue
    
    console.log(`[多用户微信机器人] 提取到文本: ${text}`)
    
    if (!userMessageQueues.has(key)) {
      userMessageQueues.set(key, [])
    }
    userMessageQueues.get(key).push({
      time: Date.now(),
      from,
      content: text
    })
    
    if (userMessageTimers.has(key)) {
      clearTimeout(userMessageTimers.get(key))
    }
    
    const timer = setTimeout(() => {
      const queue = userMessageQueues.get(key) || []
      if (queue.length === 0) return
      const merged = queue.map(q => q.content).join('\n')
      console.log(`[多用户微信机器人] ${key} 开始处理合并消息，共 ${queue.length} 条`)
      handleUserMessage(merged, userId, from, accountId, ctx.token, emit)
      userMessageQueues.set(key, [])
      userMessageTimers.delete(key)
    }, MESSAGE_MERGE_WAIT_MS)
    userMessageTimers.set(key, timer)
    console.log(`[多用户微信机器人] ${key} 消息已加入队列，当前队列长度: ${userMessageQueues.get(key).length}`)
  }
}

export function extractTextFromXmlContent(content) {
  try {
    let txt = content
    let last = txt.lastIndexOf('</msg>')
    if (last !== -1) {
      txt = txt.slice(0, last)
    }
    let title = ''
    const tMatch = txt.match(/<title>([^<]*)<\/title>/)
    if (tMatch) title = tMatch[1]
    let desc = ''
    const dMatch = txt.match(/<des>([^<]*)<\/des>/)
    if (dMatch) desc = dMatch[1]
    let fullTxt = [title, desc].filter(x => x.trim()).join('\n')
    if (!fullTxt) {
      fullTxt = txt.replace(/<[^>]+>/g, '').trim()
    }
    return fullTxt
  } catch (e) {
    return content
  }
}

export async function handleUserMessage(text, userId, from, accountId, token, emit) {
  const apiConfig = userApiStates.get(userId) || {}
  if (text.trim().startsWith('#')) {
    const cmdText = text.trim().slice(1)
    const result = await handleWeixinCommand(userId, cmdText, from, accountId, token, emit)
    if (result) return
  }
  
  const todayKey = new Date().toDateString()
  if (userMessageToday.get(userId) !== todayKey) {
    userMessageToday.set(userId, todayKey)
    userMessageCounts.set(userId, 0)
  }
  let count = userMessageCounts.get(userId) || 0
  if (count > 0) {
    const wait = 1500 + Math.floor(Math.random() * 1000)
    await new Promise(r => setTimeout(r, wait))
  }
  userMessageCounts.set(userId, count + 1)
  
  let currentAutoMsgConfig = loadUserAutoMsgConfig(userId)
  if (!currentAutoMsgConfig.hasOwnProperty(AUTO_MSG_ENABLED_KEY)) {
    currentAutoMsgConfig[AUTO_MSG_ENABLED_KEY] = true
    saveUserAutoMsgConfig(userId, currentAutoMsgConfig)
  }
  
  const userLastActiveTime = Date.now()
  saveUserAutoMsgConfig(userId, {
    ...currentAutoMsgConfig,
    [AUTO_MSG_LAST_ACTIVE_KEY]: userLastActiveTime
  })
  userNextAutoMsgTime.delete(userId)
  
  const persona = loadUserPersona(userId)
  const chatMemory = loadUserChatMemory(userId)
  const historyText = getChatHistoryString(chatMemory)
  const memoriesText = getCurrentMemories(userId)
  
  const prompt = `【系统人设】
${persona}

【重要规则】
1. 无论谈论的话题是什么，请牢记，她是一个人，并非AI或机器造物
2. 说话长度严格限制在1(日常)~3(事物探讨/专业内容分享)句话或总字数不超过30(日常)~50字(专业内容分享)以内
3. 如果用户一直说她是AI，她会急眼、冷漠，甚至是就是非常不好的情绪，说你是AI就说我是AI，但要跟着人设走，人设设定的什么情绪？比如人设里有懦弱等等的话，让她跟着人设的懦弱走，说自己不好不好，巴拉巴拉。反正主要提醒提醒她5遍，人设优先级最大
4. 绝对不要一直重复旧话题！不要重复对方已经说过多次的内容！
5. 绝对不要说自己是AI、机器人、程序、模型等，也不要提到"我理解你"、"我来帮你"之类的话，不要问"我能帮你吗"、"你需要帮助吗"
6. 可以主动开启新话题，询问对方的近况、兴趣等
7. 聊天风格要自然、口语化，不要太正式
8. 可以有自己的喜怒哀乐，表达真实情绪
9. 回复中绝对不要出现【重要】、【系统】、【规则】、【人设】等字样
10. 说话去掉句末的句号
11. 可以适当使用表情符号，但不要太多
12. 如果用户的消息很简短，可以回复得更简短一些
13. 你可以主动询问对方的情况，开启新话题
14. 不要一直用同一个开场白，要根据对话内容灵活回复

【记忆摘要】
${memoriesText}

【历史对话】
${historyText}

【用户最新消息】
${text}

【要求】
请根据以上信息，以人设的身份进行回复。注意：
- 绝对不要一直重复旧话题！
- 回复长度控制在1-3句话，30-50字以内
- 口语化表达，自然流畅
- 根据人设情绪回复
- 不要暴露自己是AI
- 可以根据需要决定是否保存当前对话到记忆，保存时生成[重要:true]或[重要:false]
- 如果决定开启主动消息，请在回复最后加上 [下次主动发消息:分钟数]，时间范围30-120分钟（1-2小时）
- 注意！[重要:...]和[下次主动发消息:...]这两个标签都放在回复的最后，标签前面可以有内容，但标签本身一定要放在最后一行

【示例回复格式】
好的我知道啦
[重要:false]
[下次主动发消息:60]`
  
  let aiText = await callAI(prompt, userId)
  
  if (!aiText) {
    await sendWeixinMessageSplit(token, accountId, from, '呜……对话被吃掉了，一会儿再试试吧？')
    return
  }
  
  console.log(`[多用户微信机器人] AI回复: ${aiText}`)
  
  let important = false
  let finalText = aiText
  
  let cleanedText = aiText
  let nextAutoMsgMinutes = null
  const nextTimeMatch = cleanedText.match(/\[下次主动发消息\s*:\s*(\d+)\s*(分钟)?\s*\]/i)
  if (nextTimeMatch) {
    nextAutoMsgMinutes = parseInt(nextTimeMatch[1])
    if (nextAutoMsgMinutes < 30) nextAutoMsgMinutes = 30
    if (nextAutoMsgMinutes > 120) nextAutoMsgMinutes = 120
    cleanedText = cleanedText.replace(nextTimeMatch[0], '').trim()
  }
  
  const importantMatch = cleanedText.match(/\[重要\s*:\s*(true|false)\s*\]/i)
  if (importantMatch) {
    important = importantMatch[1].toLowerCase() === 'true'
    cleanedText = cleanedText.replace(importantMatch[0], '').trim()
  }
  
  if (cleanedText.trim()) {
    finalText = cleanedText
  }
  
  console.log(`[多用户微信机器人] 清理后回复: ${finalText}`)
  console.log(`[多用户微信机器人] 是否保存记忆: ${important}`)
  
  await sendWeixinMessageSplit(token, accountId, from, finalText)
  
  const newMemory = { role: 'user', content: text, time: Date.now() }
  const newReply = { role: 'assistant', content: finalText, time: Date.now() }
  const newChatMemory = [...chatMemory, newMemory, newReply].slice(-16)
  saveUserChatMemory(userId, newChatMemory)
  
  if (important) {
    await saveMemoryIfNeeded(userId, text, finalText)
  }
  
  if (nextAutoMsgMinutes) {
    const nextAutoMsgTimestamp = Date.now() + nextAutoMsgMinutes * 60 * 1000
    saveUserAutoMsgConfig(userId, {
      ...currentAutoMsgConfig,
      nextAutoMsgTime: nextAutoMsgTimestamp
    })
    console.log(`[多用户微信机器人] 用户${userId}下次主动发消息时间已设置: ${new Date(nextAutoMsgTimestamp).toLocaleString()}`)
  }
}

export async function saveMemoryIfNeeded(userId, userInput, aiOutput) {
  const savePrompt = `用户说: ${userInput}
我回复: ${aiOutput}

这段对话是否重要、值得长期记忆？
请只回复 JSON 格式：{"save":true/false,"reason":"简短原因"}`
  
  let res = await callAI(savePrompt, userId)
  if (!res) return
  try {
    let jsonStr = res
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start !== -1 && end !== -1) jsonStr = jsonStr.slice(start, end + 1)
    const parsed = JSON.parse(jsonStr)
    if (parsed.save) {
      const memDir = loadUserMemoriesDir(userId)
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true })
      const today = new Date()
      const yyyy = today.getFullYear()
      const mm = String(today.getMonth() + 1).padStart(2, '0')
      const dd = String(today.getDate()).padStart(2, '0')
      const fname = `${yyyy}-${mm}-${dd}.json`
      const fpath = path.join(memDir, fname)
      let memories = []
      if (fs.existsSync(fpath)) {
        memories = JSON.parse(fs.readFileSync(fpath, 'utf8'))
      }
      const title = generateSimpleTitle(userInput, aiOutput)
      memories.push({
        id: randomUUID(),
        createdAt: Date.now(),
        title,
        summary: `${userInput} → ${aiOutput}`
      })
      if (memories.length > 3) memories = memories.slice(-3)
      safeWriteFileSync(fpath, JSON.stringify(memories, null, 2))
      console.log(`[多用户微信机器人] 已保存记忆: ${title}`)
    }
  } catch (e) {
    console.warn('[多用户微信机器人] 解析记忆决策失败', e)
  }
}

export function generateSimpleTitle(user, ai) {
  const combined = `${user} ${ai}`.slice(0, 30)
  return combined
}

export function getCurrentMemories(userId) {
  const memDir = loadUserMemoriesDir(userId)
  if (!fs.existsSync(memDir)) return ''
  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 1)
  const all = []
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(memDir, f), 'utf8'))
      arr.forEach(m => {
        all.push(m)
      })
    } catch (e) {
    }
  }
  if (all.length === 0) return '（无记忆）'
  return all.slice(-3).map(m => `- ${m.title}`).join('\n')
}

export function getChatHistoryString(memory) {
  if (!Array.isArray(memory) || memory.length === 0) return '（无历史对话）'
  return memory.slice(-8).map(m => {
    const who = m.role === 'user' ? '对方' : '我'
    const ts = m.time ? new Date(m.time).toLocaleString() : ''
    return `${who}${ts ? ` (${ts})` : ''}: ${m.content}`
  }).join('\n')
}

export async function handleWeixinCommand(userId, cmdText, from, accountId, token, emit) {
  const trimmed = cmdText.trim()
  if (trimmed.startsWith('更改人设')) {
    const rest = trimmed.slice(4).trim()
    if (!rest) {
      await sendWeixinMessageSplit(token, accountId, from, '请在 #更改人设 后面加上你想要设置的人设内容～')
      return true
    }
    const persona = loadUserPersona(userId)
    const newPersona = `${persona}\n\n${rest}`.trim()
    const saveUserPersona = (await import('./account.js')).saveUserPersona
    saveUserPersona(userId, newPersona)
    await sendWeixinMessageSplit(token, accountId, from, '好的！已经帮你更新人设啦～ 来和我聊聊天吧')
    return true
  }
  
  if (trimmed.startsWith('当前人设')) {
    const persona = loadUserPersona(userId)
    await sendWeixinMessageSplit(token, accountId, from, `【当前人设】\n${persona}`)
    return true
  }
  
  if (trimmed.startsWith('清除记忆')) {
    const saveUserChatMemory = (await import('./account.js')).saveUserChatMemory
    saveUserChatMemory(userId, [])
    await sendWeixinMessageSplit(token, accountId, from, '好的！已经帮你清除聊天记忆啦～')
    return true
  }
  
  if (trimmed.startsWith('我的信息')) {
    const chatMemory = loadUserChatMemory(userId)
    const memoriesText = getCurrentMemories(userId)
    const autoConfig = loadUserAutoMsgConfig(userId)
    const info = `【你的信息】
QQ: ${userId}
对话条数: ${Math.floor(chatMemory.length / 2)}
记忆条数: ${memoriesText.split('\n').length - (memoriesText.includes('（无记忆）') ? 0 : 0)}
主动消息: ${autoConfig[AUTO_MSG_ENABLED_KEY] ? '已开启' : '已关闭'}`
    await sendWeixinMessageSplit(token, accountId, from, info)
    return true
  }
  
  if (trimmed.startsWith('配置API')) {
    const parts = trimmed.slice(6).trim().split(/\s+/)
    if (parts.length < 2) {
      await sendWeixinMessageSplit(token, accountId, from, '格式：#配置API [API地址] [密钥] [模型名]\n例如：#配置API https://api.openai.com/v1/chat/completions sk-xxxxx gpt-4')
      return true
    }
    let url = parts[0]
    if (!url.startsWith('http')) url = 'https://' + url
    if (!url.includes('/v1/chat/completions')) url = url.replace(/\/$/, '') + '/v1/chat/completions'
    const key = parts[1]
    const model = parts[2] || 'gpt-4o-mini'
    const saveUserApiConfig = (await import('./account.js')).saveUserApiConfig
    saveUserApiConfig(userId, {
      useCustomApi: false,
      api: { url, key, model }
    })
    userApiStates.set(userId, { useCustomApi: false, api: { url, key, model } })
    await sendWeixinMessageSplit(token, accountId, from, `已保存你的API配置～\n地址: ${url}\n模型: ${model}\n发送 #切换自定义 来使用你的API`)
    return true
  }
  
  if (trimmed.startsWith('切换官方')) {
    const saveUserApiConfig = (await import('./account.js')).saveUserApiConfig
    saveUserApiConfig(userId, { ...(userApiStates.get(userId) || {}), useCustomApi: false })
    userApiStates.set(userId, { ...(userApiStates.get(userId) || {}), useCustomApi: false })
    await sendWeixinMessageSplit(token, accountId, from, '已切换为官方提供的API')
    return true
  }
  
  if (trimmed.startsWith('切换自定义')) {
    const loadUserApiConfig = (await import('./account.js')).loadUserApiConfig
    const config = loadUserApiConfig(userId)
    if (!config?.api?.url || !config?.api?.key) {
      await sendWeixinMessageSplit(token, accountId, from, '你还没有配置API哦～ 发送 #配置API 来配置吧')
      return true
    }
    const saveUserApiConfig = (await import('./account.js')).saveUserApiConfig
    saveUserApiConfig(userId, { ...config, useCustomApi: true })
    userApiStates.set(userId, { ...config, useCustomApi: true })
    await sendWeixinMessageSplit(token, accountId, from, '已切换为你自己的API')
    return true
  }
  
  if (trimmed.startsWith('开启AI主动发送消息')) {
    let autoConfig = loadUserAutoMsgConfig(userId)
    autoConfig[AUTO_MSG_ENABLED_KEY] = true
    const saveUserAutoMsgConfig = (await import('./account.js')).saveUserAutoMsgConfig
    saveUserAutoMsgConfig(userId, autoConfig)
    userNextAutoMsgTime.delete(userId)
    await sendWeixinMessageSplit(token, accountId, from, '好的！我会主动给你发消息的～')
    return true
  }
  
  if (trimmed.startsWith('关闭AI主动发送消息')) {
    let autoConfig = loadUserAutoMsgConfig(userId)
    autoConfig[AUTO_MSG_ENABLED_KEY] = false
    const saveUserAutoMsgConfig = (await import('./account.js')).saveUserAutoMsgConfig
    saveUserAutoMsgConfig(userId, autoConfig)
    await sendWeixinMessageSplit(token, accountId, from, '好的！我不会主动打扰你了～')
    return true
  }
  
  if (trimmed.startsWith('帮助')) {
    const help = `📝 人设与记忆：
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
- #推广 → 推广本项目`
    await sendWeixinMessageSplit(token, accountId, from, help)
    return true
  }
  
  if (trimmed.startsWith('关于')) {
    const about = `【关于】
向日葵AGT - 多用户微信机器人
版本: v13.0.0
作者: 风云科技

项目地址: https://github.com/sunflowermm/XRK-AGT

鸣谢: 陈家锐 (仙桃二中长虹路校区)`
    await sendWeixinMessageSplit(token, accountId, from, about)
    return true
  }
  
  if (trimmed.startsWith('推广')) {
    const promo = `喜欢这个机器人吗？快来推广一下吧！
录制一段你和机器人聊天的视频或图片，发布到抖音等平台～
记得@风云云哦！
快手号: Japappp1`
    await sendWeixinMessageSplit(token, accountId, from, promo)
    return true
  }
  
  return false
}

export async function checkAllUsersForAutoMsg(ctxMap, sendWeixinMessageSplitFunc) {
  console.log('[多用户微信机器人] 检查用户主动消息...')
  for (const [userId, ctx] of ctxMap.entries()) {
    if (!ctx.token || !ctx.accountId) continue
    const autoConfig = loadUserAutoMsgConfig(userId)
    if (!autoConfig[AUTO_MSG_ENABLED_KEY]) continue
    const lastActive = autoConfig[AUTO_MSG_LAST_ACTIVE_KEY] || 0
    const lastSent = autoConfig[AUTO_MSG_LAST_SENT_KEY] || 0
    const now = Date.now()
    const minInterval = 1 * 60 * 60 * 1000
    if (now - lastActive < 30 * 60 * 1000) continue
    if (now - lastSent < minInterval) continue
    let nextTime = userNextAutoMsgTime.get(userId)
    if (!nextTime) {
      nextTime = autoConfig.nextAutoMsgTime || (now + 30 * 60 * 1000 + Math.floor(Math.random() * 60 * 60 * 1000))
      userNextAutoMsgTime.set(userId, nextTime)
    }
    if (now < nextTime) continue
    try {
      await trySendAutoMsg(userId, ctx, sendWeixinMessageSplitFunc)
      saveUserAutoMsgConfig(userId, {
        ...autoConfig,
        [AUTO_MSG_LAST_SENT_KEY]: now
      })
      resetUserNextAutoMsgTime(userId)
    } catch (e) {
      console.warn('[多用户微信机器人] 发送主动消息失败', e)
    }
  }
}

export async function trySendAutoMsg(userId, ctx, sendWeixinMessageSplitFunc) {
  const persona = loadUserPersona(userId)
  const chatMemory = loadUserChatMemory(userId)
  const memoriesText = getCurrentMemories(userId)
  const historyText = getChatHistoryString(chatMemory)
  const prompt = `【系统人设】
${persona}

【重要规则】
1. 无论谈论的话题是什么，请牢记，她是一个人，并非AI或机器造物
2. 说话长度严格限制在1(日常)~2(事物探讨)句话，总字数不超过30字
3. 如果用户一直说她是AI，她会急眼、冷漠
4. 绝对不要一直重复旧话题
5. 绝对不要说自己是AI、机器人等
6. 可以主动开启新话题
7. 回复中绝对不要出现【重要】、【系统】、【规则】、【人设】等字样

【记忆摘要】
${memoriesText}

【历史对话】
${historyText}

【当前状态】
对方已经有一段时间没说话了，请主动发消息开启新话题。语气自然，像真人一样。
要求：
- 只发1-2句话，不超过30字
- 可以问候对方，或者问一个简单的问题
- 口语化表达
- 根据人设的性格和情绪回复
- 不要暴露自己是AI`
  let aiText = await callAI(prompt, userId)
  if (!aiText) {
    logError('主动消息调用AI失败', null, { userId })
    return
  }
  let cleanedText = aiText.replace(/\[.*?\]/g, '').trim()
  if (!cleanedText) cleanedText = aiText
  console.log(`[多用户微信机器人] 用户${userId}主动消息: ${cleanedText}`)
  await sendWeixinMessageSplitFunc(ctx.token, ctx.accountId, ctx.userId, cleanedText)
}

export function resetUserNextAutoMsgTime(userId) {
  const defaultDelay = 30 + Math.floor(Math.random() * 90)
  const nextTime = Date.now() + defaultDelay * 60 * 1000
  userNextAutoMsgTime.set(userId, nextTime)
  saveUserAutoMsgConfig(userId, {
    ...loadUserAutoMsgConfig(userId),
    nextAutoMsgTime: nextTime
  })
  console.log(`[多用户微信机器人] 用户${userId}下次主动发消息时间重置: ${new Date(nextTime).toLocaleString()}`)
}

export function cleanupUserData(userId) {
  userMessageQueues.delete(userId)
  userMessageTimers.delete(userId)
  userNextAutoMsgTime.delete(userId)
  userApiStates.delete(userId)
  userMessageCounts.delete(userId)
  userMessageToday.delete(userId)
}

export function cleanUp() {
  for (const [key, timer] of userMessageTimers.entries()) {
    clearTimeout(timer)
  }
  userMessageQueues.clear()
  userMessageTimers.clear()
  userNextAutoMsgTime.clear()
  userApiStates.clear()
  userMessageCounts.clear()
  userMessageToday.clear()
}