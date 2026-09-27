// One line per state transition: JSON with --json, short text otherwise.
// Every line passes a redaction guard that knows each grant value read in this run.
import { CloudRuleError } from '../static-artifact.mjs'

export { CloudRuleError }
export const fail = (code, detail, status = 400) => new CloudRuleError(status, code, detail)

/** Quotes one shell word so printed commands can be copied verbatim. */
export const shellWord = word => /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`

// Bearer values, query tokens and JWT-looking runs never reach output.
export const redact = text => String(text).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
  .replace(/([?&](?:token|sig|signature)=)[^&\s"']+/gi, '$1[redacted]')
  .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')

export function createOutput({ json = false, write = text => process.stdout.write(text) } = {}) {
  const secrets = new Set()
  const scrub = text => redact([...secrets].reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text))
  const human = line => {
    const head = [line.stage, line.ok === false ? `failed: ${line.error}` : line.state, line.versionId ? `version ${line.versionId}` : null,
      line.commit ? `commit ${line.commit}` : null].filter(Boolean).join(' · ')
    const rows = [head]
    if (line.detail) rows.push(`  ${line.detail}`)
    for (const note of line.notes ?? []) rows.push(`  ${note}`)
    const next = line.nextAction
    if (next) {
      for (const look of next.confirm ?? []) rows.push(`  confirm with the user: ${look.field} from ${look.tool} ${JSON.stringify(look.arguments)}`)
      if (next.tool) rows.push(`  next: call ${next.tool} ${JSON.stringify(next.arguments ?? {})}`)
      for (const need of next.requires ?? []) rows.push(`    ${need.argument} = ${need.field} from ${need.tool} ${JSON.stringify(need.arguments)}`)
      if (next.command) rows.push(`  ${next.tool ? 'then' : 'next'}: ${next.command}`)
      if (next.reason) rows.push(`  ${next.reason}`)
    }
    return rows.join('\n')
  }
  return {
    /** Registers a credential so no later line can print it. */
    remember(value) { if (typeof value === 'string' && value.length >= 8) secrets.add(value) },
    emit(line) {
      const text = json ? JSON.stringify(line) : human(line)
      const safe = scrub(text)
      write((json && safe !== text ? JSON.stringify({ ok: false, stage: line.stage, error: 'output_redacted', nextAction: null }) : safe) + '\n')
    },
  }
}

/** A failure line; `detail` is bounded and scrubbed by emit. */
export function failureLine(stage, error, nextAction) {
  const code = error instanceof CloudRuleError ? error.code : 'local_error'
  const detail = error instanceof CloudRuleError ? error.detail : error instanceof Error ? error.message : String(error)
  return { ok: false, stage, error: code, ...(detail ? { detail: String(detail).slice(0, 2000) } : {}), nextAction }
}
