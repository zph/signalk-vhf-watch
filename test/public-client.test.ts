import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('dedicated web client exposes live listening and replay without transmit controls', () => {
  const root = path.resolve(__dirname, '../..')
  const html = readFileSync(path.join(root, 'public/index.html'), 'utf8')
  const script = readFileSync(path.join(root, 'public/main.js'), 'utf8')
  assert.match(html, /Listen live/)
  assert.match(html, /Recent radio/)
  assert.match(html, /United States \+ Canada/)
  assert.match(html, /No transmit controls exist/)
  assert.match(script, /live\.wav/)
  assert.match(script, /replay/)
  assert.doesNotMatch(script, /push.?to.?talk|\bptt\b|transmit/i)
})
