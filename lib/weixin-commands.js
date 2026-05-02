import { sendWeixinMessageSplit } from './weixin.js'
import {
  loadUserPersona,
  saveUserPersona,
  loadUserChatMemory,
  saveUserChatMemory,
  loadUserAutoMsgConfig,
  saveUserAutoMsgConfig,
  loadUserApiConfig,
  saveUserApiConfig
} from './account.js'
import { clearUserMemory, getAllMemories } from './utils.js'
import { AUTO_MSG_ENABLED_KEY } from './config.js'

export async function processWeixinCommand(text, userId, from, accountId, token) {
  const trimmed = text.trim()
  
  if (trimmed.startsWith('#')) {
    const cmdText = trimmed.substring(1).trim()
    const cmd = cmdText.toLowerCase()
    
    if (cmd.startsWith('修改人设') || cmd.startsWith('更改人设')) {
      await handleChangePersona(cmdText, userId, from, accountId, token)
      return true
    }
    
    if (cmd === '当前人设') {
      await handleShowCurrentPersona(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '清除记忆') {
      await handleClearMemory(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '我的信息') {
      await handleMyInfo(userId, from, accountId, token)
      return true
    }
    
    if (cmd.startsWith('配置api')) {
      await handleConfigureApi(cmdText, userId, from, accountId, token)
      return true
    }
    
    if (cmd === '切换官方') {
      await handleSwitchToOfficial(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '切换自定义') {
      await handleSwitchToCustom(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '开启ai主动发送消息') {
      await handleEnableAutoMsg(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '关闭ai主动发送消息') {
      await handleDisableAutoMsg(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '帮助') {
      await handleHelp(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '关于') {
      await handleAbout(userId, from, accountId, token)
      return true
    }
    
    if (cmd === '推广') {
      await handlePromotion(userId, from, accountId, token)
      return true
    }
  }
  
  return false
}

async function handleChangePersona(cmdText, userId, from, accountId, token) {
  let newPersonaText = cmdText.substring(cmdText.indexOf('人设') + 2).trim()
  
  if (!newPersonaText) {
    await sendWeixinMessageSplit(token, accountId, from, '请在 #修改人设/更改人设 后面加上你想要设置的人设内容！')
    return
  }
  
  const currentPersona = loadUserPersona(userId)
  const newPersona = `${currentPersona}\n\n${newPersonaText}`.trim()
  saveUserPersona(userId, newPersona)
  await sendWeixinMessageSplit(token, accountId, from, '好的！已经帮你更新人设了！快来和我聊聊天吧！')
}

async function handleShowCurrentPersona(userId, from, accountId, token) {
  const persona = loadUserPersona(userId)
  await sendWeixinMessageSplit(token, accountId, from, `👤 当前人设\n────────────────\n${persona}`)
}

async function handleClearMemory(userId, from, accountId, token) {
  clearUserMemory(userId)
  await sendWeixinMessageSplit(token, accountId, from, '好的！已经帮你清除聊天记忆了！')
}

async function handleMyInfo(userId, from, accountId, token) {
  const chatMemory = loadUserChatMemory(userId)
  const allMemories = getAllMemories(userId)
  const autoMsgConfig = loadUserAutoMsgConfig(userId)
  
  let infoText = '📊 我的信息\n────────────────\n'
  infoText += `对话条数：${Math.floor(chatMemory.length / 2)}\n`
  infoText += `记忆条数：${allMemories.length}\n`
  infoText += `AI主动发消息：${autoMsgConfig[AUTO_MSG_ENABLED_KEY] ? '✅ 已开启' : '❌ 已关闭'}\n`
  
  await sendWeixinMessageSplit(token, accountId, from, infoText)
}

async function handleConfigureApi(cmdText, userId, from, accountId, token) {
  const parts = cmdText.substring(cmdText.indexOf('api') + 3).trim().split(/\s+/)
  if (parts.length < 2) {
    await sendWeixinMessageSplit(token, accountId, from, 
      '格式：#配置api API地址 密钥 [模型]\n\n示例：#配置api https://api.example.com sk-xxxxx gpt-4')
    return
  }
  
  let apiUrl = parts[0]
  const apiKey = parts[1]
  const apiModel = parts[2] || 'gpt-4'
  
  if (!apiUrl.startsWith('http')) {
    apiUrl = 'https://' + apiUrl
  }
  
  if (!apiUrl.includes('/chat/completions')) {
    if (apiUrl.endsWith('/v1')) {
      apiUrl = apiUrl + '/chat/completions'
    } else if (apiUrl.endsWith('/v1/')) {
      apiUrl = apiUrl + 'chat/completions'
    } else if (apiUrl.endsWith('/')) {
      apiUrl = apiUrl + 'v1/chat/completions'
    } else {
      apiUrl = apiUrl + '/v1/chat/completions'
    }
  }
  
  saveUserApiConfig(userId, {
    enabled: true,
    apis: [{ url: apiUrl, key: apiKey, model: apiModel }]
  })
  
  await sendWeixinMessageSplit(token, accountId, from, 
    `✅ API配置成功！\n\n地址：${apiUrl}\n模型：${apiModel}\n\n已自动切换到自定义API！`)
}

async function handleSwitchToOfficial(userId, from, accountId, token) {
  const currentConfig = loadUserApiConfig(userId) || {}
  saveUserApiConfig(userId, { ...currentConfig, enabled: false })
  await sendWeixinMessageSplit(token, accountId, from, '已切换为官方提供的API！')
}

async function handleSwitchToCustom(userId, from, accountId, token) {
  const currentConfig = loadUserApiConfig(userId) || {}
  
  if (!currentConfig.apis || currentConfig.apis.length === 0) {
    await sendWeixinMessageSplit(token, accountId, from, 
      '还没有配置自定义API！请先使用 #配置api 来配置！')
    return
  }
  
  saveUserApiConfig(userId, { ...currentConfig, enabled: true })
  await sendWeixinMessageSplit(token, accountId, from, '已切换为你自己的API！')
}

async function handleEnableAutoMsg(userId, from, accountId, token) {
  let autoMsgConfig = loadUserAutoMsgConfig(userId)
  saveUserAutoMsgConfig(userId, { ...autoMsgConfig, [AUTO_MSG_ENABLED_KEY]: true })
  await sendWeixinMessageSplit(token, accountId, from, 
    '✅ 已开启AI主动发消息！每次和你聊天后，AI会自己决定下次什么时候主动找你！')
}

async function handleDisableAutoMsg(userId, from, accountId, token) {
  let autoMsgConfig = loadUserAutoMsgConfig(userId)
  saveUserAutoMsgConfig(userId, { ...autoMsgConfig, [AUTO_MSG_ENABLED_KEY]: false })
  await sendWeixinMessageSplit(token, accountId, from, '已关闭AI主动发消息！')
}

async function handleHelp(userId, from, accountId, token) {
  const helpText = 
    `📱 人设与记忆\n#更改人设 [人设内容] → 修改我的人设描述\n#当前人设 → 查看当前人设\n#清除记忆 → 清除聊天记忆\n#我的信息 → 查看你的信息\n\n` +
    `⚙️ API配置\n#配置api [url] [key] [model] → 配置你的自定义API\n#切换官方 → 使用官方API\n#切换自定义 → 使用你配置的API\n\n` +
    `💬 主动消息\n#开启ai主动发送消息 → 开启主动消息\n#关闭ai主动发送消息 → 关闭主动消息\n\n` +
    `🎮 其他\n#帮助 → 显示帮助信息\n#关于 → 关于本机器人\n#推广 → 推广本项目`
  
  await sendWeixinMessageSplit(token, accountId, from, helpText)
}

async function handleAbout(userId, from, accountId, token) {
  const aboutText = 
    `🌸 关于多用户微信机器人\n\n` +
    `👤 开发者\n` +
    `本插件由 风云科技 开发制作，专注于打造优秀的智能机器人体验！\n\n` +
    `📋 项目介绍\n` +
    `这是一个基于 XRK-AGT 框架的多用户微信机器人系统，支持独立登录、独立人设配置和聊天记忆管理。\n\n` +
    `🛠️ 技术框架\n` +
    `• XRK-AGT - 智能机器人框架\n` +
    `• OpenClaw Weixin API - 微信消息接口\n` +
    `• 完全使用 JavaScript 开发\n\n` +
    `📜 开源说明\n` +
    `本项目采用 MIT 许可证开源，完全免费！任何人都可以自由使用、修改和分发。\n\n` +
    `💖 祝您使用愉快！`
  
  await sendWeixinMessageSplit(token, accountId, from, aboutText)
}

async function handlePromotion(userId, from, accountId, token) {
  const promoText = 
    `🎉 推广计划\n\n` +
    `💫 如果你喜欢这个机器人，欢迎帮我们宣传！\n\n` +
    `📱 如何推广\n` +
    `1. 截取一张你和机器人聊天的图片，或录制一段视频\n` +
    `2. 发布到抖音、快手等平台\n` +
    `3. 在视频或文案中 @风云云\n` +
    `4. 抖音号：35380349051\n` +
    `5. 快手号：Japappp1\n\n` +
    `🎁 推广文案参考\n` +
    `「发现一个超级好玩的微信机器人！可以自己设定人设，聊天像真人一样！完全免费使用，快来试试吧！」\n\n` +
    `🙏 感谢支持\n` +
    `你的每一次分享都是对我们最大的认可！让更多人发现这个有趣的项目吧！`
  
  await sendWeixinMessageSplit(token, accountId, from, promoText)
}