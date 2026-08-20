const SENSITIVE_NAMES = new Set([
  "api_key",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "key",
  "password",
  "pat",
  "passwd",
  "secret",
  "sig",
  "signature",
  "token",
])

export function redactCommand(value: string, marker: "[redacted]" | "<redacted>") {
  return redactCommandDepth(value, marker, 0)
}

function redactCommandDepth(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  let command = redactStructuredPairs(value, marker, depth)
  command = redactHeaderWords(command, marker, depth)
  command = redactQuotedFollowingShellWord(
    command,
    /(^|[\s;|&({])(["'])([A-Za-z_][A-Za-z0-9_.-]*)(\s*\+?=\s*)/gu,
    1,
    2,
    3,
    marker,
    depth,
  )
  command = redactQuotedFollowingShellWord(
    command,
    /((?:^|\s)--?([A-Za-z][A-Za-z0-9_-]*))(["'])(=)/gu,
    1,
    3,
    2,
    marker,
    depth,
  )
  command = redactQuotedFollowingShellWord(
    command,
    /(^|\s)(["'])(--?)([A-Za-z][A-Za-z0-9_-]*)(=|\s+)/gu,
    1,
    2,
    4,
    marker,
    depth,
  )
  command = redactQuotedFollowingShellWord(
    command,
    /(^|\s)(["'])(?:-u|--user)(?:=|\s+)/giu,
    1,
    2,
    undefined,
    marker,
    depth,
  )
  command = redactFollowingShellWord(
    command,
    /\$env:([A-Za-z_][A-Za-z0-9_.-]*)(\s*\+?=\s*)/giu,
    1,
    marker,
    depth,
  )
  command = redactFollowingShellWord(
    command,
    /(^|[\s;|&({])(["'])([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*\+?=\s*)/gu,
    3,
    marker,
    depth,
  )
  command = redactFollowingShellWord(
    command,
    /(^|[\s;|&({])([A-Za-z_][A-Za-z0-9_.-]*)(\s*\+?=\s*)/gu,
    2,
    marker,
    depth,
  )
  command = redactFollowingShellWord(
    command,
    /(^|\s)(--?)([A-Za-z][A-Za-z0-9_-]*)(=|\s+)/gu,
    3,
    marker,
    depth,
  )
  command = redactFollowingShellWord(command, /(\s(?:-u|--user)(?:=|\s+))/giu, undefined, marker, depth)
  return redactURLWords(command, marker, depth)
}

function redactStructuredPairs(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  let cursor = 0
  let index = 0
  let output = ""
  while (index < value.length) {
    if (shellDelimiter(value[index]!)) {
      index++
      continue
    }
    const start = index
    const end = shellWordEnd(value, start)
    if (end === start) {
      index++
      continue
    }
    output += value.slice(cursor, start) + redactStructuredWord(value.slice(start, end), marker, depth)
    cursor = end
    index = end
  }
  return cursor ? output + value.slice(cursor) : value
}

function redactStructuredWord(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  return value
    .replace(/\\"([A-Za-z][A-Za-z0-9_.-]*)\\"(\s*:\s*)\\"((?:\\\\.|[^"\\])*)\\"/gu,
      (match, name: string, separator: string, secret: string) =>
        sensitiveName(name)
          ? '\\"' + name + '\\"' + separator + '\\"' + projectSecret(secret, marker, depth) + '\\"'
          : match)
    .replace(/"([A-Za-z][A-Za-z0-9_.-]*)"(\s*:\s*)"((?:\\.|[^"\\])*)"/gu,
      (match, name: string, separator: string, secret: string) =>
        sensitiveName(name)
          ? '"' + name + '"' + separator + '"' + projectSecret(secret, marker, depth) + '"'
          : match)
    .replace(/'([A-Za-z][A-Za-z0-9_.-]*)'(\s*:\s*)'((?:\\.|[^'\\])*)'/gu,
      (match, name: string, separator: string, secret: string) =>
        sensitiveName(name)
          ? "'" + name + "'" + separator + "'" + projectSecret(secret, marker, depth) + "'"
          : match)
}

function projectSecret(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  const projected = projectShellFragment(value, marker, depth)
  return projected.dynamic.length ? marker + projected.dynamic.join(marker) : marker
}

function redactURLWords(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  const pattern = /\b[a-z][a-z\d+.-]*:\/\//giu
  let cursor = 0
  let output = ""
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const start = match.index
    const quote = quoteContextAt(value, start)
    const end = urlWordEnd(value, start, quote)
    output += value.slice(cursor, start) + redactURL(value.slice(start, end), marker, depth)
    cursor = end
    pattern.lastIndex = end
  }
  return cursor ? output + value.slice(cursor) : value
}

function redactURL(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//iu.exec(value)?.[0]
  if (!scheme) return value
  let projected = redactURLUserinfo(value, scheme.length, marker, depth)
  const parameters = /([?&#])([^?&#=\s]+)=/gu
  let cursor = 0
  let output = ""
  for (let match = parameters.exec(projected); match; match = parameters.exec(projected)) {
    const name = match[2] ?? ""
    if (!sensitiveName(name)) continue
    const start = parameters.lastIndex
    const end = urlValueEnd(projected, start)
    output += projected.slice(cursor, start) + projectSecret(projected.slice(start, end), marker, depth)
    cursor = end
    parameters.lastIndex = end
  }
  if (cursor) projected = output + projected.slice(cursor)
  return projected
}

function redactURLUserinfo(
  value: string,
  authorityStart: number,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  const authorityEnd = urlAuthorityEnd(value, authorityStart)
  const at = delimiterOutsideExpansions(value, authorityStart, authorityEnd, "@")
  if (at === undefined) return value
  const colon = delimiterOutsideExpansions(value, authorityStart, at, ":")
  if (colon === undefined) return value
  return value.slice(0, authorityStart) +
    projectSecret(value.slice(authorityStart, at), marker, depth) +
    value.slice(at)
}

function urlWordEnd(value: string, start: number, quote: '"' | "'" | undefined) {
  let activeQuote = quote
  const stopAtInitialQuote = quote !== undefined
  let index = start
  while (index < value.length) {
    const character = value[index]!
    if (activeQuote) {
      if (character === activeQuote) {
        if (stopAtInitialQuote) return index
        activeQuote = undefined
        index++
        continue
      }
      if (character === "\\" && activeQuote === '"' && index + 1 < value.length) {
        index += 2
        continue
      }
      if (activeQuote === "'") {
        index++
        continue
      }
    } else if (shellDelimiter(character)) {
      return index
    } else if (character === '"' || character === "'") {
      activeQuote = character
      index++
      continue
    }
    if (character === "\\" && index + 1 < value.length) {
      index += 2
      continue
    }
    if (character === "`") {
      index = backtickEnd(value, index)
      continue
    }
    if (character === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
      const end = balancedExpansionEnd(value, index)
      if (end !== undefined) {
        index = end
        continue
      }
    }
    index++
  }
  return index
}

function quoteContextAt(value: string, target: number) {
  let quote: '"' | "'" | undefined
  let index = 0
  while (index < target) {
    const character = value[index]!
    if (quote) {
      if (character === quote) quote = undefined
      else if (character === "\\" && quote === '"' && index + 1 < target) index++
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === "\\" && index + 1 < target) {
      index++
    }
    index++
  }
  return quote
}

function urlAuthorityEnd(value: string, start: number) {
  let index = start
  while (index < value.length) {
    if (value[index] === "/" || value[index] === "?" || value[index] === "#") return index
    const end = expansionAt(value, index)
    if (end !== undefined) {
      index = end
      continue
    }
    index++
  }
  return index
}

function urlValueEnd(value: string, start: number) {
  let index = start
  while (index < value.length) {
    if (value[index] === "&" || value[index] === "#") return index
    const end = expansionAt(value, index)
    if (end !== undefined) {
      index = end
      continue
    }
    index++
  }
  return index
}

function delimiterOutsideExpansions(
  value: string,
  start: number,
  end: number,
  delimiter: string,
) {
  let index = start
  while (index < end) {
    if (value[index] === delimiter) return index
    const next = expansionAt(value, index)
    if (next !== undefined) {
      index = next
      continue
    }
    index++
  }
  return
}

function expansionAt(value: string, index: number) {
  if (value[index] === "`") return backtickEnd(value, index)
  if (value[index] === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
    return balancedExpansionEnd(value, index)
  }
  if (value[index] === "\\" && index + 1 < value.length) return index + 2
  return
}

function redactQuotedFollowingShellWord(
  value: string,
  pattern: RegExp,
  prefixIndex: number,
  quoteIndex: number,
  nameIndex: number | undefined,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  let cursor = 0
  let output = ""
  pattern.lastIndex = 0
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (nameIndex !== undefined && !sensitiveName(match[nameIndex] ?? "")) continue
    const start = pattern.lastIndex
    const wordStart = match.index + (match[prefixIndex]?.length ?? 0)
    const end = shellWordEnd(value, wordStart)
    if (end === start) continue
    const quote = match[quoteIndex] ?? '"'
    const projected = projectShellFragment(quote + value.slice(start, end), marker, depth).text
    output += value.slice(cursor, start) + projected + quote
    cursor = end
    pattern.lastIndex = end
  }
  return cursor ? output + value.slice(cursor) : value
}

function redactFollowingShellWord(
  value: string,
  pattern: RegExp,
  nameIndex: number | undefined,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  let cursor = 0
  let output = ""
  pattern.lastIndex = 0
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (nameIndex !== undefined && !sensitiveName(match[nameIndex] ?? "")) continue
    const start = pattern.lastIndex
    const end = shellWordEnd(value, start)
    if (end === start) continue
    output += value.slice(cursor, start) + projectShellFragment(value.slice(start, end), marker, depth).text
    cursor = end
    pattern.lastIndex = end
  }
  return cursor ? output + value.slice(cursor) : value
}

function redactHeaderWords(value: string, marker: "[redacted]" | "<redacted>", depth: number) {
  const quoted = redactHeaderPattern(
    value,
    /(["'])\s*([A-Za-z][A-Za-z0-9-]*)((?:\s*:\s*)|(?:\\:(?:\\[ \t]|[ \t])*))/gu,
    undefined,
    1,
    2,
    3,
    marker,
    depth,
  )
  const escaped = redactHeaderPattern(
    quoted,
    /(^|[\s;|&(=])([A-Za-z][A-Za-z0-9-]*)(\\:(?:\\[ \t]|[ \t])*)/gu,
    1,
    undefined,
    2,
    3,
    marker,
    depth,
  )
  return redactHeaderPattern(
    escaped,
    /(^|[\s;|&(=])([A-Za-z][A-Za-z0-9-]*)(\s*:\s*)/gu,
    1,
    undefined,
    2,
    3,
    marker,
    depth,
  )
}

function redactHeaderPattern(
  value: string,
  pattern: RegExp,
  prefixIndex: number | undefined,
  quoteIndex: number | undefined,
  nameIndex: number,
  separatorIndex: number,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  let cursor = 0
  let output = ""
  pattern.lastIndex = 0
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const name = match[nameIndex] ?? ""
    if (!sensitiveName(name)) continue
    const prefix = prefixIndex === undefined ? "" : match[prefixIndex] ?? ""
    const quote = quoteIndex === undefined ? "" : match[quoteIndex] ?? ""
    const start = match.index + prefix.length
    const end = shellWordEnd(value, start)
    if (end === start) continue
    const dynamic = projectShellFragment(value.slice(start, end), marker, depth).dynamic
    const projected = quote + name + (match[separatorIndex] ?? ":") + marker +
      dynamic.join(marker) + quote
    output += value.slice(cursor, start) + projected
    cursor = end
    pattern.lastIndex = end
  }
  return cursor ? output + value.slice(cursor) : value
}

function shellWordEnd(value: string, start: number) {
  let index = start
  while (index < value.length && !shellDelimiter(value[index]!)) {
    const character = value[index]!
    if (character === "'") {
      index = quotedEnd(value, index, "'", false)
      continue
    }
    if (character === '"') {
      index = quotedEnd(value, index, '"', true)
      continue
    }
    if (character === "`") {
      index = backtickEnd(value, index)
      continue
    }
    if (character === "\\" && index + 1 < value.length) {
      index += 2
      continue
    }
    if (character === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
      const end = balancedExpansionEnd(value, index)
      if (end !== undefined) {
        index = end
        continue
      }
    }
    index++
  }
  return index
}

function quotedEnd(value: string, start: number, quote: "'" | '"', dynamic: boolean) {
  let index = start + 1
  while (index < value.length) {
    const character = value[index]!
    if (character === quote) return index + 1
    if (quote === '"' && character === "\\" && index + 1 < value.length) {
      index += 2
      continue
    }
    if (dynamic && character === "`") {
      index = backtickEnd(value, index)
      continue
    }
    if (dynamic && character === "$" && (value[index + 1] === "(" || value[index + 1] === "{")) {
      const end = balancedExpansionEnd(value, index)
      if (end !== undefined) {
        index = end
        continue
      }
    }
    index++
  }
  return value.length
}

function balancedExpansionEnd(value: string, start: number) {
  const open = value[start + 1]
  if (open !== "(" && open !== "{") return
  const close = open === "(" ? ")" : "}"
  let depth = 1
  let index = start + 2
  while (index < value.length) {
    const character = value[index]!
    if (character === "'") {
      index = quotedEnd(value, index, "'", false)
      continue
    }
    if (character === '"') {
      index = quotedEnd(value, index, '"', true)
      continue
    }
    if (character === "`") {
      index = backtickEnd(value, index)
      continue
    }
    if (character === "\\" && index + 1 < value.length) {
      index += 2
      continue
    }
    if (character === open) depth++
    if (character === close && --depth === 0) return index + 1
    index++
  }
  return
}

function backtickEnd(value: string, start: number) {
  let index = start + 1
  while (index < value.length) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 2
      continue
    }
    if (value[index] === "`") return index + 1
    index++
  }
  return value.length
}

function projectShellFragment(
  value: string,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  const pieces: string[] = []
  const dynamic: string[] = []
  const literal = () => {
    if (pieces.at(-1) !== marker) pieces.push(marker)
  }
  const expansion = (text: string) => {
    pieces.push(text)
    dynamic.push(text)
  }
  let index = 0
  while (index < value.length) {
    const character = value[index]!
    if (character === "'") {
      const end = quotedEnd(value, index, "'", false)
      literal()
      index = end
      continue
    }
    if (character === '"') {
      const end = quotedEnd(value, index, '"', true)
      projectDynamicRange(value, index + 1, Math.max(index + 1, end - 1), marker, depth, pieces, dynamic, literal)
      index = end
      continue
    }
    if (character === "`") {
      const end = backtickEnd(value, index)
      expansion(projectCommandSubstitution("`", value.slice(index + 1, Math.max(index + 1, end - 1)), marker, depth))
      index = end
      continue
    }
    if (character === "$") {
      const projected = projectDollarExpansion(value, index, marker, depth)
      if (projected) {
        expansion(projected.text)
        index = projected.end
        continue
      }
    }
    if (character === "\\" && index + 1 < value.length) index += 2
    else index++
    literal()
  }
  return { text: pieces.join("") || marker, dynamic }
}

function projectDynamicRange(
  value: string,
  start: number,
  end: number,
  marker: "[redacted]" | "<redacted>",
  depth: number,
  pieces: string[],
  dynamic: string[],
  literal: () => void,
) {
  let index = start
  while (index < end) {
    const character = value[index]!
    if (character === "\\" && index + 1 < end) {
      literal()
      index += 2
      continue
    }
    if (character === "`") {
      const next = Math.min(backtickEnd(value, index), end)
      const text = projectCommandSubstitution("`", value.slice(index + 1, Math.max(index + 1, next - 1)), marker, depth)
      pieces.push(text)
      dynamic.push(text)
      index = next
      continue
    }
    if (character === "$") {
      const projected = projectDollarExpansion(value, index, marker, depth)
      if (projected && projected.end <= end) {
        pieces.push(projected.text)
        dynamic.push(projected.text)
        index = projected.end
        continue
      }
    }
    literal()
    index++
  }
}

function projectDollarExpansion(
  value: string,
  start: number,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  const next = value[start + 1]
  if (next === "(") {
    const end = balancedExpansionEnd(value, start)
    if (end === undefined) return
    return {
      end,
      text: projectCommandSubstitution("$(", value.slice(start + 2, end - 1), marker, depth),
    }
  }
  if (next === "{") {
    const end = balancedExpansionEnd(value, start)
    if (end === undefined) return
    const body = value.slice(start + 2, end - 1)
    const simple = /^([!#]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*?$!-]))$/u.exec(body)
    if (simple) return { end, text: "${" + body + "}" }
    const variable = /^([!#]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*?$!-]))(?::[-=+?]|##?|%%?)?/u.exec(body)
    const prefix = variable?.[0] ?? ""
    const rest = body.slice(prefix.length)
    const projected = projectShellFragment('"' + rest + '"', marker, depth).text
    return { end, text: "${" + prefix + projected + "}" }
  }
  const variable = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])/u.exec(value.slice(start))
  return variable ? { end: start + variable[0].length, text: variable[0] } : undefined
}

function projectCommandSubstitution(
  opener: "`" | "$(",
  body: string,
  marker: "[redacted]" | "<redacted>",
  depth: number,
) {
  if (depth >= 8) return opener === "`" ? "`" + body + "`" : "$(" + body + ")"
  const projected = redactCommandDepth(body, marker, depth + 1)
  return opener === "`" ? "`" + projected + "`" : "$(" + projected + ")"
}

function shellDelimiter(value: string) {
  return /\s|[;&|(){}<>]/u.test(value)
}

function sensitiveName(value: string) {
  const segments = value.toLocaleLowerCase("en-US").split(/[-_.]+/u).filter(Boolean)
  if (segments.some((segment) => SENSITIVE_NAMES.has(segment))) return true
  const compact = segments.join("")
  return /(?:apikey|accesskey|privatekey|token|secret|password|passwd|authorization|credential|credentials|signature)$/u.test(compact)
}
