import { expect, it } from 'vitest'
import { fileIconTone, fileIconComponents } from './fileIcons'

it('shares desktop file categories and accepts missing Host extensions', () => {
  expect(fileIconTone('README.md', null)).toBe('document')
  expect(fileIconTone('AGENTS.md', '.MD')).toBe('document')
  expect(fileIconTone('config.yml')).toBe('data')
  expect(fileIconTone('App.vue')).toBe('code')
  expect(fileIconTone('photo.png')).toBe('image')
  expect(fileIconTone('plugin.jar')).toBe('java')
  expect(fileIconTone('plugin.JAR', '.JAR')).toBe('java')
  expect(fileIconTone('model.bbmodel')).toBe('model')
  expect(fileIconTone('model.BBMODEL', '.BBMODEL')).toBe('model')
  expect(fileIconTone('LICENSE', null)).toBe('file')
  expect(new Set(Object.values(fileIconComponents)).size).toBe(7)
})
