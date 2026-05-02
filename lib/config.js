import path from 'node:path'

const PLUGIN_DIR = path.join(process.cwd(), 'core', 'AI-MultiUser-Core')

export const DATA_DIR = path.join(PLUGIN_DIR, 'accounts')
export const TEMP_DIR = path.join(process.cwd(), 'data', 'temp', 'multiuser-wechat')
export const DEFAULT_PERSONA_FILE = path.join(PLUGIN_DIR, 'default-persona.md')
export const MASTER_FILE = path.join(PLUGIN_DIR, 'masters.json')
export const NAME_BINDING_FILE = path.join(PLUGIN_DIR, 'name-bindings.json')
export const PLUGIN_CONFIG_FILE = path.join(PLUGIN_DIR, 'plugin-config.json')

export const AUTO_MSG_ENABLED_KEY = 'autoMsgEnabled'
export const AUTO_MSG_LAST_ACTIVE_KEY = 'autoMsgLastActive'
export const AUTO_MSG_LAST_SENT_KEY = 'autoMsgLastSent'
export const MESSAGE_MERGE_WAIT_MS = 3000
export const QR_LONG_POLL_TIMEOUT_MS = 35000
export const ACTIVE_LOGIN_TTL_MS = 5 * 60 * 1000
export const API_CHECK_INTERVAL = 120000
export const API_HEALTH_EXPIRE = 10 * 60 * 1000
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_ILINK_BOT_TYPE = '3'
export const CHANNEL_VERSION = '2.1.10'

export function getBeijingTime() {
  const now = new Date()
  const beijingOffset = 8 * 60 * 60 * 1000
  const beijingTime = new Date(now.getTime() + beijingOffset)
  const year = beijingTime.getUTCFullYear()
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0')
  const day = String(beijingTime.getUTCDate()).padStart(2, '0')
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0')
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0')
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0')
  return {
    full: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}:${seconds}`,
    timestamp: beijingTime.getTime(),
    year, month, day, hours, minutes, seconds
  }
}
