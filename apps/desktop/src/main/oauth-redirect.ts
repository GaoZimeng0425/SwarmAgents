// src/main/oauth-redirect.ts
//
// Shared HTML pages for the OAuth loopback redirect (gmail + calendar). The
// browser lands here after Google redirects back to 127.0.0.1. Success
// confirms the link; failure surfaces the real error so the user (and the
// log) can see WHY it failed, instead of a black-box "check the app".
const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #f5f5f7; color: #1d1d1f;
  }
  .card {
    width: min(440px, 92vw); padding: 34px 30px 26px; text-align: center;
    background: #ffffff; border: 1px solid #e6e6ea; border-radius: 18px;
    box-shadow: 0 12px 40px rgba(0,0,0,.08);
  }
  .icon { width: 56px; height: 56px; margin: 0 auto 18px; display: grid; place-items: center; border-radius: 50%; }
  h1 { font-size: 19px; margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; }
  .muted { color: #6b6b72; margin: 0 0 6px; }
  .hint { color: #86868b; font-size: 12.5px; margin: 14px 0 0; }
  .detail {
    margin: 16px 0 0; padding: 11px 13px; border-radius: 10px; border: 1px solid #ececef;
    background: #fafafa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    text-align: left; word-break: break-word; white-space: pre-wrap;
  }
  .ok .icon { background: #e9f9ef; color: #16a34a; }
  .err .icon { background: #fdecec; color: #dc2626; }
  .err .detail { background: #fff3f3; border-color: #f6d6d6; color: #b91c1c; }
  .brand { margin-top: 24px; font-size: 12px; letter-spacing: 0.04em; color: #b0b0b5; }
  @media (prefers-color-scheme: dark) {
    body { background: #161617; color: #f5f5f7; }
    .card { background: #232326; border-color: #313136; box-shadow: 0 16px 48px rgba(0,0,0,.45); }
    .muted { color: #a1a1a6; } .hint { color: #86868b; } .brand { color: #6e6e74; }
    .detail { background: #1d1d1f; border-color: #2e2e34; color: #e6e6e9; }
    .ok .icon { background: #123019; color: #34d36b; }
    .err .icon { background: #3a1416; color: #ff6b6e; }
    .err .detail { background: #2a1416; border-color: #4a1d20; color: #ffb3b6; }
  }`

const CHECK_SVG =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
const CROSS_SVG =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function shell(stateClass: 'ok' | 'err', inner: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SwarmAgents</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="card ${stateClass}">
${inner}
    <div class="brand">SwarmAgents</div>
  </div>
</body>
</html>`
}

export function oauthSuccessHtml(account: string | null): string {
  return shell(
    'ok',
    `    <div class="icon">${CHECK_SVG}</div>
    <h1>已连接</h1>
    <p class="muted">${account ? escapeHtml(account) : '你的 Google 账号'}已成功链接到 SwarmAgents。</p>
    <p class="hint">可以关闭这个标签页了。</p>`
  )
}

export function oauthErrorHtml(message: string): string {
  return shell(
    'err',
    `    <div class="icon">${CROSS_SVG}</div>
    <h1>连接失败</h1>
    <p class="muted">授权流程出错，请回到 SwarmAgents 重试。</p>
    <div class="detail">${escapeHtml(message)}</div>`
  )
}
