// .claude/skills/run-desktop/driver.mjs
//
// REPL driver for the SwarmAgents Electron app. macOS only (no xvfb needed).
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
// Resolves playwright-core from the project node_modules (devDependency).
import { _electron as electron } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '../../..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

let app = null
let page = null // the window we currently interact with

function pickWindow(matchUrlSubstr) {
  return app.windows().find((w) => w.url().includes(matchUrlSubstr)) ?? null
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched')
    app = await electron.launch({
      executablePath: electronBin,
      args: ['--no-sandbox', '.'],
      cwd: APP_DIR,
      timeout: 60_000,
    })
    page = await app.firstWindow({ timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded')
    await new Promise((r) => setTimeout(r, 2000))
    console.log('launched. main:', page.url())
  },

  // Open the SEPARATE settings window at a hash route and switch `page` to it.
  // Routes: / (General), /providers, /permissions, /about
  async settings(route) {
    if (!page) return console.log('ERROR: launch first')
    const r = route || '/permissions'
    await page.evaluate((rt) => window.swarm?.openSettings({ initialRoute: rt }), r)
    let win = null
    for (let i = 0; i < 40 && !win; i++) {
      win = pickWindow('settings.html')
      if (!win) await new Promise((res) => setTimeout(res, 500))
    }
    if (!win) return console.log('ERROR: settings window never appeared')
    await win.waitForLoadState('domcontentloaded')
    await win.evaluate((rt) => {
      if (!location.hash.includes(rt)) location.hash = `#${rt}`
    }, r)
    await new Promise((res) => setTimeout(res, 700))
    page = win
    console.log('settings:', win.url())
  },

  // Switch focus between the app's windows by URL substring (e.g. index / settings).
  async use(urlSubstr) {
    if (!app) return console.log('ERROR: launch first')
    const w = pickWindow(urlSubstr || 'index.html')
    if (!w) return console.log('no window matching', urlSubstr, '— have:', app.windows().map((x) => x.url()))
    page = w
    console.log('using:', w.url())
  },

  // Navigate the current page's hash router.
  async goto(hash) {
    if (!page) return console.log('ERROR: launch first')
    await page.evaluate((h) => {
      location.hash = h.startsWith('#') ? h : `#${h}`
    }, hash)
    await new Promise((r) => setTimeout(r, 500))
    console.log('hash:', page.url())
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    // Body is transparent for native vibrancy; inject a solid backdrop so the
    // captured web-contents is legible (the real window shows desktop blur).
    await page.evaluate(() => {
      const dark = document.documentElement.classList.contains('dark')
      document.documentElement.style.background = dark ? '#1d1d1f' : '#ececec'
    })
    const f = path.join(SHOT_DIR, `${name || `ss-${Date.now()}`}.png`)
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, sel)
    console.log('click', sel, '->', r)
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click()
      return `OK: ${el.tagName}`
    }, text)
    console.log('click-text', JSON.stringify(text), '->', r)
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 30 })
  },
  async press(key) {
    if (page) await page.keyboard.press(key)
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first')
    try {
      await page.waitForSelector(sel, { timeout: 10_000 })
      console.log('found:', sel)
    } catch {
      console.log('TIMEOUT:', sel)
    }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(
      await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null),
    )
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first')
    for (const w of app.windows()) console.log(' ', w.url())
  },

  async quit() {
    if (app) await app.close().catch(() => {})
    app = null
    page = null
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  },
}

const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

// Serialize lines through a queue: piped stdin delivers every line at once, and
// readline won't wait for an async handler — so without this, `settings`/`ss`
// would run before `launch` resolved. Works for both tmux and one-shot pipe.
const queue = []
let pumping = false
let inputClosed = false
async function pump() {
  if (pumping) return
  pumping = true
  while (queue.length) {
    const line = queue.shift()
    const [cmd, ...rest] = line.trim().split(/\s+/)
    if (!cmd) continue
    const fn = COMMANDS[cmd]
    if (!fn) {
      console.log('unknown:', cmd, '— try: help')
      continue
    }
    try {
      await fn(rest.join(' '))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
    if (cmd === 'quit') process.exit(0)
    if (!inputClosed) rl.prompt()
  }
  pumping = false
  // EOF (piped input): only exit once every queued command has run.
  if (inputClosed) {
    await COMMANDS.quit()
    process.exit(0)
  }
}

rl.on('line', (line) => {
  queue.push(line)
  void pump()
})
rl.on('close', () => {
  inputClosed = true
  void pump()
})

console.log('SwarmAgents driver — "help" for commands, "launch" to start')
rl.prompt()
