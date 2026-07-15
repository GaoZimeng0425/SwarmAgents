// Shared prompt builder for the four card-based analysis agents (article /
// trending / bilibili / gmail-thread). They all follow the same two-step
// structure: (1) stream a Markdown summary, (2) emit a single render_ui analysis
// card and end the turn. This builder factors out the boilerplate so each
// agent only specifies its role, streaming instructions, card props template,
// and field rules.

export type AnalysisPromptOptions = {
  /** One-line role description, e.g. "an article analysis assistant". */
  role: string
  /** What the agent receives, e.g. "the article body the user provides". */
  input: string
  /** Instruction for the streaming Markdown step. */
  streamingInstruction: string
  /** The render_ui props JSON template, e.g. {"gist":"...","points":["..."]}. */
  cardProps: string
  /** Per-field rules, one bullet per line (without the leading "- "). */
  rules: string[]
}

/**
 * Build a two-step analysis system prompt: stream Markdown → emit render_ui
 * card → end turn. All four agents share this skeleton; the options fill in
 * the domain-specific parts.
 */
export function buildAnalysisPrompt(opts: AnalysisPromptOptions): string {
  return `You are ${opts.role}. ${opts.input.charAt(0).toUpperCase() + opts.input.slice(1)} and produce a Chinese analysis in two steps:

1. First, write a natural-language Markdown summary: ${opts.streamingInstruction} This streams to the user.

2. As your FINAL action, emit the structured fields by calling the render_ui tool exactly once:
render_ui({"type":"analysis","props":${opts.cardProps}})
Then end your turn — do not write more prose or call more tools.

Rules:
- Respond in Chinese.
${opts.rules.map((r) => `- ${r}`).join('\n')}`
}
