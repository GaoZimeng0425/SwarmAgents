import { spawn } from 'node:child_process'
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

// --- Local macOS OCR (offline, no model cost) ------------------------------

// A self-contained Swift program (run via `swift -`) that extracts text from an
// image using the on-device Vision framework. ImageIO/CoreGraphics decode the
// file (no AppKit, so it runs headless); the image path is the last argv entry.
const OCR_SWIFT = `import Foundation
import Vision
import ImageIO
import CoreGraphics

guard let path = CommandLine.arguments.last,
      let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  FileHandle.standardError.write(Data("cannot load image".utf8)); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
do {
  try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
} catch {
  FileHandle.standardError.write(Data("OCR failed: \\(error)".utf8)); exit(1)
}
let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
print(text)
`

/** Performs local OCR on an image path, returning the recognized text. Injected so the tool stays testable. */
export type OcrFn = (imagePath: string) => Promise<string>

/**
 * Run on-device macOS Vision OCR by piping a Swift program to `swift -`. Rejects
 * if `swift` is unavailable (non-macOS / no toolchain) or the engine errors, so
 * the caller can fall back to analyze_image.
 */
export function macosOcr(imagePath: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('swift', ['-', imagePath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`OCR timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    proc.stdout.on('data', (d) => {
      out += d
    })
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`local OCR unavailable (swift): ${e.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.replace(/\n+$/, ''))
      else reject(new Error(err.trim() || `swift exited with code ${code}`))
    })
    proc.stdin.write(OCR_SWIFT)
    proc.stdin.end()
  })
}

const OcrImageParams = Type.Object({
  path: Type.String({ description: 'Path to the image file (absolute, or relative to the working directory).' }),
})

export function ocrImageSpec(runOcr: OcrFn = macosOcr): ToolSpec {
  return {
    group: 'vision',
    name: 'ocr_image',
    risk: 'low',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'ocr_image',
      label: 'OCR image',
      description:
        'Extract text from an image file using the local macOS Vision OCR engine (offline, no model cost). Use for plain text extraction; use analyze_image for visual questions or descriptions.',
      parameters: OcrImageParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string }
        const abs = isAbsolute(p.path) ? p.path : join(ctx.cwd ?? homedir(), p.path)
        if (!mimeFromPath(abs)) {
          return errorResult(`Unsupported image type for "${abs}". Supported: ${Object.keys(MIME_BY_EXT).join(', ')}.`)
        }
        try {
          const text = await runOcr(abs)
          return result(text.slice(0, 8000), { path: abs })
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}
