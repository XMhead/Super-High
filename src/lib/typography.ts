export type TypographyProfileId = 'normalized' | 'legacy'

export interface TypographyWeights {
  regular: number
  compactRegular: number
  content: number
  mono: number
  emphasis: number
  strong: number
  heading: number
  light: number
}

/** Change this value to 'legacy' to restore the pre-normalization weights. */
export const ACTIVE_TYPOGRAPHY_PROFILE: TypographyProfileId = 'normalized'

export const TYPOGRAPHY_PROFILES: Record<TypographyProfileId, TypographyWeights> = {
  normalized: {
    regular: 500,
    compactRegular: 500,
    content: 500,
    mono: 500,
    emphasis: 600,
    strong: 700,
    heading: 700,
    light: 500,
  },
  legacy: {
    regular: 500,
    compactRegular: 400,
    content: 450,
    mono: 450,
    emphasis: 600,
    strong: 650,
    heading: 700,
    light: 300,
  },
}

export function getTypographyWeights(profileId: TypographyProfileId = ACTIVE_TYPOGRAPHY_PROFILE): TypographyWeights {
  return TYPOGRAPHY_PROFILES[profileId]
}

export function typographyCssVariables(profileId: TypographyProfileId = ACTIVE_TYPOGRAPHY_PROFILE): Record<string, string> {
  const weights = getTypographyWeights(profileId)
  return {
    '--sh-weight-regular': String(weights.regular),
    '--sh-weight-compact-regular': String(weights.compactRegular),
    '--sh-weight-content': String(weights.content),
    '--sh-weight-mono': String(weights.mono),
    '--sh-weight-emphasis': String(weights.emphasis),
    '--sh-weight-strong': String(weights.strong),
    '--sh-weight-heading': String(weights.heading),
    '--sh-weight-light': String(weights.light),
  }
}
