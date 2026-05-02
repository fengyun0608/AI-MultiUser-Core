import fs from 'node:fs'
import { MASTER_FILE, NAME_BINDING_FILE } from './config.js'
import { safeWriteFileSync } from './storage.js'

export function loadMasters() {
  if (!fs.existsSync(MASTER_FILE)) {
    return []
  }
  try {
    const content = fs.readFileSync(MASTER_FILE, 'utf8')
    const data = JSON.parse(content)
    return Array.isArray(data.qqList) ? data.qqList : []
  } catch (e) {
    console.warn('[多用户微信机器人] 加载管理员列表失败', e)
    return []
  }
}

export function isAdmin(userId) {
  const masters = loadMasters()
  return masters.includes(String(userId))
}

export function loadNameBindings() {
  if (!fs.existsSync(NAME_BINDING_FILE)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(NAME_BINDING_FILE, 'utf8'))
  } catch (e) {
    console.warn('[多用户微信机器人] 加载名称绑定失败', e)
    return {}
  }
}

export function saveNameBindings(bindings) {
  return safeWriteFileSync(NAME_BINDING_FILE, JSON.stringify(bindings, null, 2))
}