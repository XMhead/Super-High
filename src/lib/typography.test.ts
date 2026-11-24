import { describe, expect, it } from 'vitest'

import { getTypographyWeights, typographyCssVariables } from './typography'

describe('typography profiles', () => {
  it('keeps normalized regular text at 500 without lowering existing emphasis', () => {
    expect(getTypographyWeights('normalized')).toMatchObject({
      regular: 500,
      compactRegular: 500,
      content: 500,
      mono: 500,
      emphasis: 600,
      strong: 700,
      heading: 700,
      light: 500,
    })
  })

  it('keeps the previous values available as a one-setting rollback', () => {
    expect(typographyCssVariables('legacy')).toMatchObject({
      '--sh-weight-compact-regular': '400',
      '--sh-weight-content': '450',
      '--sh-weight-mono': '450',
      '--sh-weight-strong': '650',
      '--sh-weight-light': '300',
    })
  })
})
