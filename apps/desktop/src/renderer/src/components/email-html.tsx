// src/renderer/src/components/email-html.tsx
//
// Renders an HTML email body in a sandboxed iframe so the email's own CSS is
// isolated from the app and its scripts cannot run. The sandbox omits
// `allow-scripts` — email <script>/<on*> never executes — but keeps
// `allow-same-origin` so the parent can read scrollHeight to auto-size, and
// `allow-popups(-to-escape-sandbox)` so link clicks open as normal browser
// tabs. No sanitizer dep needed: without allow-scripts there is no code path
// for the email content to execute or reach the parent, even though it shares
// the app's origin.
import { useEffect, useMemo, useRef, useState } from 'react'

// Strip active content and external resources that the sandbox/CSP would
// neutralize anyway, so they neither log to the console nor fire a futile
// blocked request on every render. The iframe sandbox (no allow-scripts)
// remains the real security control — this just keeps the console clean and
// matches what every mail client does to inbound HTML. Inline <style> and
// style="" survive because the app CSP allows 'unsafe-inline'; only external
// <link rel="stylesheet"> (blocked by style-src 'self') is dropped.
export function sanitizeEmailHtml(html: string): string {
  // Parse with the HTML fragment parser via a <template> element. This is
  // available in both the Electron renderer and the test DOM environment.
  // <link>/<style>/<script> survive as fragment children, so we can
  // find and strip them; the browser re-wraps the fragment into a document on
  // srcdoc. No sanitizer dependency needed.
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const root = tpl.content

  root.querySelectorAll('script').forEach((el) => {
    el.remove()
  })

  root.querySelectorAll('link[rel]').forEach((link) => {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    if (!rel.includes('stylesheet')) return
    const href = (link.getAttribute('href') ?? '').trim().toLowerCase()
    if (href.startsWith('http://') || href.startsWith('https://')) link.remove()
  })

  // Drop inline event handlers and javascript: URLs; a sandboxed srcdoc still
  // refuses to run them, but leaving them in logs "Blocked script execution".
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const isJsUrl =
        (name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href') &&
        attr.value.trim().toLowerCase().startsWith('javascript:')
      if (name.startsWith('on') || isJsUrl) el.removeAttribute(attr.name)
    }
  })

  // Fragment parsing drops the doctype; preserve a leading one so
  // standards-mode emails don't flip to quirks. <!doctype ...> has a fixed
  // form, so matching it is robust (not HTML-structure parsing).
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ''
  return doctype ? `${doctype}\n${tpl.innerHTML}` : tpl.innerHTML
}

export function EmailHtml({ html }: { html: string }): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState<number>(160)
  const safeHtml = useMemo(() => sanitizeEmailHtml(html), [html])

  const resize = (): void => {
    const doc = ref.current?.contentDocument
    if (!doc) return
    const h = Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0)
    if (h && h !== height) setHeight(h)
  }

  const onLoad = (): void => {
    const doc = ref.current?.contentDocument
    if (!doc) return
    // Kill the iframe's internal scrollbar (and the default 8px body margin
    // that often trips a few-px overflow). !important overrides inline body
    // styles set by the email. The parent can mutate the embedded doc because
    // the sandbox keeps allow-same-origin (still no allow-scripts, so no email
    // code runs).
    const style = doc.createElement('style')
    style.textContent = 'html,body{overflow:hidden!important;margin:0!important}'
    ;(doc.head ?? doc.documentElement).appendChild(style)
    resize()
  }

  useEffect(() => {
    // Re-measure shortly after load in case web fonts / remote images reflow.
    const t = setTimeout(resize, 400)
    return () => clearTimeout(t)
  })

  return (
    <iframe
      className="mt-3 w-full overflow-hidden rounded-md border border-border/40 bg-white"
      onLoad={onLoad}
      ref={ref}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: srcdoc carries untrusted email HTML, but the sandbox below omits allow-scripts so it cannot execute or escape.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={safeHtml}
      style={{ height }}
      title="email-body"
    />
  )
}
