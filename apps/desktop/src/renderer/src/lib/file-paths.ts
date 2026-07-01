// Detects local file paths embedded in model prose so the UI can turn them into
// clickable "open" links and preview images. Matches absolute (/…) and home
// (~/…) paths ending in an extension; the negative lookbehind for ':', a word
// char, or '/' keeps it from matching slashes inside URLs (https://…/x.png).
export const FILE_PATH_RE = /(?<![:\w/])(?:~\/|\/)[^\s)'"\]}（），、,;]+\.[A-Za-z0-9]{1,6}/g

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export function basename(path: string): string {
  return path.split('/').pop() || path
}

export function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return !!ext && IMAGE_EXTS.has(ext)
}

/** Unique image file paths mentioned in the given text, in first-seen order. */
export function extractImagePaths(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(FILE_PATH_RE)) {
    const p = m[0]
    if (isImagePath(p)) seen.add(p)
  }
  return [...seen]
}
