/**
 * Robust JSON parser that tolerates trailing commas, smart quotes, and
 * truncated input — useful when LLMs emit malformed tool-call arguments.
 */
export function parseJsonLoose(input: string): any {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }

  // Try fixing common issues
  let fixed = trimmed
    // smart quotes → straight quotes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // remove trailing commas
    .replace(/,(\s*[}\]])/g, '$1')

  try {
    return JSON.parse(fixed)
  } catch {
    // continue
  }

  // Try truncating at the last valid position
  let depth = 0
  let inString = false
  let escape = false
  let lastValidEnd = -1
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\' && inString) {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{' || c === '[') depth++
    if (c === '}' || c === ']') {
      depth--
      if (depth === 0) lastValidEnd = i
    }
  }
  if (lastValidEnd >= 0) {
    try {
      return JSON.parse(fixed.slice(0, lastValidEnd + 1))
    } catch {
      // give up
    }
  }

  return undefined
}

/**
 * Alias for parseJsonLoose, kept for compatibility with the qwenproxy-derived
 * tools/parser.ts module.
 */
export const robustParseJSON = parseJsonLoose
