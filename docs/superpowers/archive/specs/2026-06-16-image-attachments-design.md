# Image Attachments (Phase 2) — Design

**Date:** 2026-06-16
**Status:** Approved, pending implementation
**Scope:** Phase 2 of the ai-elements chat work. Phase 1 (chat shell) is complete; the composer's attach button is currently a disabled no-op. This phase makes it functional, end-to-end.

## Problem

Users want to attach images to a message. Phase 1 left the attach button disabled because nothing threads an attachment from the composer to the model: every layer of `submitGoal` carries only a `string`, and `agent-runner` calls `agent.prompt(task.goal)` with no images. `pi-agent-core` supports `agent.prompt(input: string, images?: ImageContent[])`, and `pi-ai` models declare image capability via `Model.input: ("text" | "image")[]` — so the pipeline *can* carry images once wired.

## Decisions (approved)

- **Images only.** `pi`'s `agent.prompt` accepts only `ImageContent` (image bytes). The picker is restricted to `image/*`; non-images are rejected. No text-file extraction.
- **Strict vision gating.** Surface each model's image capability to the renderer; disable the attach control (with a tooltip) when the active model can't accept images. Unknown/custom (un-introspectable) models default to **enabled**.
- **Persist for reload.** Store attachments on the task so thumbnails re-render after a reload/session switch; the model also retains them via the agent message snapshot.

## Data model

New shared type (add to `src/shared/types/task.ts`, exported):

```ts
export const AttachmentSchema = z.object({
  data: z.string(),       // base64-encoded image bytes (no data: prefix)
  mimeType: z.string(),   // e.g. "image/png"
  name: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
```

- `TaskSchema` gains `attachments: z.array(AttachmentSchema).default([])`.
- A data URL `data:<mime>;base64,<DATA>` from the composer splits into `{ mimeType: <mime>, data: <DATA> }`.
- Conversion to pi: `Attachment → ImageContent` = `{ type: 'image', data, mimeType }`.

## End-to-end flow

```
ChatInput (PromptInput, image/* attachments)
  → onSubmit(goal, attachments: Attachment[])
  → swarmApi.submitGoal(sessionId, goal, attachments)
  → preload swarm:submitGoal
  → main/ipc/swarm-ipc.submitGoal
  → service-client.submitGoal
  → service-ipc 'submitGoal' args [sessionId, goal, attachments]
  → dispatcher → session-manager.submitGoal(sessionId, goal, attachments)
      • Task.attachments = attachments  (persisted)
      • broadcast task.created { ..., attachments }
  → agent-runner: images = attachments.map(a => ({type:'image', data:a.data, mimeType:a.mimeType}))
      • agent.prompt(task.goal, images.length ? images : undefined)
```

### Signature changes (each layer gains an optional `attachments`)

- `src/shared/types/ui.ts` — `SwarmBridge.submitGoal(sessionId, goal, attachments?: Attachment[])`.
- `src/renderer/src/lib/api.ts` — `swarmApi.submitGoal(sessionId, goal, attachments?)`.
- `src/preload/index.ts` — forward `attachments` on `swarm:submitGoal`.
- `src/main/ipc/swarm-ipc.ts` — accept and forward `attachments` (trim/validate text as today; pass attachments through).
- `src/main/service-client.ts` — `submitGoal(sessionId, goal, attachments?)` → `call('submitGoal', [sessionId, goal, attachments])`.
- `src/service/dispatcher.ts` — `submitGoal` case reads `[sessionId, goal, attachments]`.
- `src/service/session-manager.ts` — `submitGoal(sessionId, goal, attachments = [], agentDef?)`; set `task.attachments`; include `attachments` in the `task.created` broadcast.
- `src/service/agent-runner.ts` — build `ImageContent[]` from `task.attachments`; call `agent.prompt(task.goal, images)` (pass `undefined` when empty to preserve current behavior).

Empty/omitted `attachments` must behave exactly as today (text-only path unchanged).

## Persistence (conversation-store migration)

`tasks` uses explicit columns, so:
- Add column `attachments TEXT NOT NULL DEFAULT '[]'` to the `tasks` table DDL (additive; existing rows default to `[]`, so no destructive migration needed — `CREATE TABLE IF NOT EXISTS` plus an idempotent `ALTER TABLE ... ADD COLUMN` guarded by a column-existence check).
- `saveTask` serializes `JSON.stringify(task.attachments)` into the new column.
- The row→Task mapping parses `JSON.parse(row.attachments ?? '[]')`.

The agent message snapshot already persists image content (the first user message after `agent.prompt(goal, images)` carries it), so model context survives resume independently of the task column. The task column exists for the **UI transcript** (thumbnails on reload).

## Vision gating

`pi-ai` `Model.input` includes `"image"` for vision models. Plumb a boolean to the renderer:

- Add `supportsImages: boolean` to the active-model projection in `ProvidersStateView` (computed where the providers view is assembled in `src/main/providers`). Compute via the pi-ai model registry lookup (`getModelLoose(providerOrApiStyle, modelId)?.input.includes('image')`).
- Unknown/custom models (no registry entry, arbitrary `baseUrl`) → default `true` (do not block on a model we cannot introspect).
- `ChatInput` reads `supportsImages` from `useProviders()`; when false, the attach action is disabled with tooltip "This model can't read images".

If wiring `supportsImages` into `ProvidersStateView` proves to entangle the providers projection more than expected, an acceptable equivalent is a dedicated lightweight query (`window.swarm.providers` selector) returning the active model's image capability — but the `ProvidersStateView` field is preferred for consistency with existing model metadata.

## Composer (ChatInput)

- `PromptInput` configured with `accept="image/*"`, `maxFiles={4}`, `maxFileSize={5 * 1024 * 1024}`, and an `onError` that surfaces a `toast` (max files / size / type).
- Replace the disabled paperclip with a real attach action that opens the file dialog (using `usePromptInputAttachments().openFileDialog()` via a `PromptInputButton`), disabled when `!supportsImages`.
- A small **custom attachment-preview row** above the textarea, built on `usePromptInputAttachments()` — renders each image file as a thumbnail with a remove (×) button (`files`, `remove`). This avoids re-porting the removed `attachments.tsx`.
- `handleSubmit(message)`: filter `message.files` to `image/*`, convert each (data URL → `{ data, mimeType, name }`) into `Attachment[]`, and call `onSubmit(goal, attachments)`. Submit is allowed when there is non-empty text (image-only submits are out of scope: the agent prompt needs a text `input`).

## Transcript rendering

- `Segment` (user kind) in `src/renderer/src/lib/task-segments.ts` gains `attachments: Attachment[]`. Populate it from the `task.created` event's `attachments` (carried on the `TaskRecord`).
- `ConversationThread` renders thumbnails inside the user `Message` (above the text): `<img>` with `src={`data:${a.mimeType};base64,${a.data}`}`, small fixed size, rounded.
- `replay.ts` already rebuilds `task.created` from the stored `Task`; include `attachments` so reloaded transcripts show thumbnails.

## Testing

- **Unit — `attachment` conversion:** a pure helper that converts a `FileUIPart` (its `url` data URL + `mediaType`) → `Attachment` by parsing `data:<mime>;base64,<DATA>` into `{ data, mimeType, name }`; non-image `mediaType` is filtered out; round-trips `data:image/png;base64,AAAA` correctly.
- **Unit — `supportsImages`:** known vision model → true; known text-only model → false; unknown/custom → true.
- **Unit — `taskSegments`:** a `task.created` with `attachments` yields a user segment carrying them; empty/omitted → `[]`.
- **Unit — conversation-store:** save a `Task` with `attachments` then load → attachments round-trip; a pre-migration row (no column / `'[]'`) loads as `[]`.
- **Existing suite stays green** (text-only path unchanged: omitted attachments behave as before).
- **Manual:** on a vision model, attach an image, send → thumbnail in the transcript + the model responds to the image; switch to a non-vision model → attach disabled with tooltip; reload the session → thumbnail persists.

## Out of scope

- Non-image attachments (text-file extraction, PDFs, binaries).
- Image-only messages (no text).
- Editing/cropping, drag-and-drop onto the whole window (PromptInput's `globalDrop` stays off), clipboard-paste is whatever `PromptInputTextarea` already supports.
- Output images from the model (image generation).
