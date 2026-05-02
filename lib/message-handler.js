import {
  MESSAGE_MERGE_WAIT_MS,
  AUTO_MSG_ENABLED_KEY,
  AUTO_MSG_LAST_ACTIVE_KEY,
  AUTO_MSG_LAST_SENT_KEY,
  getBeijingTime,
  getPaused
} from './config.js'
import {
  loadUserAccountConfig,
  loadUserPersona,
  loadUserChatMemory,
  saveUserChatMemory,
  loadUserAutoMsgConfig,
  saveUserAutoMsgConfig
} from './account.js'
import {
  getChatHistoryString,
  getRecentMemoriesString,
  generateSimpleTitle,
  saveMemoryItem,
  formatTimeDiff
} from './utils.js'
import { callAI } from './api.js'
import { sendWeixinMessageSplit } from './weixin.js'
import { processWeixinCommand } from './weixin-commands.js'

// 消息队列状态
const userMessageQueues = new Map()
const userDebounceTimers = new Map()
const userMessageCounts = new Map()
const userMessageToday = new Map()

// AI调用队列 - 限制并发数量
const aiTaskQueue = []
let aiProcessingCount = 0
const MAX_AI_CONCURRENT = 3 // 最多同时3个AI请求

// 处理下一个AI任务
function processNextAiTask() {
  if (aiProcessingCount >= MAX_AI_CONCURRENT || aiTaskQueue.length === 0) {
    return
  }
  
  const task = aiTaskQueue.shift()
  aiProcessingCount++
  
  // 异步执行AI调用，不阻塞主流程
  runAiTask(task).finally(() => {
    aiProcessingCount--
    processNextAiTask()
  })
}

// 执行单个AI任务
async function runAiTask(task) {
  try {
    await task.handler()
  } catch (err) {
    console.error('[多用户微信机器人] AI任务执行失败', err)
  }
}

// 添加AI任务到队列
function addAiTask(handler) {
  aiTaskQueue.push({ handler, time: Date.now() })
  processNextAiTask()
}

export function addToMessageQueue(userId, from, text, contextToken, accountId, token) {
  // 检查暂停状态
  if (getPaused()) {
    console.log(`[多用户微信机器人] 系统已暂停，跳过用户${userId}的消息`)
    return
  }
  
  const userKey = `${userId}_${from}`
  
  if (!userMessageQueues.has(userKey)) {
    userMessageQueues.set(userKey, [])
  }
  userMessageQueues.get(userKey).push({
    from,
    content: text,
    contextToken,
    accountId,
    token,
    time: Date.now()
  })
  
  if (userDebounceTimers.has(userKey)) {
    clearTimeout(userDebounceTimers.get(userKey))
  }
  
  const timer = setTimeout(async () => {
    await processMergedMessages(userId, userKey)
  }, MESSAGE_MERGE_WAIT_MS)
  
  userDebounceTimers.set(userKey, timer)
  
  console.log(`[多用户微信机器人] 用户${userId} 消息已加入队列，当前队列长度：${userMessageQueues.get(userKey).length}`)
}

export async function processMergedMessages(userId, userKey) {
  const messages = userMessageQueues.get(userKey) || []
  userMessageQueues.delete(userKey)
  userDebounceTimers.delete(userKey)
  
  if (messages.length === 0) return
  
  const firstMessage = messages[0]
  const lastMessage = messages[messages.length - 1]
  const from = firstMessage.from
  const contextToken = lastMessage.contextToken
  const accountId = firstMessage.accountId || ''
  const token = firstMessage.token || ''
  
  const mergedText = messages.map(m => m.content).join('\n')
  console.log(`[多用户微信机器人] 用户${userId} 开始处理合并消息，共 ${messages.length} 条`)
  
  // 更新用户最后活跃时间
  updateUserLastActive(userId)
  
  // 检查是否是命令
  const isCommand = await processWeixinCommand(mergedText, userId, from, accountId, token)
  
  if (!isCommand) {
    await processNormalChat(userId, from, accountId, token, mergedText, contextToken)
  }
}

function updateUserLastActive(userId) {
  let autoMsgConfig = loadUserAutoMsgConfig(userId)
  saveUserAutoMsgConfig(userId, { ...autoMsgConfig, [AUTO_MSG_LAST_ACTIVE_KEY]: Date.now() })
}

async function processNormalChat(userId, from, accountId, token, mergedText, contextToken) {
  // 将AI调用包装成任务添加到队列，立即返回避免阻塞
  addAiTask(async () => {
    await processNormalChatInternal(userId, from, accountId, token, mergedText, contextToken)
  })
}

// 实际的AI聊天处理（内部函数）
async function processNormalChatInternal(userId, from, accountId, token, mergedText, contextToken) {
  const persona = loadUserPersona(userId)
  const chatMemory = loadUserChatMemory(userId)
  const historyText = getChatHistoryString(chatMemory)
  const memoriesText = getRecentMemoriesString(userId)
  const beijingTime = getBeijingTime()
  
  const prompt = 
    `你现在就是这个人，完全按照人设说话，别让人看出你是AI：

【你的人设】
${persona}

【现在的时间】${beijingTime.full}

${memoriesText ? memoriesText : ''}

【刚才的聊天记录】
${historyText ? historyText : ''}

────────────────

用户说：
${mergedText}

回复格式：
1. 先判断这段对话是否重要（重要→true，不重要→false）
2. 然后是你的回复内容
3. 最后，决定你下次想主动给用户发消息的时间（从现在开始的30分钟到2小时之间，只写分钟数，比如：45分钟、60分钟、90分钟等）
4. 完整格式：
[重要：true/false]
[你的回复内容]
[下次主动发消息：XX分钟]

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
  let aiText = await callAI(prompt, userId)
  
  if (!aiText) {
    await sendWeixinMessageSplit(token, accountId, from, '呜...对话被风云吃掉了🥺')
    return
  }
  
  console.log('[多用户微信机器人] AI已回复')
  
  let isImportant = false
  let finalResponse = aiText.trim()
  let nextAutoMsgMinutes = 30 + Math.floor(Math.random() * 90) // 默认30-120分钟
  
  // 先提取特殊标签（在清理括号之前）
  // 1. 提取下次主动发消息的时间
  const nextTimeMatch = finalResponse.match(/\[下次主动发消息[：:]\s*(\d+)\s*(分|分钟)?\s*\]/i)
  if (nextTimeMatch) {
    nextAutoMsgMinutes = parseInt(nextTimeMatch[1])
    if (nextAutoMsgMinutes < 30) nextAutoMsgMinutes = 30
    if (nextAutoMsgMinutes > 120) nextAutoMsgMinutes = 120
    finalResponse = finalResponse.replace(nextTimeMatch[0], '').trim()
  }
  
  // 2. 提取重要性标签
  const importantMatch = finalResponse.match(/\[重要[：:]\s*(true|false)\s*\]/i)
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
  
  // 移除空行
  finalResponse = finalResponse.replace(/\n\s*\n/g, '\n').trim()
  
  console.log('[多用户微信机器人] 是否保存记忆：', isImportant)
  
  // 如果清理后回复是空的，使用清理标签后的纯文本
  if (!finalResponse || !finalResponse.trim()) {
    finalResponse = aiText.replace(/\[重要[：:]\s*(true|false)\s*\]/gi, '')
                              .replace(/\[下次主动发消息[：:]\s*\d+\s*(分|分钟)?\s*\]/gi, '')
                              .trim()
  }
  
  // 添加到聊天记录
  const newChatMemory = [
    ...chatMemory,
    { role: 'user', content: mergedText, time: Date.now() },
    { role: 'assistant', content: finalResponse, time: Date.now() }
  ].slice(-32)
  saveUserChatMemory(userId, newChatMemory)
  
  // 只有AI判断重要的才保存记忆
  if (isImportant) {
    const memoryTitle = generateSimpleTitle(mergedText, finalResponse)
    saveMemoryItem(userId, {
      title: memoryTitle,
      importance: 'normal',
      type: 'chat',
      content: `${mergedText}\n───\n${finalResponse}`,
      userText: mergedText,
      assistantText: finalResponse
    })
  }
  
  // 保存下次主动发消息时间
  const nextAutoMsgTimestamp = Date.now() + nextAutoMsgMinutes * 60 * 1000
  let autoMsgConfig = loadUserAutoMsgConfig(userId)
  saveUserAutoMsgConfig(userId, { ...autoMsgConfig, nextAutoMsgTime: nextAutoMsgTimestamp })
  console.log(`[多用户微信机器人] 用户${userId} 下次主动发消息时间已设置：${new Date(nextAutoMsgTimestamp).toLocaleString()}`)
  
  // 发送微信消息
  console.log('[多用户微信机器人] 准备发送微信消息...')
  await sendWeixinMessageSplit(token, accountId, from, finalResponse)
  console.log('[多用户微信机器人] 微信消息发送完成')
}

// 清理用户数据
export function cleanupUserData(userId) {
  const userIdStr = String(userId)
  
  for (const [key, timer] of userDebounceTimers.entries()) {
    if (key.startsWith(userIdStr + '_')) {
      clearTimeout(timer)
      userDebounceTimers.delete(key)
    }
  }
  
  for (const key of userMessageQueues.keys()) {
    if (key.startsWith(userIdStr + '_')) {
      userMessageQueues.delete(key)
    }
  }
  
  userMessageCounts.delete(userIdStr)
  userMessageToday.delete(userIdStr)
  
  console.log(`[多用户微信机器人] 用户${userId} 缓存数据已清理`)
}

// 清理所有数据
export function cleanUpAll() {
  for (const timer of userDebounceTimers.values()) {
    clearTimeout(timer)
  }
  
  userMessageQueues.clear()
  userDebounceTimers.clear()
  userMessageCounts.clear()
  userMessageToday.clear()
}