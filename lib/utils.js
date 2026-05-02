import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getBeijingTime } from './config.js'
import { ensureUserMemoriesDir, loadUserMemoriesDir, loadUserChatMemory, saveUserChatMemory } from './account.js'
import { safeWriteFileSync } from './storage.js'

// 记忆相关功能
export function generateSimpleTitle(userText, aiText) {
  const combined = (userText + ' ' + aiText).trim()
  if (combined.length <= 20) return combined
  return combined.substring(0, 17) + '...'
}

export function getChatHistoryString(memory) {
  if (!Array.isArray(memory) || memory.length === 0) return ''
  const recentMem = memory.slice(-8)
  const lines = []
  for (let i = 0; i < recentMem.length; i++) {
    const msg = recentMem[i]
    if (msg.role === 'user') {
      lines.push(`对方：${msg.content}`)
    } else if (msg.role === 'assistant') {
      lines.push(`你：${msg.content}`)
    }
  }
  return lines.join('\n')
}

export function getAllMemories(userId) {
  const memDir = loadUserMemoriesDir(userId)
  if (!fs.existsSync(memDir)) return []
  
  const files = fs.readdirSync(memDir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/))
  const memories = []
  
  for (const file of files.sort().reverse()) {
    try {
      const content = fs.readFileSync(path.join(memDir, file), 'utf8')
      const dayMemories = JSON.parse(content)
      if (Array.isArray(dayMemories)) {
        memories.push(...dayMemories.reverse())
      }
    } catch (e) {}
  }
  
  return memories
}

export function getRecentMemoriesString(userId, limit = 3) {
  const memories = getAllMemories(userId).slice(0, limit)
  if (memories.length === 0) return ''
  const lines = ['记住这几件事：']
  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i]
    const importance = mem.importance === 'important' ? '⭐' : ''
    lines.push(`记忆${i + 1}：${mem.title}`)
  }
  return lines.join('\n')
}

export function saveMemoryItem(userId, memoryItem) {
  const memDir = ensureUserMemoriesDir(userId)
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const filename = `${year}-${month}-${day}.json`
  const filepath = path.join(memDir, filename)
  
  const fullMemory = {
    id: randomUUID(),
    createdAt: Date.now(),
    ...memoryItem
  }
  
  let dayMemories = []
  if (fs.existsSync(filepath)) {
    try {
      dayMemories = JSON.parse(fs.readFileSync(filepath, 'utf8'))
      if (!Array.isArray(dayMemories)) dayMemories = []
    } catch (e) {}
  }
  
  dayMemories.push(fullMemory)
  safeWriteFileSync(filepath, JSON.stringify(dayMemories, null, 2))
  console.log(`[多用户微信机器人] 用户${userId} 保存记忆：${memoryItem.title}`)
  return fullMemory
}

export function clearUserMemory(userId) {
  saveUserChatMemory(userId, [])
  
  const memDir = loadUserMemoriesDir(userId)
  if (fs.existsSync(memDir)) {
    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(memDir, file))
      } catch (e) {}
    }
  }
  
  console.log(`[多用户微信机器人] 用户${userId} 聊天记忆和记忆文件已清除`)
}

// 时间格式化相关
export function formatTimeDiff(ms) {
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  
  if (hours > 0) {
    if (remainingMinutes > 0) {
      return `${hours}小时${remainingMinutes}分钟`
    }
    return `${hours}小时`
  }
  return `${minutes}分钟`
}