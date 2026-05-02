import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  TEMP_DIR,
  QR_LONG_POLL_TIMEOUT_MS,
  ACTIVE_LOGIN_TTL_MS
} from './config.js'
import { screenshotUrl } from './browser.js'
import {
  loadUserAccountConfig,
  saveUserAccountConfig,
  getAllAccounts,
  deleteUserDir
} from './account.js'
import {
  qrcode,
  longpollCheck,
  startBot,
  stopBot,
  logoutBot,
  getOnlineList,
  sendWeixinMessageSplit
} from './weixin.js'
import { startAccountMonitorLoop, accountMonitors } from './account-monitor.js'

const activeLogins = new Map()

export async function startLogin(userId, pluginInstance, messageId, rawMsg) {
  // 先检查是否已经登录且在运行中
  const existingAccount = loadUserAccountConfig(userId)
  if (existingAccount?.accountId && existingAccount?.online) {
    try {
      const onlineList = await getOnlineList(existingAccount.token)
      const stillOnline = onlineList.some(a => a.accountId === existingAccount.accountId)
      
      if (stillOnline) {
        await pluginInstance.reply('您当前已在登录运行中，请勿重复登录～')
        return
      }
    } catch (e) {
      console.error('[多用户微信机器人] 检查在线状态失败：', e)
    }
  }
  
  // 获取token
  let token = null
  
  // 尝试从QQ消息中提取token
  if (rawMsg) {
    const tokenMatch = rawMsg.match(/sk-[^\s]+/i)
    if (tokenMatch) {
      token = tokenMatch[0]
    }
  }
  
  // 如果没找到，尝试从用户配置中获取
  if (!token && existingAccount?.token) {
    token = existingAccount.token
  }
  
  // 如果还是没有，提示用户
  if (!token) {
    await pluginInstance.reply('请在登录命令中带上你的API Token，比如：#登录微信AI sk-xxxxx')
    return
  }
  
  await pluginInstance.reply('正在获取二维码...')
  
  try {
    const qrResult = await qrcode(token)
    const qrcodeId = qrResult.qrcodeId
    const qrcodeUrl = qrResult.url
    const qrcodeBase64 = qrResult.qrcodeBase64
    
    const loginId = randomUUID()
    activeLogins.set(loginId, {
      userId,
      token,
      qrcodeId,
      qrcodeUrl,
      createdAt: Date.now(),
      pluginInstance,
      messageId
    })
    
    // 发送二维码
    if (qrcodeBase64) {
      try {
        const tempPath = path.join(TEMP_DIR, `qrcode-${loginId}.png`)
        const dataStart = qrcodeBase64.indexOf(',')
        const base64Data = dataStart !== -1 ? qrcodeBase64.substring(dataStart + 1) : qrcodeBase64
        const buffer = Buffer.from(base64Data, 'base64')
        fs.writeFileSync(tempPath, buffer)
        await pluginInstance.reply([
          '二维码已生成，请使用微信扫描登录',
          { type: 'image', file: `file://${tempPath}` }
        ])
        
        // 2分钟后删除临时文件
        setTimeout(() => {
          try { fs.unlinkSync(tempPath) } catch (e) {}
        }, 120000)
      } catch (e) {
        console.error('[多用户微信机器人] 发送二维码图片失败：', e)
        await pluginInstance.reply([
          '二维码已生成，请使用微信扫描登录',
          qrcodeUrl
        ])
      }
    } else if (qrcodeUrl) {
      try {
        const tempPath = path.join(TEMP_DIR, `qrcode-${loginId}.png`)
        await screenshotUrl(qrcodeUrl, tempPath)
        await pluginInstance.reply([
          '二维码已生成，请使用微信扫描登录',
          { type: 'image', file: `file://${tempPath}` }
        ])
        
        setTimeout(() => {
          try { fs.unlinkSync(tempPath) } catch (e) {}
        }, 120000)
      } catch (e) {
        console.warn('[多用户微信机器人] 截图二维码失败，使用文本链接：', e)
        await pluginInstance.reply(`二维码已生成，请访问：${qrcodeUrl}`)
      }
    } else {
      await pluginInstance.reply('获取二维码失败，请稍后重试')
      return
    }
    
    // 开始轮询登录状态
    pollLoginStatus(loginId)
    
  } catch (e) {
    console.error('[多用户微信机器人] 登录失败：', e)
    await pluginInstance.reply('获取二维码失败，请稍后重试')
  }
}

async function pollLoginStatus(loginId) {
  while (activeLogins.has(loginId)) {
    const state = activeLogins.get(loginId)
    if (!state) break
    
    // 检查是否超时
    if (Date.now() - state.createdAt > ACTIVE_LOGIN_TTL_MS) {
      console.log('[多用户微信机器人] 二维码超时')
      try {
        await state.pluginInstance.reply('登录超时，请重新发送 #登录微信AI')
      } catch (e) {}
      activeLogins.delete(loginId)
      break
    }
    
    try {
      const data = await longpollCheck(state.token, state.qrcodeId)
      
      if (!data || !data.status) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      
      const status = data.status
      
      if (status === 'waitScan') {
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      
      if (status === 'scaned') {
        console.log('[多用户微信机器人] 已扫码，等待确认')
        try {
          await state.pluginInstance.reply('已扫码，请在微信中确认登录！')
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 2000))
        continue
      }
      
      if (status === 'scanedButRedirect') {
        if (data.redirectHost) {
          state.currentApiBaseUrl = `https://${data.redirectHost}`
          console.log('[多用户微信机器人] 重定向到 ' + state.currentApiBaseUrl)
        }
        continue
      }
      
      if (status === 'expired') {
        console.log('[多用户微信机器人] 二维码超时')
        try {
          await state.pluginInstance.reply('二维码已过期，请重新发送 #登录微信AI')
        } catch (e) {}
        activeLogins.delete(loginId)
        break
      }
      
      if (status === 'confirmed') {
        // 登录成功
        if (!data.accountId) {
          console.error('[多用户微信机器人] 登录成功但缺少accountId')
          try {
            await state.pluginInstance.reply('登录失败：未获取到账号信息')
          } catch (e) {}
          activeLogins.delete(loginId)
          break
        }
        
        console.log('[多用户微信机器人] 登录成功！accountId=' + data.accountId)
        
        // 保存账号
        const existingAccount = loadUserAccountConfig(state.userId)
        const newAccountData = {
          userId: state.userId,
          accountId: data.accountId,
          token: state.token,
          baseUrl: data.baseUrl || 'https://ilinkai.weixin.qq.com',
          userIdFromWeixin: data.userIdFromWeixin,
          createdAt: existingAccount?.createdAt || Date.now(),
          lastActiveAt: Date.now(),
          enabled: true,
          online: true
        }
        
        saveUserAccountConfig(state.userId, newAccountData)
        activeLogins.delete(loginId)
        
        // 通知用户
        try {
          let replyMsg = '✅ 登录成功！微信机器人已启动！\n\n'
          replyMsg += '💡 提示：现在可以发送 #更改人设 来设置你的专属人设哦！\n'
          replyMsg += '（也可以发送 #当前人设 来查看当前人设）'
          
          await state.pluginInstance.reply(replyMsg)
        } catch (e) {
          console.error('[多用户微信机器人] 通知用户登录成功失败：', e)
        }
        
        // 发送登录成功后的欢迎消息和指令
        try {
          await sendWelcomeInstructions(state.userId, data.accountId, state.token)
        } catch (e) {
          console.error('[多用户微信机器人] 发送欢迎消息失败：', e)
        }
        
        // 启动监听
        startAccountMonitorLoop(state.userId, newAccountData)
        
        break
      }
      
    } catch (e) {
      console.error('[多用户微信机器人] 轮询失败：', e)
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
}

async function sendWelcomeInstructions(userId, accountId, token) {
  const welcomeText = 
    '🎉 恭喜登录成功！这里是我的指令说明：\n\n' +
    '📝 人设与记忆\n' +
    '#更改人设 [内容] → 修改我的人设描述\n' +
    '#当前人设 → 查看当前人设\n' +
    '#清除记忆 → 清除聊天记忆\n' +
    '#我的信息 → 查看你的信息\n\n' +
    '⚙️ API配置\n' +
    '#配置API [url] [key] [model] → 配置你的自定义API\n' +
    '#切换官方 → 使用官方API\n' +
    '#切换自定义 → 使用你配置的API\n\n' +
    '💬 主动消息\n' +
    '#开启AI主动发送消息 → 开启主动消息\n' +
    '#关闭AI主动发送消息 → 关闭主动消息\n\n' +
    '🎮 其他\n' +
    '#帮助 → 显示帮助信息\n' +
    '#关于 → 关于本机器人\n' +
    '#推广 → 推广本项目\n\n' +
    '直接发消息就能和我聊天啦！快来和我说话吧！'
  
  await sendWeixinMessageSplit(token, accountId, userId, welcomeText)
  console.log('[多用户微信机器人] 已向用户发送登录成功后的指令说明')
}

export function stopAllLogins() {
  activeLogins.clear()
}

export { activeLogins, accountMonitors }