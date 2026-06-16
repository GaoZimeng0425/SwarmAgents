import { describe, expect, it } from 'vitest'

import { modelSupportsImagesFromInput } from './capabilities'

describe('modelSupportsImagesFromInput', () => {
  it('true when the model input includes image', () => {
    expect(modelSupportsImagesFromInput(['text', 'image'])).toBe(true)
  })
  it('false when image is absent', () => {
    expect(modelSupportsImagesFromInput(['text'])).toBe(false)
  })
  it('true (permissive) when input is unknown', () => {
    expect(modelSupportsImagesFromInput(undefined)).toBe(true)
  })
})
