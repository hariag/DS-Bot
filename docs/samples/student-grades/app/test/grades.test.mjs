import test from 'node:test'
import assert from 'node:assert/strict'
import { gpa, gradePoint } from '../src/grades.mjs'
test('grade points and GPA', () => {
  assert.equal(gradePoint(95), 4)
  assert.equal(gradePoint(85), 3)
  assert.equal(gradePoint(59), 0)
  assert.equal(gpa([90, 80, 70, 60]), 2.5)
  assert.throws(() => gradePoint(101))
})
