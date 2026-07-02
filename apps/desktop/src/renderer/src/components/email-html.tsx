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
import { useEffect, useRef, useState } from 'react'

export function EmailHtml({ html }: { html: string }): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState<number>(160)

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
      srcDoc={html}
      style={{ height }}
      title="email-body"
    />
  )
}
