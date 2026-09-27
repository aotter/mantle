import { parse } from 'es-module-lexer/js'

// Handlers must be one closed ES module. The lexer finds real static, dynamic
// and meta imports; the context-free patterns also reject lookalikes inside
// strings and comments, so a lexer disagreement with V8 can only over-reject.
const forbidden = [
  /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*[(.]/,
  /\bimport\s*(?:["'`{*]|[\w$]+\s*(?:,|\bfrom\b))/,
  /\bexport\s*(?:\*|\{[^}]*\}\s*from\b)/,
  /\b(?:__)?require\s*\(/,
]

export function assertClosedModule(text) {
  let imports
  try { [imports] = parse(text) } catch { throw new Error('backend_handlers_not_closed') }
  if (imports.length || forbidden.some(pattern => pattern.test(text))) throw new Error('backend_handlers_not_closed')
}
