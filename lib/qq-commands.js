import fs from 'node:fs'
import path from 'node:path'
import { startLogin, stopAllLogins, accountMonitors, activeLogins } from './login.js'
import { loadUserAccountConfig, getAllAccounts, deleteUserDir, saveUserAccountConfig } from './account.js'
import { stopBot, logoutBot, getOnlineList } from './weixin.js'
import { stopAccountMonitorLoop, accountMonitors as monitors } from './account-monitor.js'

export async function processQQCommand(e, pluginInstance, msg) {
  if (!msg) return false
  
  const text = msg.trim().toLowerCase()
  
  if (text.startsWith('#登录微信ai') || text.startsWith('#登录微信')) {
    await handleLogin(e, pluginInstance, msg)
    return true
  }
  
  if (text === '#查看微信在线' || text === '#查看在线') {
    await handleShowOnline(e, pluginInstance)
    return true
  }
  
  if (text === '#停止微信机器人' || text === '#停止机器人') {
    await handleStopRobot(e, pluginInstance)
    return true
  }
  
  if (text === '#关闭微信机器人' || text === '#关闭机器人') {
    await handleLogoutRobot(e, pluginInstance)
    return true
  }
  
  if (text === '#删除微信账号' || text === '#删除账号') {
    await handleDeleteAccount(e, pluginInstance)
    return true
  }
  
  if (text === '#微信账号列表' || text === '#账号列表') {
    await handleListAccounts(e, pluginInstance)
    return true
  }
  
  return false
}

async function handleLogin(e, pluginInstance, msg) {
  const userId = String(e.user_id || e.sender.user_id)
  const messageId = e.message_id || ''
  await startLogin(userId, pluginInstance, messageId, msg)
}

async function handleShowOnline(e, pluginInstance) {
  let account = null
  try {
    const userId = String(e.user_id || e.sender.user_id)
    account = loadUserAccountConfig(userId)
  } catch (e) {
    console.error('[多用户微信机器人] 加载用户配置失败：', e)
  }
  
  if (!account || !account.accountId) {
    await pluginInstance.reply('您还没有登录过微信机器人，请先发送 #登录微信AI')
    return
  }
  
  try {
    const onlineList = await getOnlineList(account.token)
    const isOnline = onlineList.some(a => a.accountId === account.accountId)
    let reply = '📋 在线账号：\n────────────────\n'
    for (const acc of onlineList) {
      const prefix = acc.accountId === account.accountId ? '👤 ' : '   '
      reply += `${prefix}${acc.accountId} ${acc.online ? '✅在线' : '❌离线'}\n`
    }
    await pluginInstance.reply(reply)
  } catch (e) {
    console.error('[多用户微信机器人] 获取在线列表失败：', e)
    await pluginInstance.reply('获取在线列表失败，请稍后重试')
  }
}

async function handleStopRobot(e, pluginInstance) {
  let account = null
  try {
    const userId = String(e.user_id || e.sender.user_id)
    account = loadUserAccountConfig(userId)
  } catch (e) {
    console.error('[多用户微信机器人] 加载用户配置失败：', e)
  }
  
  if (!account || !account.accountId) {
    await pluginInstance.reply('您还没有登录过微信机器人')
    return
  }
  
  try {
    await stopBot(account.token, account.accountId)
    await pluginInstance.reply('已停止微信机器人（不会退出登录）')
  } catch (e) {
    console.error('[多用户微信机器人] 停止失败：', e)
    await pluginInstance.reply('停止失败，请稍后重试')
  }
}

async function handleLogoutRobot(e, pluginInstance) {
  let account = null
  try {
    const userId = String(e.user_id || e.sender.user_id)
    account = loadUserAccountConfig(userId)
  } catch (e) {
    console.error('[多用户微信机器人] 加载用户配置失败：', e)
  }
  
  if (!account || !account.accountId) {
    await pluginInstance.reply('您还没有登录过微信机器人')
    return
  }
  
  try {
    await logoutBot(account.token, account.accountId)
    await pluginInstance.reply('已退出登录')
    
    // 停止监听
    const userId = String(e.user_id || e.sender.user_id)
    stopAccountMonitorLoop(userId)
    
    // 更新配置
    const userAccount = loadUserAccountConfig(userId)
    if (userAccount) {
      userAccount.online = false
      saveUserAccountConfig(userId, userAccount)
    }
  } catch (e) {
    console.error('[多用户微信机器人] 退出登录失败：', e)
    await pluginInstance.reply('退出登录失败，请稍后重试')
  }
}

async function handleDeleteAccount(e, pluginInstance) {
  const userId = String(e.user_id || e.sender.user_id)
  let account = null
  try {
    account = loadUserAccountConfig(userId)
  } catch (e) {
    console.error('[多用户微信机器人] 加载用户配置失败：', e)
  }
  
  if (!account || !account.accountId) {
    await pluginInstance.reply('您还没有登录过微信机器人')
    return
  }
  
  try {
    // 停止机器人
    try {
      await logoutBot(account.token, account.accountId)
    } catch (e) {
      console.warn('[多用户微信机器人] 退出登录失败，继续删除：', e)
    }
    
    // 停止监听
    stopAccountMonitorLoop(userId)
    
    // 删除数据
    deleteUserDir(userId)
    
    await pluginInstance.reply('已删除账号和所有数据')
  } catch (e) {
    console.error('[多用户微信机器人] 删除失败：', e)
    await pluginInstance.reply('删除失败，请稍后重试')
  }
}

async function handleListAccounts(e, pluginInstance) {
  const accounts = getAllAccounts()
  if (accounts.length === 0) {
    await pluginInstance.reply('还没有登录过的账号')
    return
  }
  
  let reply = '📋 已登录的账号：\n────────────────\n'
  for (const acc of accounts) {
    const onlineStatus = acc.online ? '✅在线' : '❌离线'
    const monitorStatus = monitors.has(acc.userId) ? '🔄监听中' : '⏸️未监听'
    reply += `👤 ${acc.userId.slice(-4)}\n`
    reply += `   账号：${acc.accountId || 'N/A'}\n`
    reply += `   状态：${onlineStatus} | ${monitorStatus}\n`
    reply += `   上次活动：${new Date(acc.lastActiveAt || 0).toLocaleString()}\n`
    reply += '────────────────\n'
  }
  await pluginInstance.reply(reply)
}