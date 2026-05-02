import puppeteer from 'puppeteer'
import { TEMP_DIR } from './config.js'

let browser = null
let browserRefCount = 0
let browserClosing = false

export async function getBrowser() {
  if (browserClosing) {
    return null
  }
  
  if (browser) {
    try {
      await browser.pages()
      browserRefCount++
      return browser
    } catch (e) {
      console.warn('[多用户微信机器人] 浏览器实例失效，重新启动')
      browser = null
      browserRefCount = 0
    }
  }
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage']
    })
    browserRefCount = 1
    console.log('[多用户微信机器人] Puppeteer 浏览器已启动')
    return browser
  } catch (e) {
    console.error('[多用户微信机器人] 启动浏览器失败', e)
    return null
  }
}

export async function closeBrowser() {
  if (browser && !browserClosing) {
    browserClosing = true
    try {
      console.log('[多用户微信机器人] 关闭 Puppeteer 浏览器')
      const pages = await browser.pages()
      await Promise.all(pages.map(p => p.close().catch(() => {})))
      await browser.close()
    } catch (e) {
      console.error('[多用户微信机器人] 关闭浏览器失败', e)
    } finally {
      browser = null
      browserRefCount = 0
      browserClosing = false
    }
  }
}

export async function releaseBrowser() {
  browserRefCount--
}

export async function screenshotUrl(url, filepath) {
  let page = null
  try {
    const br = await getBrowser()
    if (!br) {
      throw new Error('浏览器不可用')
    }
    
    page = await br.newPage()
    await page.setViewport({ width: 400, height: 600 })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 })
    await page.evaluate(() => new Promise(r => setTimeout(r, 1000)))
    await page.screenshot({ path: filepath, type: 'png' })
    return filepath
  } catch (e) {
    console.error('[多用户微信机器人] 截图失败', e)
    throw e
  } finally {
    if (page) {
      try {
        await page.close()
      } catch (e) {
      }
    }
    await releaseBrowser()
  }
}