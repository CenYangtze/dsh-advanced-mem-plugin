import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type EvidenceRole = 'action' | 'check' | 'readback' | 'unknown'
export type EvidenceExecution = 'completed' | 'failed' | 'incomplete'

/** Contains classifications only; command strings and argument objects never leave this function. */
export interface CallClassification {
  readonly role: EvidenceRole
  readonly shell: boolean
  readonly namedVerifier: boolean
  readonly reportsExitCode?: boolean
  /** Transient output template only; never copied into an episode. */
  readonly exitReports?: readonly { prefix: string; suffix: string }[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Mask literal strings before looking for executable assertions or mutations. */
function executableText(source: string): string {
  return source.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|`.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/\/\*[\s\S]*?\*\/|<#[\s\S]*?#>|(?:#|\/\/)[^\r\n]*/g, ' ')
}

type ExitPart = string | null

/** A small exit-status language: aliases, literal status output, and exit. No general shell evaluation. */
function exitStatusTail(source: string, metadataLimit?: number): readonly { prefix: string; suffix: string }[] | undefined {
  const pattern = /[ \t]+|[;\r\n]+|"(?:`.|[^"`])*"|'(?:''|[^'])*'|\$[A-Za-z_]\w*|\$\?|[=+()]|[A-Za-z][A-Za-z-]*/gy
  const tokens: string[] = []
  while (pattern.lastIndex < source.length) {
    const token = pattern.exec(source)
    if (!token) return undefined
    if (!/^[ \t]+$/.test(token[0])) tokens.push(/^[;\r\n]+$/.test(token[0]) ? ';' : token[0])
  }
  const aliases = new Set(['$lastexitcode', '$?'])
  const reports: { prefix: string; suffix: string }[] = []
  let cursor = 0, exited = false
  const atom = (): ExitPart[] | undefined => {
    const token = tokens[cursor++]
    if (token === '(') {
      const value = expression()
      if (tokens[cursor++] !== ')') return undefined
      return value
    }
    if (token?.startsWith('$')) return aliases.has(token.toLowerCase()) ? [null] : undefined
    if (token?.startsWith("'")) return [token.slice(1, -1).replaceAll("''", "'")]
    if (!token?.startsWith('"') || token.includes('`')) return undefined
    const body = token.slice(1, -1), parts: ExitPart[] = []
    let start = 0
    for (const match of body.matchAll(/\$[A-Za-z_]\w*|\$\?/g)) {
      const literal = body.slice(start, match.index)
      if (literal.includes('$') || literal.endsWith('\\') || !aliases.has(match[0].toLowerCase())) return undefined
      parts.push(literal, null); start = match.index + match[0].length
    }
    const suffix = body.slice(start)
    if (suffix.includes('$')) return undefined
    parts.push(suffix)
    return parts
  }
  const expression = (): ExitPart[] | undefined => {
    const value = atom()
    if (!value) return undefined
    while (tokens[cursor] === '+') {
      cursor++
      const next = atom()
      if (!next) return undefined
      value.push(...next)
    }
    return value
  }
  const onlyStatus = (parts: readonly ExitPart[]): boolean => parts.filter(part => part === null).length === 1 && parts.every(part => part === null || part.length === 0)
  while (cursor < tokens.length) {
    if (tokens[cursor] === ';') { cursor++; continue }
    if (exited) return undefined
    const first = tokens[cursor++]!
    if (first.startsWith('$')) {
      if (tokens[cursor++] !== '=') return undefined
      const value = expression()
      if (!value || !onlyStatus(value)) return undefined
      aliases.add(first.toLowerCase())
    } else if (first.toLowerCase() === 'exit') {
      const value = expression()
      if (!value || !onlyStatus(value)) return undefined
      exited = true
    } else if (/^(?:Write-Host|Write-Output|echo)$/i.test(first)) {
      const value = expression()
      if (!value || value.filter(part => part === null).length !== 1) return undefined
      const marker = value.indexOf(null)
      const prefix = value.slice(0, marker).join(''), suffix = value.slice(marker + 1).join('')
      if (/[\r\n]/.test(prefix + suffix) || metadataLimit !== undefined && prefix.length + suffix.length > metadataLimit) return undefined
      reports.push({ prefix, suffix })
    } else return undefined
    if (cursor < tokens.length && tokens[cursor] !== ';') return undefined
  }
  return reports
}

function invokedVerifier(command: string, metadataLimit?: number): false | { exitReports: readonly { prefix: string; suffix: string }[] } {
  const tokens = command.trim().match(/"[^"]*"|'[^']*'|&&|\|\||[;&|\r\n]|[^\s;&|]+/g) ?? []
  if (tokens[0] === '&') tokens.shift()
  let exitReports: readonly { prefix: string; suffix: string }[] = []
  const separator = tokens.findIndex(token => /^(?:&&|\|\||[;&|\r\n])$/.test(token))
  if (separator >= 0) {
    const reports = exitStatusTail(tokens.slice(separator).join(' '), metadataLimit)
    if (!reports) return false
    exitReports = reports
    tokens.splice(separator)
  }
  const words = tokens.map(token => token.replace(/^['"]|['"]$/g, ''))
  const program = words[0]?.split(/[\\/]/).at(-1) ?? ''
  const interpreter = /^(?:pwsh|powershell|python[\d.]*|node|bash|sh)(?:\.exe)?$/i.test(program)
  const fileFlag = /^(?:pwsh|powershell)(?:\.exe)?$/i.test(program) ? words.findIndex(token => /^-File$/i.test(token)) : -1
  const script = interpreter ? fileFlag >= 0 ? words[fileFlag + 1] : words.slice(1).find(token => !token.startsWith('-')) : words[0]
  return /^(?:verify|check|test)(?:[-_.][\w.-]+)?\.(?:ps1|py|[cm]?js|sh|bash)$/i.test(script?.split(/[\\/]/).at(-1) ?? '') ? { exitReports } : false
}

/** Inspect arguments transiently. In particular, a printed pass claim is not a check. */
export function classifyCall(tool: string, raw: unknown, metadataLimit?: number): CallClassification {
  const shell = tool === 'bash' || tool === 'pwsh'
  if (!shell) return { role: /^(?:write|edit|apply_patch|delete|remove|move|rename|mkdir)$/.test(tool) ? 'action' : 'unknown', shell: false, namedVerifier: false }
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) as unknown } catch { return { role: 'unknown', shell, namedVerifier: false } }
  }
  const command = object(args)?.command
  if (typeof command !== 'string') return { role: 'unknown', shell, namedVerifier: false }
  // A language interpreter may receive its program as one quoted argument.
  const inline = /^\s*(?:&\s*)?(?:node|python[\d.]*|pwsh|powershell|bash|sh)(?:\.exe)?\s+(?:-e|-c|-Command)\s+(["'])([\s\S]*)\1\s*$/i.exec(command)
  const executable = executableText(inline?.[2] ?? command)
  const changesState = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Invoke-Expression|Start-Process|mkdir|touch|rm|mv|cp|tee)\b|\b(?:write(?:Sync)?|writeFile(?:Sync)?|appendFile(?:Sync)?|copyFile(?:Sync)?|write_text|write_bytes|unlink(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|exec(?:Sync|File|FileSync)?|spawn(?:Sync)?)\s*\(|\b(?:subprocess\.|os\.system|git\s+(?:apply|reset|checkout|commit)|npm\s+install|pnpm\s+install)\b|(?:^|\s)\d*>>?(?:\s|$)/i.test(executable)
  if (changesState) return { role: 'action', shell, namedVerifier: false }
  if (/^\s*(?:echo|printf|Write-Output|Write-Host)\b/i.test(executable) && !/[;&|\n]/.test(executable)) return { role: 'unknown', shell, namedVerifier: false }
  const standardCheck = /(?:^|&&|\|\||;|\n)\s*(?:python[\d.]*\s+-m\s+(?:pytest|unittest)\b|(?:npx|pnpm|npm|yarn|bun)\s+(?:exec\s+|run\s+)?(?:test(?::[\w-]+)?|vitest|jest|mocha|ava|check|verify)\b|(?:pytest|vitest|jest|mocha|ctest)\b|(?:cargo|go|dotnet|mvn)\s+test\b)/i.test(executable)
  const assertions = executable.replace(/(?:^|[;&|\n])\s*(?:echo|printf|Write-Output|Write-Host)\b[^;&|\n]*/gi, ' ')
  const assertion = /\bassert(?:\s*[.(]|\s+\S)|\bthrow\b|\bAssert-(?:Equal|True|False|That|NotNull)\b|\bShould\s+-(?:Be|Not|Throw|Exist)\b/.test(assertions)
  const invocation = invokedVerifier(command, metadataLimit)
  return { role: standardCheck || assertion ? 'check' : 'unknown', shell, namedVerifier: invocation !== false,
    ...invocation && invocation.exitReports.length ? { reportsExitCode: true, exitReports: invocation.exitReports } : {} }
}

function metadataTarget(meta: JsonValue | undefined): string | undefined {
  const value = object(meta)
  const target = value?.filePath ?? value?.path
  // Metadata is tool-produced; never fall back to model arguments or command text.
  return typeof target === 'string' && target.length > 0 && !/[\r\n\0]/.test(target) ? target : undefined
}

export function resultEvidence(tool: string, call: CallClassification, text: string, meta: JsonValue | undefined, isError: boolean, errorCode?: string): {
  role: EvidenceRole; execution: EvidenceExecution; complete: boolean; target?: string
} {
  const target = metadataTarget(meta)
  const value = object(meta)
  const readback = tool === 'read' && target !== undefined && Array.isArray(value?.lines) && typeof value?.totalLines === 'number'
  // Named verification scripts must produce actual measured check rows, not a lone success banner.
  const lines = text.split(/\r?\n/)
  const header = lines.findIndex(line => /^\s*Check\s+Expected\s+Measured\s+Pass\s*$/i.test(line))
  const measuredChecks = header >= 0 && lines.slice(header + 1).some(line => line.trim().split(/\s+/).length >= 4
    && /\s(?:True|False|true|false|PASS|FAIL)\s*$/.test(line))
  const role = readback ? 'readback' : call.namedVerifier && measuredChecks ? 'check' : call.role
  const shell = call.shell
  const truncated = shell && /\[(?:output truncated[;\]]|some output was dropped|output was truncated)|<response clipped>/i.test(text)
  const persistentUnsettled = tool === 'bash' && typeof value?.cwd !== 'string' && !isError
    && !/\[(?:Command finished with exit code |shell exited: code |shell killed by signal:)/i.test(text)
  // Only templates proven to interpolate a preserved shell status are admitted.
  // Literal templates stay in transient call state, never episode metadata.
  const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const reportedExits = (call.exitReports ?? []).map(report => {
    const matcher = new RegExp(`^${escape(report.prefix)}(-?\\d+)${escape(report.suffix)}$`)
    const line = lines.findLast(item => matcher.test(item))
    return line === undefined ? undefined : Number(matcher.exec(line)![1])
  })
  const incomplete = errorCode === 'ABORTED' || errorCode === 'ABORTED_BEFORE_DISPATCH' || persistentUnsettled || reportedExits.some(value => value === undefined)
    || shell && /\[(?:timed out after |stopped:|still running after |Command still running|Command timed out or OOM|status: (?:running|stopping))|^started background job\b|\[(?:sandbox:)[^\]]*(?:denied|did not run|runner itself failed)/im.test(text)
  const exit = shell ? /\[exit code:\s*(-?\d+|null)\]\s*$|\[Command finished with exit code\s+(-?\d+)\]\s*$|\[shell exited: code\s+(-?\d+)\]/i.exec(text) : null
  const exitCode = exit ? Number(exit[1] ?? exit[2] ?? exit[3]) : 0
  const failed = isError || shell && (/\[(?:killed by signal:|shell killed by signal:)/i.test(text) || exit !== null && exitCode !== 0 || reportedExits.some(value => value !== undefined && value !== 0))
  return { role, execution: incomplete ? 'incomplete' : failed ? 'failed' : 'completed', complete: !truncated,
    ...target === undefined ? {} : { target } }
}
