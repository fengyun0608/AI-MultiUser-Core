import { callAI } from './api.js'
import { getChatHistoryString, getRecentMemoriesString, generateSimpleTitle, saveMemoryItem, formatTimeDiff } from './utils.js'
import { loadUserPersona, loadUserChatMemory, saveUserChatMemory, loadUserAutoMsgConfig, saveUserAutoMsgConfig } from './account.js'
import { sendWeixinMessageSplit, getMessages, markAsRead, getOnlineList, logoutBot } from './weixin.js'
import { getBeijingTime, AUTO_MSG_ENABLED_KEY, AUTO_MSG_LAST_ACTIVE_KEY, AUTO_MSG_LAST_SENT_KEY, getPaused } from './config.js'
import { addToMessageQueue } from './message-handler.js'

export const accountMonitors = new Map()
const lastMessageIds = new Map()

export async function startAccountMonitorLoop(userId, account) {
  if (accountMonitors.has(userId)) {
    console.warn(`[多用户微信机器人] 账号 ${userId} 已有监听运行中`)
    return
  }
  
  console.log(`[多用户微信机器人] 启动账号 ${userId} 监听`)
  
  const poll = async () => {
    if (!accountMonitors.has(userId)) return
    
    try {
      // 检查暂停状态
      if (getPaused()) {
        // 暂停状态下只轮询，不处理消息
        await new Promise(r => setTimeout(r, 30000))
        poll()
        return
      }
      
      const accountCfg = loadUserAccountConfig(userId)
      if (!accountCfg || !accountCfg.accountId) {
        stopAccountMonitorLoop(userId)
        return
      }
      
      // 检查是否在线
      let isOnline = true
      try {
        const onlineList = await getOnlineList(accountCfg.token)
        const acc = onlineList.find(a => a.accountId === accountCfg.accountId)
        isOnline = acc && acc.online
      } catch (e) {
        isOnline = false
      }
      
      if (accountCfg.online !== isOnline) {
        accountCfg.online = isOnline
        saveUserAccountConfig(userId, accountCfg)
      }
      
      if (!isOnline) {
        await new Promise(r => setTimeout(r, 30000))
        poll()
        return
      }
      
      // 获取消息
      const contextToken = accountCfg.currentContextToken
      const result = await getMessages(accountCfg.token, accountCfg.accountId, contextToken, 100)
      
      if (result.messages && result.messages.length > 0) {
        const newMessages = result.messages.filter(m => 
          m.from !== accountCfg.userIdFromWeixin && m.content
        )
        
        if (newMessages.length > 0) {
        console.log(`[多用户微信机器人] 账号 ${userId} 收到 ${newMessages.length} 条新消息`)
        
        for (const msg of newMessages) {
          console.log(`[多用户微信机器人] 用户${userId} 向 AI 发送了一条消息`)
          const ctx = {
            token: accountCfg.token,
            accountId: accountCfg.accountId,
            userId: userId,
            contextToken: contextToken,
            from: msg.from,
            content: msg.content,
            msgId: msg.id
          }
          addToMessageQueue(userId, ctx.from, ctx.content, ctx.contextToken, ctx.accountId, ctx.token)
        }
        
        // 标记已读
        try {
          await markAsRead(accountCfg.token, accountCfg.accountId, contextToken)
        } catch (e) {}
      }
      }
      
      // 更新 contextToken
      if (result.nextContextToken) {
        accountCfg.currentContextToken = result.nextContextToken
        saveUserAccountConfig(userId, accountCfg)
      }
      
      // 检查主动消息
      await checkAutoMessage(userId, accountCfg)
      
    } catch (e) {
      console.error(`[多用户微信机器人] 账号 ${userId} 轮询异常`, e)
      
      // 如果是认证错误，停止监听
      if (e.message && (e.message.includes('401') || e.message.includes('认证'))) {
        stopAccountMonitorLoop(userId)
        return
      }
    }
    
    await new Promise(r => setTimeout(r, 30000))
    poll()
  }
  
  accountMonitors.set(userId, true)
  poll()
}

export function stopAccountMonitorLoop(userId) {
  console.log(`[多用户微信机器人] 停止账号 ${userId} 监听`)
  accountMonitors.delete(userId)
  lastMessageIds.delete(userId)
}

async function checkAutoMessage(userId, accountCfg) {
  // 检查暂停状态
  if (getPaused()) {
    return
  }
  
  const autoConfig = loadUserAutoMsgConfig(userId)
  if (!autoConfig[AUTO_MSG_ENABLED_KEY]) return
  
  const now = Date.now()
  const nextAutoMsgTime = autoConfig.nextAutoMsgTime
  const lastActiveAt = autoConfig[AUTO_MSG_LAST_ACTIVE_KEY] || now
  const lastAutoMsgAt = autoConfig[AUTO_MSG_LAST_SENT_KEY] || 0
  
  if (!nextAutoMsgTime || now < nextAutoMsgTime) return
  
  // 最少间隔 30 分钟，距离上次活跃至少 15 分钟
  const minInterval = 30 * 60 * 1000
  const quietTime = 15 * 60 * 1000
  
  if (now - lastAutoMsgAt < minInterval) return
  if (now - lastActiveAt < quietTime) return
  
  try {
    console.log(`[多用户微信机器人] 用户 ${userId} 尝试发送主动消息`)
    
    const persona = loadUserPersona(userId)
    const chatMem = loadUserChatMemory(userId)
    const historyText = getChatHistoryString(chatMem)
    const memoriesText = getRecentMemoriesString(userId)
    const beijingTime = getBeijingTime()
    
    const prompt = 
`你现在就是这个人，完全按照人设说话，别让人看出你是AI：

【你的人设】
${persona}

【现在的时间】${beijingTime.full}

${memoriesText ? memoriesText : ''}

【之前的聊天记录】
${historyText ? historyText : ''}

任务：你现在想主动给对方发消息，自然一点，就像真人一样，不要太刻意。
直接给出你要发的消息，不要加任何括号，不要带前缀，不要分析。`
    
    const response = await callAI(prompt, userId)
    
    if (response) {
      const cleaned = response.replace(/（[^）]*）/g, '')
                                   .replace(/\([^)]*\)/g, '')
                                   .replace(/\[[^\]]*\]/g, '')
                                   .replace(/<[^>]*>/g, '')
                                   .trim()
      
      if (cleaned) {
        await sendWeixinMessageSplit(accountCfg.token, accountCfg.accountId, accountCfg.userIdFromWeixin, cleaned)
        
        // 保存这次主动消息的记录
        const newChatMem = [
          ...chatMem,
          { role: 'assistant', content: cleaned, time: now }
        ].slice(-32)
        saveUserChatMemory(userId, newChatMem)
        
        console.log(`[多用户微信机器人] 用户 ${userId} 已发送主动消息`)
        
        // 保存记忆，标记为重要
        const memoryTitle = generateSimpleTitle('', cleaned)
        saveMemoryItem(userId, {
          title: memoryTitle,
          importance: 'important',
          type: 'auto',
          content: cleaned,
          userText: '',
          assistantText: cleaned
        })
      }
    }
    
    // 无论是否成功发送，都设置下一次发送时间（更久一点）
    const nextDelay = 60 + Math.floor(Math.random() * 120) // 1-3小时
    saveUserAutoMsgConfig(userId, {
      ...autoConfig,
      nextAutoMsgTime: now + nextDelay * 60 * 1000,
      [AUTO_MSG_LAST_SENT_KEY]: now
    })
    
  } catch (e) {
    console.error(`[多用户微信机器人] 主动消息失败`, e)
    
    // 失败了也设置下一次
    const nextDelay = 60 + Math.floor(Math.random() * 120)
    saveUserAutoMsgConfig(userId, {
      ...autoConfig,
      nextAutoMsgTime: now + nextDelay * 60 * 1000
    })
  }
}