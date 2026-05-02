import fs from 'node:fs'
import path from 'node:path'
import plugin from 'yunzai'

// 导入模块化功能
import { DATA_DIR, TEMP_DIR, DEFAULT_PERSONA_FILE, getBeijingTime } from './lib/config.js'
import {
  loadUserAccountConfig,
  saveUserAccountConfig,
  loadUserPersona,
  saveUserPersona,
  loadUserChatMemory,
  saveUserChatMemory,
  getAllAccounts,
  deleteUserDir
} from './lib/account.js'
import { processQQCommand } from './lib/qq-commands.js'
import { cleanUpAll } from './lib/message-handler.js'
import { startAccountMonitorLoop, stopAccountMonitorLoop, accountMonitors } from './lib/account-monitor.js'
import { stopAllLogins } from './lib/login.js'

// 导出插件
export class AIWeixinMultiUser extends plugin {
  constructor() {
    super({
      name: '多用户微信机器人',
      dsc: '独立登录微信的AI聊天机器人，支持人设、记忆、自定义API',
      event: 'message',
      priority: 50,
      rule: [
        {
          reg: '^#登录微信(AI|机器人)?',
          fnc: 'handleLoginQQ'
        },
        {
          reg: '^#查看微信在线',
          fnc: 'handleShowOnline'
        },
        {
          reg: '^#停止微信机器人',
          fnc: 'handleStopRobot'
        },
        {
          reg: '^#关闭微信机器人',
          fnc: 'handleLogoutRobot'
        },
        {
          reg: '^#删除微信账号',
          fnc: 'handleDeleteAccount'
        },
        {
          reg: '^#微信账号列表',
          fnc: 'handleListAccounts'
        },
        {
          reg: '',
          fnc: 'handleMessage',
          log: false
        }
      ]
    })
    
    this.init()
  }
  
  init() {
    // 初始化目录
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true })
    }
    
    // 如果没有默认人设，创建一个
    if (!fs.existsSync(DEFAULT_PERSONA_FILE)) {
      const defaultPersona = '你是一个友好、有趣的微信聊天伙伴，喜欢分享日常，说话自然不生硬。'
      fs.writeFileSync(DEFAULT_PERSONA_FILE, defaultPersona, 'utf8')
    }
    
    // 启动已保存的账号
    this.startSavedAccounts()
  }
  
  async startSavedAccounts() {
    console.log('[多用户微信机器人] 正在启动已保存的账号...')
    const accounts = getAllAccounts()
    let startedCount = 0
    
    for (const acc of accounts) {
      if (acc.enabled !== false && acc.accountId && acc.token) {
        try {
          await startAccountMonitorLoop(acc.userId, acc)
          startedCount++
        } catch (e) {
          console.error(`[多用户微信机器人] 启动账号 ${acc.userId} 失败`, e)
        }
      }
    }
    
    console.log(`[多用户微信机器人] 已启动 ${startedCount} 个账号`)
  }
  
  // QQ命令处理
  async handleLoginQQ(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleShowOnline(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleStopRobot(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleLogoutRobot(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleDeleteAccount(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleListAccounts(e) {
    await processQQCommand(e, this, e.msg)
  }
  
  async handleMessage(e) {
    // 这里可以处理其他消息类型
    return false
  }
}

// 停止钩子
process.on('exit', () => {
  console.log('[多用户微信机器人] 正在清理资源...')
  stopAllLogins()
  cleanUpAll()
  for (const userId of accountMonitors.keys()) {
    stopAccountMonitorLoop(userId)
  }
})