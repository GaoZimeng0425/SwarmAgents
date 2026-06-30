import type { CodeHighlighterPlugin, ThemeInput } from '@streamdown/code'
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemeRegistrationAny, TokensResult } from 'shiki'
import { bundledLanguages, createHighlighter } from 'shiki'

// @streamdown/code builds its highlighter with shiki's JavaScript regex engine,
// whose async load never resolves in this Electron renderer — the highlight
// callback never fires, so Streamdown's prose code blocks stay on the colourless
// raw fallback (`--sdm-bg: transparent`, empty token styles). The project's own
// CodeBlock (code-block.tsx) uses shiki's default WASM engine and works, so we
// provide an equivalent CodeHighlighterPlugin on the WASM engine for Streamdown.
const DEFAULT_THEMES = ['github-light', 'github-dark'] as [BundledTheme, BundledTheme]

const themeName = (t: ThemeInput): string => (typeof t === 'string' ? t : (t.name ?? 'custom'))

const highlighterCache = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>()
const resultCache = new Map<string, TokensResult>()
const subscribers = new Map<string, Set<(result: TokensResult) => void>>()

const cacheKey = (code: string, lang: string, light: string, dark: string): string => {
  const head = code.slice(0, 100)
  const tail = code.length > 100 ? code.slice(-100) : ''
  return `${lang}:${light}:${dark}:${code.length}:${head}:${tail}`
}

const getHighlighter = (
  lang: BundledLanguage,
  themes: (BundledTheme | ThemeRegistrationAny)[]
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const key = `${lang}:${themes.map((t) => (typeof t === 'string' ? t : (t.name ?? 'custom'))).join(',')}`
  const cached = highlighterCache.get(key)
  if (cached) return cached
  const promise = createHighlighter({ langs: [lang], themes })
  highlighterCache.set(key, promise)
  return promise
}

export const streamdownCodePlugin: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => DEFAULT_THEMES,
  getSupportedLanguages: () => Object.keys(bundledLanguages) as BundledLanguage[],
  supportsLanguage: (language) => language in bundledLanguages,
  highlight: ({ code, language, themes }, callback) => {
    const key = cacheKey(code, language, themeName(themes[0]), themeName(themes[1]))
    const cached = resultCache.get(key)
    if (cached) return cached
    if (callback) {
      const subs = subscribers.get(key) ?? new Set()
      subs.add(callback)
      subscribers.set(key, subs)
    }
    // shiki accepts 'text' for language-less blocks at runtime; it's just not in
    // BundledLanguage's type union, so cast.
    const lang = (language in bundledLanguages ? language : 'text') as BundledLanguage
    void getHighlighter(lang, themes)
      .then((h) => {
        const loaded = (h.getLoadedLanguages().includes(lang) ? lang : 'text') as BundledLanguage
        const result = h.codeToTokens(code, {
          lang: loaded,
          themes: { light: themes[0], dark: themes[1] },
        })
        resultCache.set(key, result)
        const subs = subscribers.get(key)
        if (subs) {
          for (const cb of subs) cb(result)
          subscribers.delete(key)
        }
      })
      .catch((err: unknown) => {
        console.error('[streamdown-code-plugin] highlight failed:', err)
        subscribers.delete(key)
      })
    return null
  },
}
