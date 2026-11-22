export const gradePoint = score => {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('score must be 0..100')
  if (score >= 90) return 4
  if (score >= 80) return 3
  if (score >= 70) return 2
  if (score >= 60) return 1
  return 0
}
export const gpa = scores => {
  if (!Array.isArray(scores) || scores.length === 0) throw new Error('scores required')
  return scores.reduce((sum, score) => sum + gradePoint(score), 0) / scores.length
}
