import { expect, it } from 'vitest'
import { fileIconTone, fileIconComponents } from './fileIcons'

it('shares desktop file categories and accepts missing Host extensions', () => {
  expect(fileIconTone('README.md', null)).toBe('document')
  expect(fileIconTone('AGENTS.md', '.MD')).toBe('document')
  expect(fileIconTone('config.yml')).toBe('data')
  expect(fileIconTone('App.vue')).toBe('code')
  expect(fileIconTone('photo.png')).toBe('image')
  expect(fileIconTone('plugin.jar')).toBe('file')
  expect(fileIconTone('LICENSE', null)).toBe('file')
  expect(new Set(Object.values(fileIconComponents)).size).toBe(5)
})
