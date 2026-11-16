/**
 * 语言解析：ACut 的界面语言跟随系统。
 *
 * 优先级：
 *   1. 插件配置里的 `language`（"auto" 或具体语言，用来手动钉死）
 *   2. Electron 的系统语言（app.getSystemLocale，没有就退到 app.getLocale）
 *   3. Node 的 Intl 区域（Intl.DateTimeFormat().resolvedOptions().locale）
 *   4. en
 *
 * 文案本身在 locale/*.json 的 "strings" 里，键是中文原文（client.js 里的 T() 第一个参数），
 * 缺哪个键就自动退回英文，所以新增语言不用改代码。
 *
 * @module dsh-acut/i18n
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCALE_DIR = join(HERE, '..', 'locale')

/** 有独立文案文件的语言（中文简体直接用源码里的原文，不需要文件）。 */
const WITH_FILE = new Set(['en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt', 'zh-Hant'])

/** 界面语言候选，顺序就是 DSH 用户可能用的系统语言。 */
const KNOWN = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt']

const cache = new Map()

/** "zh-TW" / "zh_CN" / "ja-JP" → "zh-Hant" / "zh" / "ja"；认不出来的算英文。 */
export function normalizeLang(tag) {
  const raw = String(tag ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (!raw) return ''
  if (raw.startsWith('zh')) return /hant|tw|hk|mo/.test(raw) ? 'zh-Hant' : 'zh'
  const base = raw.split('-')[0]
  if (KNOWN.includes(base)) return base
  return 'en'
}

/** 取某个语言的文案表（缺文件就是空表 → 全部退回英文）。 */
export function stringsFor(lang) {
  if (cache.has(lang)) return cache.get(lang)
  let strings = {}
  if (WITH_FILE.has(lang)) {
    try {
      const file = join(LOCALE_DIR, `${lang}.json`)
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        if (data && typeof data.strings === 'object' && data.strings) strings = data.strings
      }
    } catch {
      strings = {}
    }
  }
  cache.set(lang, strings)
  return strings
}

/**
 * 解析当前界面语言。
 * @param {string} [explicit] 插件配置里的 language（"auto" 或具体语言）
 * @param {() => Promise<any>} [getElectron] 拿到 Electron 模块的函数（可选）
 */
export async function detectLanguage(explicit, getElectron) {
  const forced = String(explicit ?? '').trim()
  if (forced && forced.toLowerCase() !== 'auto') {
    const lang = normalizeLang(forced) || 'en'
    return { lang, locale: forced, source: 'config' }
  }

  try {
    const el = await getElectron?.()
    const app = el?.app
    const system = app?.getSystemLocale?.() || app?.getLocale?.()
    if (system) {
      return { lang: normalizeLang(system), locale: String(system), source: 'system' }
    }
  } catch {
    /* 不是 Electron 或者接口不在，继续往下试 */
  }

  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().locale
    if (intl) return { lang: normalizeLang(intl), locale: intl, source: 'intl' }
  } catch {
    /* 没有 Intl 就退回英文 */
  }

  return { lang: 'en', locale: 'en', source: 'default' }
}
