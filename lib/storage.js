import fs from 'node:fs'
import path from 'node:path'

export function safeWriteFileSync(filePath, content) {
  const tempPath = filePath + '.tmp'
  const backupPath = filePath + '.backup'
  try {
    fs.writeFileSync(tempPath, content, 'utf8')
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath)
    }
    fs.renameSync(tempPath, filePath)
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath)
    }
    return true
  } catch (e) {
    console.error(`[多用户微信机器人] 写入文件失败: ${filePath}`, e)
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, filePath)
    }
    return false
  }
}