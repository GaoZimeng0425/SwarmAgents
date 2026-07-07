import { extractArticleFromDocument } from '../lib/extract'

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if ((msg as { type?: string })?.type !== 'extract') return false
      try {
        const result = extractArticleFromDocument(document, location)
        sendResponse(result)
      } catch {
        sendResponse(null)
      }
      return false
    })
  },
})
