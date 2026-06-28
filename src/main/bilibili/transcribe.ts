// Local speech-to-text via sherpa-onnx (SenseVoice offline model). The native
// module and the multi-hundred-MB model load once per modelDir and are cached —
// rebuilding per request would be prohibitively slow. The recognizer factory is
// injectable so unit tests never touch real native binaries or model files.
import { join } from 'node:path'
import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-transcribe' })

export type Recognizer = { transcribe(wavPath: string): string }
export type RecognizerFactory = (modelDir: string) => Recognizer

// Builds a SenseVoice recognizer from files inside modelDir. Expects the standard
// sherpa-onnx SenseVoice release layout: model.int8.onnx + tokens.txt.
export const defaultRecognizerFactory: RecognizerFactory = (modelDir) => {
  // Lazy require: main-process only (CJS bundle), and keeps the native addon out
  // of test loads since the unit tests inject a fake factory instead.
  // biome-ignore lint/suspicious/noExplicitAny: third-party native module has no types
  const sherpa = require('sherpa-onnx-node') as any
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(modelDir, 'model.int8.onnx'),
        language: 'auto',
        useInverseTextNormalization: true,
      },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: false,
    },
  })
  return {
    transcribe(wavPath: string): string {
      const wave = sherpa.readWave(wavPath)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
      recognizer.decode(stream)
      return recognizer.getResult(stream).text as string
    },
  }
}

const cache = new Map<string, Recognizer>()

export function __clearRecognizerCache(): void {
  cache.clear()
}

export async function transcribeWav(
  args: { wavPath: string; modelDir: string },
  factory: RecognizerFactory = defaultRecognizerFactory
): Promise<string> {
  log.info({ msg: 'transcribe started', wavPath: args.wavPath })
  let rec = cache.get(args.modelDir)
  if (!rec) {
    rec = factory(args.modelDir)
    cache.set(args.modelDir, rec)
    log.info({ msg: 'recognizer built', modelDir: args.modelDir })
  }
  const text = rec.transcribe(args.wavPath)
  log.info({ msg: 'transcribe ok', chars: text.length })
  return text
}
