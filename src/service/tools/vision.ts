import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ProviderInjection } from '@shared/types/provider'

import type { ToolRunContext, ToolSpec } from './registry'

/** Extension → media type for the image formats the vision models accept. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function mimeFromPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext]
}

/**
 * Pick the model to run a vision call on: the first image-capable injection in
 * the chain (`[provider, ...fallbacks]`). Lets a cheap text-only main model
 * delegate image work to an image-capable provider configured as its fallback.
 */
export function pickVisionInjection(
  chain: readonly ProviderInjection[],
  supportsImages: (p: ProviderInjection) => boolean
): ProviderInjection | undefined {
  return chain.find(supportsImages)
}

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const result = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const errorResult = (message: string): Result => result(`error: ${message}`, { error: message })

const DEFAULT_PROMPT = 'Extract all text from this image (OCR). Return only the extracted text, preserving line breaks.'

const AnalyzeImageParams = Type.Object({
  path: Type.String({ description: 'Path to the image file (absolute, or relative to the working directory).' }),
  prompt: Type.Optional(
    Type.String({
      description: `What to extract or answer about the image. Defaults to OCR: "${DEFAULT_PROMPT}"`,
    })
  ),
})

export function analyzeImageSpec(): ToolSpec {
  return {
    group: 'vision',
    name: 'analyze_image',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'analyze_image',
      label: 'Analyze image',
      description:
        'Read an image file and extract its text (OCR) or answer a question about it, using a vision-capable model. Use when you need the contents of an image and your own model cannot see images.',
      parameters: AnalyzeImageParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string; prompt?: string }
        if (!ctx.analyzeImage) {
          return errorResult(
            'No image-capable model is configured. Add a provider (or fallback) whose model accepts images.'
          )
        }
        const abs = isAbsolute(p.path) ? p.path : join(ctx.cwd ?? homedir(), p.path)
        const mimeType = mimeFromPath(abs)
        if (!mimeType) {
          return errorResult(`Unsupported image type for "${abs}". Supported: ${Object.keys(MIME_BY_EXT).join(', ')}.`)
        }
        let bytes: Buffer
        try {
          bytes = await readFile(abs)
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e))
        }
        const prompt = p.prompt?.trim() || DEFAULT_PROMPT
        try {
          const text = await ctx.analyzeImage(prompt, { data: bytes.toString('base64'), mimeType })
          return result(text.slice(0, 8000), { path: abs })
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}
