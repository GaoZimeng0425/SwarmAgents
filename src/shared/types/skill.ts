// A Skill is a `.swarm/skills/<name>/SKILL.md` file: YAML-ish frontmatter
// (name + description) plus a markdown body of instructions. The agent sees the
// name+description list in its prompt and loads the body on demand via use_skill
// (progressive disclosure).
import { z } from 'zod'

// Name/description rules mirror pi-agent-core's skill loader (harness/skills):
// lowercase a-z 0-9 with single hyphens, ≤64 chars; description ≤1024 chars.
// Skills written here therefore load cleanly under pi's conventions.
export const SkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Lowercase a-z, 0-9 and single hyphens only; no leading, trailing or doubled hyphens.'
    ),
  description: z.string().min(1).max(1024),
  body: z.string(),
  // Hidden from the model-visible skill list but still loadable by name.
  disableModelInvocation: z.boolean().optional(),
  // Absolute path to SKILL.md, populated on load (not part of the write input).
  filePath: z.string().optional(),
  // Relative POSIX paths of all files in the skill folder (incl. SKILL.md),
  // populated on load only. Lets the UI show what a folder-imported skill bundles.
  files: z.array(z.string()).optional(),
})
export type Skill = z.infer<typeof SkillSchema>

export type SkillMutationResult = { ok: true; skills: Skill[] } | { ok: false; code: string; message: string }
