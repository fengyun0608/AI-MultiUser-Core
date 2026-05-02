import fs from 'node:fs'
import { PLUGIN_CONFIG_FILE, API_RETRY_TIMES, API_CALL_TIMEOUT_MS, API_HEALTH_CHECK_INTERVAL_MS, API_HEALTH_EXPIRE_MS } from './config.js'
import { loadUserApiConfig } from './account.js'

export const monitorData = {
  apiCalls: 0,
  failedCalls: 0,
  lastCall: null,
  errors: []
}

export function logError(message, error, context = {}) {
  const entry = {
    time: new Date().toISOString(),
    message,
    error: error?.message || String(error),
    stack: error?.stack,
    context
  }
  monitorData.errors.unshift(entry)
  if (monitorData.errors.length > 50) monitorData.errors.pop()
  monitorData.failedCalls++
  console.error(`[多用户微信机器人] ${message}`, entry)
}

export function loadPluginConfig() {
  if (!fs.existsSync(PLUGIN_CONFIG_FILE)) {
    return {
      apis: [
        { url: 'https://api.minewuer.com/v1/chat/completions', key: '', model: 'gpt-4o-mini' }
      ],
      temperature: 0.7,
      maxTokens: 1000
    }
  }
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_CONFIG_FILE, 'utf8'))
  } catch (e) {
    console.warn('[多用户微信机器人] 加载插件配置失败', e)
    return { apis: [], temperature: 0.7, maxTokens: 1000 }
  }
}

export const apiHealth = new Map()
export let currentApiIndex = 0

export function cleanupExpiredApiHealth() {
  const now = Date.now()
  for (const [url, info] of apiHealth.entries()) {
    if (now - info.lastCheck > API_HEALTH_EXPIRE_MS) {
      apiHealth.delete(url)
    }
  }
}

setInterval(cleanupExpiredApiHealth, 5 * 60 * 1000)

export async function checkApiHealth(api) {
  const now = Date.now()
  const cached = apiHealth.get(api.url)
  if (cached && (now - cached.lastCheck) < API_HEALTH_CHECK_INTERVAL_MS) {
    return cached.ok
  }
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(api.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api.key}`
      },
      body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)
    const ok = response.ok || response.status === 429 || response.status === 400
    apiHealth.set(api.url, { ok, lastCheck: now })
    return ok
  } catch (e) {
    apiHealth.set(api.url, { ok: false, lastCheck: now })
    return false
  }
}

export async function callSingleApi(api, prompt, isUserApi = false) {
  monitorData.apiCalls++
  monitorData.lastCall = new Date().toISOString()
  const startTime = Date.now()
  
  try {
    const response = await fetch(api.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api.key}`
      },
      body: JSON.stringify({
        model: api.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 1000
      }),
      signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS)
    })

    if (response.ok) {
      const data = await response.json()
      const duration = Date.now() - startTime
      console.log(`[多用户微信机器人] API ${api.url} 调用成功 (${duration}ms)`)
      
      let result = null
      if (data.choices?.[0]?.message?.content) {
        result = data.choices[0].message.content
      } else if (data.message?.content) {
        result = data.message.content
      } else if (data.content) {
        result = data.content
      } else if (data.text) {
        result = data.text
      } else if (data.response) {
        result = data.response
      }
      
      if (!result && isUserApi) {
        result = JSON.stringify(data)
      }
      
      return result
    } else {
      const errorText = await response.text()
      const duration = Date.now() - startTime
      console.warn(`[多用户微信机器人] API ${api.url} 失败 (${duration}ms): ${response.status}`)
      return null
    }
  } catch (e) {
    const duration = Date.now() - startTime
    console.warn(`[多用户微信机器人] API ${api.url} 异常 (${duration}ms):`, e.message)
    return null
  }
}

export async function callAI(prompt, userId) {
  const userApiConfig = loadUserApiConfig(userId)
  const useUserApi = userApiConfig?.useCustomApi && userApiConfig?.api?.url && userApiConfig?.api?.key
  const pluginConfig = loadPluginConfig()
  
  let apisToUse = []
  if (useUserApi) {
    apisToUse = [userApiConfig.api]
  } else {
    apisToUse = pluginConfig.apis || []
    if (apisToUse.length === 0) {
      console.error('[多用户微信机器人] 没有配置任何 API')
      return null
    }
  }
  
  let availableApis = []
  if (useUserApi) {
    availableApis = apisToUse
  } else {
    for (const api of apisToUse) {
      const ok = await checkApiHealth(api)
      if (ok) availableApis.push(api)
    }
    if (availableApis.length === 0) availableApis = apisToUse
  }
  
  console.log(`[多用户微信机器人] 可用API数量: ${availableApis.length}/${apisToUse.length}`)
  
  let lastApiIndex = currentApiIndex % availableApis.length
  for (let i = 0; i < availableApis.length; i++) {
    const apiIndex = (lastApiIndex + i) % availableApis.length
    const api = availableApis[apiIndex]
    console.log(`[多用户微信机器人] 尝试API: ${api.url}`)
    
    for (let retryCount = 0; retryCount <= API_RETRY_TIMES; retryCount++) {
      const result = await callSingleApi(api, prompt, useUserApi)
      if (result) {
        const originalApiIndex = apisToUse.findIndex(a => a.url === api.url)
        currentApiIndex = originalApiIndex + 1
        if (!useUserApi) {
          apiHealth.set(api.url, { ok: true, lastCheck: Date.now() })
        }
        return result
      }
      
      if (retryCount < API_RETRY_TIMES) {
        console.warn(`[多用户微信机器人] API ${api.url} 失败，第 ${retryCount + 1} 次重试...`)
        await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)))
      }
    }
    
    if (!useUserApi) {
      apiHealth.set(api.url, { ok: false, lastCheck: Date.now() })
    }
  }
  
  logError('所有API调用均失败', null, { availableApis: availableApis.length })
  console.error('[多用户微信机器人] 所有API调用均失败')
  return null
}