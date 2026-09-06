// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'

import { sanitizeEmailHtml } from './email-html'

describe('sanitizeEmailHtml', () => {
  it('strips <script> elements but keeps surrounding markup', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>hi</p>')
  })

  it('strips external stylesheet links the app CSP would block', () => {
    const out = sanitizeEmailHtml(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Source+Sans+Pro"><p>x</p>'
    )
    expect(out.toLowerCase()).not.toContain('fonts.googleapis.com')
    expect(out).toContain('<p>x</p>')
  })

  it('keeps inline <style> and data: stylesheets (allowed by CSP)', () => {
    const out = sanitizeEmailHtml(
      '<style>.a{color:red}</style><link rel="stylesheet" href="data:text/css,.b{color:blue}"><p>y</p>'
    )
    expect(out).toContain('.a{color:red}')
    expect(out.toLowerCase()).toContain('data:text/css')
  })

  it('strips inline event-handler attributes', () => {
    const out = sanitizeEmailHtml('<img src="x.png" onload="alert(1)" onerror="evil()">')
    expect(out.toLowerCase()).not.toContain('onload=')
    expect(out.toLowerCase()).not.toContain('onerror=')
    expect(out).toContain('x.png')
  })

  it('strips javascript: URLs', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>')
    expect(out.toLowerCase()).not.toContain('javascript:')
    expect(out).toContain('>click</a>')
  })

  it('preserves the doctype when present and omits it otherwise', () => {
    expect(sanitizeEmailHtml('<!doctype html><p>a</p>').toLowerCase()).toContain('<!doctype html>')
    expect(sanitizeEmailHtml('<p>a</p>').toLowerCase()).not.toContain('<!doctype')
  })
})
