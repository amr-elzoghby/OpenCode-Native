import { MAX_TRANSCRIPT_MESSAGE_CHARS, type ViewState } from "./protocol"

type Token = import("marked", { with: { "resolution-mode": "import" } }).Token
type Lexer = typeof import("marked", { with: { "resolution-mode": "import" } }).lexer

type Message = ViewState["messages"][number]
type Review = ViewState["reviews"][number]
type Activity = ViewState["activities"][number]
type ActivityItem = Activity["items"][number]
type Turn = { id: string; prompt?: Message; responses: Message[]; activities: Activity[]; review?: Review }
type ResponseView = { element: HTMLElement; text: string; createdAt?: number }
type TurnView = {
  element: HTMLElement
  prompt: HTMLElement
  promptText?: string
  responses: Map<string, ResponseView>
  review?: { element: HTMLElement; signature: string }
  activities: Map<string, ActivityView>
}

type ActivityView = {
  element: HTMLDetailsElement
  summary: HTMLElement
  region: HTMLElement
  items: Map<string, { element: HTMLElement; signature: string }>
  initialized: boolean
}

const MAX_MARKDOWN_NODES = 4_000

export function createTranscript(
  transcript: HTMLElement,
  sticky: HTMLButtonElement,
  openReview: (reviewKey: string, fileKey: string) => void,
) {
  const views = new Map<string, TurnView>()
  let ordered: TurnView[] = []
  let latest: Message[] = []
  let latestReviews: Review[] = []
  let latestActivities: Activity[] = []
  let lexer: Lexer | undefined
  let frame = 0
  let activityExpansion: boolean | undefined

  void import("marked").then((module) => {
    lexer = module.lexer
    views.forEach((view) => view.responses.forEach((response) => {
      response.text = ""
    }))
    render(latest, latestReviews, latestActivities)
  })

  transcript.addEventListener("scroll", scheduleSticky)
  sticky.addEventListener("click", () => {
    const turn = ordered.find((item) => item.element.dataset.turnId === sticky.dataset.turnId)
    if (!turn) return
    transcript.scrollTo({
      top: Math.max(0, turn.element.offsetTop - 8),
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    })
  })

  return {
    render(messages: Message[], reviews: Review[], activities: Activity[]) {
      latest = messages
      latestReviews = reviews
      latestActivities = activities
      render(messages, reviews, activities)
    },
    toggleActivities() {
      const details = Array.from(transcript.querySelectorAll<HTMLDetailsElement>(".turn-activity"))
      const expanded = details.some((item) => !item.open)
      activityExpansion = expanded
      details.forEach((item) => {
        item.open = expanded
      })
      return expanded
    },
    toggleTimestamps() {
      return transcript.classList.toggle("show-timestamps")
    },
    scrollToTurn(turnID: string) {
      const turn = views.get(turnID)
      if (!turn) return false
      turn.element.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      })
      return true
    },
  }

  function render(messages: Message[], reviews: Review[] = [], activities: Activity[] = []) {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
    const turns = group(messages, reviews, activities)
    const retained = new Set(turns.map((turn) => turn.id))
    views.forEach((view, id) => {
      if (retained.has(id)) return
      view.element.remove()
      views.delete(id)
    })
    ordered = turns.map((turn) => {
      const view = views.get(turn.id) ?? createTurn(turn.id)
      views.set(turn.id, view)
      updateTurn(view, turn)
      transcript.append(view.element)
      return view
    })
    if (nearBottom) transcript.scrollTop = transcript.scrollHeight
    scheduleSticky()
  }

  function createTurn(id: string): TurnView {
    const element = document.createElement("section")
    element.className = "turn"
    element.dataset.turnId = id
    const prompt = document.createElement("article")
    prompt.className = "turn-prompt"
    prompt.dir = "auto"
    prompt.setAttribute("aria-label", "You")
    const assistant = document.createElement("div")
    assistant.className = "turn-response"
    assistant.setAttribute("aria-label", "OpenCode")
    element.append(prompt, assistant)
    return { element, prompt, responses: new Map(), activities: new Map() }
  }

  function updateTurn(view: TurnView, turn: Turn) {
    view.prompt.hidden = !turn.prompt
    const promptText = turn.prompt
      ? [turn.prompt.text, ...(turn.prompt.attachments ?? []).map((item) => `@${item}`)].filter(Boolean).join(" · ")
      : undefined
    if (turn.prompt && view.promptText !== promptText) {
      const files = document.createElement("div")
      files.className = "turn-attachments"
      ;(turn.prompt.attachments ?? []).forEach((item) => {
        const chip = document.createElement("span")
        chip.dir = "ltr"
        chip.textContent = `@ ${item}`
        files.append(chip)
      })
      const text = document.createElement("div")
      text.textContent = turn.prompt.text
      view.prompt.replaceChildren(
        ...(turn.prompt.attachments?.length ? [files] : []),
        ...(turn.prompt.text ? [text] : []),
        ...messageTime(turn.prompt.createdAt),
      )
      view.promptText = promptText
    }

    const assistant = view.element.querySelector<HTMLElement>(".turn-response")
    if (!assistant) return
    const retained = new Set(turn.responses.map((response) => response.id))
    view.responses.forEach((response, id) => {
      if (retained.has(id)) return
      response.element.remove()
      view.responses.delete(id)
    })
    const retainedActivities = new Set(turn.activities.map((activity) => activity.messageID))
    view.activities.forEach((activity, messageID) => {
      if (retainedActivities.has(messageID)) return
      activity.element.remove()
      view.activities.delete(messageID)
    })
    const activities = new Map(turn.activities.map((activity) => [activity.messageID, activity]))
    const renderedActivities = new Set<string>()
    turn.responses.forEach((response) => {
      const activity = activities.get(response.id)
      if (activity) {
        const activityView = updateActivity(view, activity)
        assistant.append(activityView.element)
        renderedActivities.add(activity.messageID)
      }
      const existing = view.responses.get(response.id)
      const next = existing ?? { element: document.createElement("article"), text: "", createdAt: undefined }
      next.element.className = "markdown"
      next.element.dir = "auto"
      next.element.hidden = !response.text
      if (next.text !== response.text) {
        next.element.replaceChildren(renderMarkdown(response.text, lexer))
        next.text = response.text
      }
      if (next.createdAt !== response.createdAt || !next.element.querySelector(".message-time")) {
        next.element.querySelector(".message-time")?.remove()
        next.element.append(...messageTime(response.createdAt))
        next.createdAt = response.createdAt
      }
      view.responses.set(response.id, next)
      if (response.text) assistant.append(next.element)
      else next.element.remove()
    })
    turn.activities.forEach((activity) => {
      if (renderedActivities.has(activity.messageID)) return
      assistant.append(updateActivity(view, activity).element)
    })
    updateReview(view, assistant, reviewReady(turn.activities) ? turn.review : undefined)
  }

  function updateActivity(view: TurnView, activity: Activity) {
    const current = view.activities.get(activity.messageID) ?? createActivityView()
    view.activities.set(activity.messageID, current)
    current.summary.textContent = activityLabel(activity)
    current.element.dataset.status = activity.status
    current.element.dataset.activityKey = activity.key
    if (!current.initialized) {
      current.element.open = false
      current.initialized = true
    }
    if (activityExpansion !== undefined) current.element.open = activityExpansion
    const retained = new Set(activity.items.map((item) => item.key))
    current.items.forEach((item, key) => {
      if (retained.has(key)) return
      item.element.remove()
      current.items.delete(key)
    })
    activity.items.forEach((item) => {
      const signature = JSON.stringify(item)
      const existing = current.items.get(item.key)
      if (existing?.signature === signature) {
        current.region.append(existing.element)
        return
      }
      const element = existing?.element ?? document.createElement("div")
      updateActivityItem(element, item)
      current.items.set(item.key, { element, signature })
      current.region.append(element)
    })
    const omitted = current.region.querySelector<HTMLElement>(".activity-omitted")
    omitted?.remove()
    if (activity.truncated) {
      const marker = document.createElement("div")
      marker.className = "activity-omitted"
      marker.textContent = "Earlier completed actions omitted"
      current.region.prepend(marker)
    }
    return current
  }

  function updateReview(view: TurnView, parent: HTMLElement, review: Review | undefined) {
    if (!review) {
      view.review?.element.remove()
      view.review = undefined
      return
    }
    const signature = JSON.stringify(review)
    if (view.review?.signature === signature) {
      parent.append(view.review.element)
      return
    }
    view.review?.element.remove()
    const element = reviewCard(review, openReview)
    view.review = { element, signature }
    parent.append(element)
  }

  function scheduleSticky() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      updateSticky()
    })
  }

  function updateSticky() {
    const scrollTop = transcript.scrollTop
    const active = [...ordered].reverse().find((item) =>
      item.element.offsetTop <= scrollTop + 16 && item.element.offsetTop + item.element.offsetHeight > scrollTop + 16,
    )
    const promptBottom = active && !active.prompt.hidden
      ? active.element.offsetTop + active.prompt.offsetTop + active.prompt.offsetHeight
      : Number.POSITIVE_INFINITY
    const show = !!active?.promptText && scrollTop > promptBottom + 4
    sticky.hidden = !show
    sticky.dataset.turnId = show ? active.element.dataset.turnId : undefined
    sticky.textContent = show ? active.promptText ?? "" : ""
    sticky.title = show ? "Return to the start of this turn" : ""
  }
}

function messageTime(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return []
  const element = document.createElement("time")
  element.className = "message-time"
  element.dateTime = new Date(value).toISOString()
  element.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value)
  return [element]
}

function group(messages: Message[], reviews: Review[], activities: Activity[]) {
  const turns = new Map<string, Turn>()
  messages.forEach((message) => {
    const turn = turns.get(message.turnID) ?? { id: message.turnID, responses: [], activities: [] }
    if (message.role === "user") turn.prompt = message
    if (message.role === "assistant") turn.responses.push(message)
    turns.set(message.turnID, turn)
  })
  reviews.forEach((review) => {
    const turn = turns.get(review.turnID)
    if (turn) turn.review = review
  })
  activities.forEach((activity) => {
    const turn = turns.get(activity.turnID) ?? { id: activity.turnID, responses: [], activities: [] }
    turn.activities.push(activity)
    turns.set(activity.turnID, turn)
  })
  return [...turns.values()]
}

function createActivityView(): ActivityView {
  const element = document.createElement("details")
  element.className = "turn-activity"
  const summary = document.createElement("summary")
  summary.className = "activity-summary"
  const region = document.createElement("div")
  region.className = "activity-items"
  region.setAttribute("role", "region")
  region.setAttribute("aria-label", "OpenCode activity details")
  element.append(summary, region)
  return { element, summary, region, items: new Map(), initialized: false }
}

function updateActivityItem(row: HTMLElement, item: ActivityItem) {
  row.className = "activity-item"
  row.dataset.status = item.status
  row.dataset.kind = item.kind
  const text = document.createElement("div")
  text.className = "activity-item-text"
  text.dir = "auto"
  text.textContent = item.title
  const icon = document.createElement("span")
  icon.className = "activity-item-icon"
  icon.setAttribute("aria-hidden", "true")
  icon.textContent = itemIcon(item.kind)
  const status = document.createElement("span")
  status.className = "activity-item-status"
  status.textContent = itemStatus(item.status)
  const header = document.createElement("div")
  header.className = "activity-item-header"
  header.append(icon, text, status)
  const children: HTMLElement[] = [header]
  if (item.detail) {
    const detail = document.createElement(item.kind === "command" ? "code" : "div")
    detail.className = "activity-item-detail"
    detail.dir = item.kind === "command" ? "ltr" : "auto"
    detail.textContent = item.detail
    children.push(detail)
  }
  ;(item.files ?? []).forEach((file) => {
    const child = document.createElement("div")
    child.className = "activity-file"
    child.dir = "ltr"
    child.textContent = `${file.path}${file.additions === undefined || file.deletions === undefined ? "" : ` · +${file.additions} −${file.deletions}`}`
    children.push(child)
  })
  row.replaceChildren(...children)
}

export function activityLabel(activity: Activity) {
  const duration = activity.startedAt !== undefined && activity.endedAt !== undefined
    ? ` · ${formatDuration(Math.max(0, activity.endedAt - activity.startedAt))}`
    : ""
  const actions = activitySummary(activity.items)
  const active = actions.replace(/^Thought(?:, )?/, "")
  const progress = active.charAt(0).toLowerCase() + active.slice(1)
  if (activity.status === "working") return progress ? `Thinking · ${progress}` : "Thinking"
  if (activity.status === "retrying") return `Retrying · attempt ${activity.retry?.attempt ?? 0}${actions ? ` · ${actions}` : ""}`
  if (activity.status === "interrupted") return `${actions || "Work"} · interrupted${duration}`
  if (activity.status === "failed") return `${actions || "Work"} · failed${duration}`
  return `${actions || "Worked"}${duration}`
}

export function reviewReady(activities: Activity[]) {
  return !activities.some((activity) => activity.status === "working" || activity.status === "retrying")
}

function itemStatus(status: ActivityItem["status"]) {
  if (status === "waiting") return "Waiting"
  if (status === "running") return "Running"
  if (status === "failed") return "Failed"
  if (status === "denied") return "Denied"
  return ""
}

function itemIcon(kind: ActivityItem["kind"]) {
  if (kind === "reasoning") return "✦"
  if (kind === "command") return "›"
  if (kind === "read") return "□"
  if (kind === "search" || kind === "web") return "⌕"
  if (kind === "edit") return "±"
  if (kind === "question") return "?"
  if (kind === "task") return "◇"
  if (kind === "todo") return "✓"
  return "·"
}

function activitySummary(items: ActivityItem[]) {
  const order: ActivityItem["kind"][] = []
  const totals = new Map<ActivityItem["kind"], number>()
  items.forEach((item) => {
    if (!totals.has(item.kind)) order.push(item.kind)
    totals.set(item.kind, (totals.get(item.kind) ?? 0) + 1)
  })
  return order.map((kind) => {
    const count = totals.get(kind) ?? 0
    if (kind === "reasoning") return "Thought"
    if (kind === "command") return `Ran ${count === 1 ? "a command" : "commands"}`
    if (kind === "read") return `Read ${count === 1 ? "a file" : "files"}`
    if (kind === "search") return "Searched the workspace"
    if (kind === "web") return "Searched the web"
    if (kind === "edit") return `Edited ${count === 1 ? "a file" : "files"}`
    if (kind === "task") return `Ran ${count === 1 ? "a subagent" : "subagents"}`
    if (kind === "question") return `Asked ${count === 1 ? "a question" : "questions"}`
    if (kind === "todo") return "Updated tasks"
    return `Used ${count === 1 ? "a tool" : "tools"}`
  }).map((phrase, index) => index ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase).join(", ")
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${Math.round(milliseconds / 1_000)}s`
}

function reviewCard(review: Review, open: (reviewKey: string, fileKey: string) => void) {
  const card = document.createElement("section")
  card.className = "review-card"
  card.setAttribute("aria-label", reviewLabel(review))
  const header = document.createElement("header")
  const identity = document.createElement("div")
  identity.className = "review-identity"
  const title = document.createElement("div")
  const label = document.createElement("strong")
  label.textContent = reviewLabel(review)
  const totals = document.createElement("span")
  totals.className = "review-counts"
  const counted = review.files.filter((file) => !file.overlapsDirect && file.additions !== undefined && file.deletions !== undefined)
  if (counted.length) {
    const additions = counted.reduce((total, file) => total + file.additions!, 0)
    const deletions = counted.reduce((total, file) => total + file.deletions!, 0)
    totals.append(count("+", additions, "added"), document.createTextNode(" "), count("-", deletions, "removed"))
  }
  title.append(label, totals)
  identity.append(title)
  const action = document.createElement("button")
  action.type = "button"
  action.className = "review-action"
  action.textContent = "Review"
  const first = review.files.find((file) => file.reviewable)
  action.disabled = !first
  action.title = first ? "Open the first available native diff" : "Stored review content is unavailable"
  if (first) action.addEventListener("click", () => open(review.key, first.key))
  identity.prepend(cardIcon())
  header.append(identity, action)
  const list = document.createElement("div")
  list.className = "review-files"
  review.files.forEach((file, index) => {
    const row = document.createElement("button")
    row.type = "button"
    row.className = "review-file"
    row.hidden = index >= 3
    row.title = `Open native diff for ${file.path}`
    const path = document.createElement("span")
    path.className = "review-path"
    path.dir = "ltr"
    path.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
    const changes = document.createElement("span")
    changes.className = "review-file-counts"
    if (file.additions !== undefined && file.deletions !== undefined) {
      changes.append(count("+", file.additions, "added"), document.createTextNode(" "), count("-", file.deletions, "removed"))
    } else {
      changes.textContent = "Counts unavailable"
    }
    if (file.provenance === "snapshot") changes.append(document.createTextNode(" · observed"))
    if (file.conflicted) changes.append(document.createTextNode(" · conflict"))
    row.append(path, changes)
    row.disabled = !file.reviewable
    if (file.reviewable) row.addEventListener("click", () => open(review.key, file.key))
    list.append(row)
  })
  if (review.files.length > 3) {
    const more = document.createElement("button")
    more.type = "button"
    more.className = "review-more"
    more.textContent = `Show ${review.files.length - 3} more files`
    more.setAttribute("aria-expanded", "false")
    more.addEventListener("click", () => {
      const expanded = more.getAttribute("aria-expanded") === "true"
      more.setAttribute("aria-expanded", String(!expanded))
      Array.from(list.querySelectorAll<HTMLElement>(".review-file")).forEach((row, index) => {
        row.hidden = expanded && index >= 3
      })
      more.textContent = expanded ? `Show ${review.files.length - 3} more files` : "Show fewer files"
    })
    list.append(more)
  }
  card.append(header, list)
  return card
}

function reviewLabel(review: Review) {
  const direct = new Set(review.files.filter((file) => file.provenance === "direct").map((file) => file.path)).size
  const observed = new Set(review.files.filter((file) => file.provenance === "snapshot").map((file) => file.path)).size
  if (review.attribution === "direct") return `${direct} ${direct === 1 ? "file" : "files"} changed`
  if (review.attribution === "observed") return `${observed} ${observed === 1 ? "file change" : "file changes"} observed`
  return `${direct} ${direct === 1 ? "file" : "files"} changed · ${observed} observed`
}

function cardIcon() {
  const root = document.createElement("span")
  root.className = "review-icon"
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 18 18")
  svg.setAttribute("aria-hidden", "true")
  const box = document.createElementNS(svg.namespaceURI, "rect")
  box.setAttribute("x", "3")
  box.setAttribute("y", "3")
  box.setAttribute("width", "12")
  box.setAttribute("height", "12")
  box.setAttribute("rx", "2")
  box.setAttribute("fill", "none")
  box.setAttribute("stroke", "currentColor")
  box.setAttribute("stroke-width", "1.4")
  const plus = document.createElementNS(svg.namespaceURI, "path")
  plus.setAttribute("d", "M9 6v6M6 9h6")
  plus.setAttribute("fill", "none")
  plus.setAttribute("stroke", "currentColor")
  plus.setAttribute("stroke-width", "1.4")
  plus.setAttribute("stroke-linecap", "round")
  svg.append(box, plus)
  root.append(svg)
  return root
}

function count(prefix: "+" | "-", value: number, className: string) {
  const element = document.createElement("span")
  element.className = className
  element.textContent = `${prefix}${value}`
  return element
}

function renderMarkdown(source: string, lexer: Lexer | undefined) {
  const fragment = document.createDocumentFragment()
  if (!lexer) {
    fragment.appendChild(document.createTextNode(source))
    return fragment
  }
  appendTokens(fragment, lexer(source.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS)), 0, { nodes: 0, truncated: false })
  return fragment
}

function appendTokens(parent: Node, tokens: Token[], depth: number, budget: { nodes: number; truncated: boolean }) {
  if (depth >= 40) {
    if (reserve(parent, budget)) {
      parent.appendChild(document.createTextNode(tokens.map((token) => token.raw).join("").slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS)))
    }
    return
  }
  tokens.forEach((token) => {
    if (token.type === "space" || token.type === "def") return
    if (!reserve(parent, budget)) return
    if (token.type === "heading") {
      const heading = document.createElement(`h${Math.min(6, Math.max(1, token.depth))}`)
      appendTokens(heading, token.tokens ?? [], depth + 1, budget)
      parent.appendChild(heading)
      return
    }
    if (token.type === "paragraph") {
      const paragraph = document.createElement("p")
      appendTokens(paragraph, token.tokens ?? [], depth + 1, budget)
      parent.appendChild(paragraph)
      return
    }
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      const element = document.createElement(token.type === "strong" ? "strong" : token.type === "em" ? "em" : "del")
      appendTokens(element, token.tokens ?? [], depth + 1, budget)
      parent.appendChild(element)
      return
    }
    if (token.type === "codespan") {
      const code = document.createElement("code")
      code.className = "inline-code"
      code.dir = "ltr"
      code.textContent = token.text
      parent.appendChild(code)
      return
    }
    if (token.type === "code") {
      const block = document.createElement("div")
      block.className = "code-block"
      if (token.lang) {
        const language = document.createElement("div")
        language.className = "code-language"
        language.dir = "ltr"
        language.textContent = token.lang.split(/\s+/)[0]
        block.append(language)
      }
      const pre = document.createElement("pre")
      pre.dir = "ltr"
      const code = document.createElement("code")
      code.textContent = token.text
      pre.append(code)
      block.append(pre)
      parent.appendChild(block)
      return
    }
    if (token.type === "list") {
      const value = token as import("marked", { with: { "resolution-mode": "import" } }).Tokens.List
      const list = document.createElement(value.ordered ? "ol" : "ul")
      if (value.ordered && typeof value.start === "number") list.setAttribute("start", String(value.start))
      value.items.forEach((item) => {
        if (!reserve(list, budget)) return
        const row = document.createElement("li")
        appendTokens(row, item.tokens, depth + 1, budget)
        list.append(row)
      })
      parent.appendChild(list)
      return
    }
    if (token.type === "blockquote") {
      const quote = document.createElement("blockquote")
      appendTokens(quote, token.tokens ?? [], depth + 1, budget)
      parent.appendChild(quote)
      return
    }
    if (token.type === "hr") {
      parent.appendChild(document.createElement("hr"))
      return
    }
    if (token.type === "br") {
      parent.appendChild(document.createElement("br"))
      return
    }
    if (token.type === "link") {
      const link = document.createElement("span")
      link.className = "markdown-link"
      appendTokens(link, token.tokens ?? [], depth + 1, budget)
      parent.appendChild(link)
      return
    }
    if (token.type === "image") {
      parent.appendChild(document.createTextNode(token.raw))
      return
    }
    if (token.type === "html") {
      parent.appendChild(document.createTextNode(token.raw))
      return
    }
    if (token.type === "text") {
      if (token.tokens?.length) appendTokens(parent, token.tokens, depth + 1, budget)
      else parent.appendChild(document.createTextNode(token.text))
      return
    }
    const unknown = token as import("marked", { with: { "resolution-mode": "import" } }).Tokens.Generic
    parent.appendChild(document.createTextNode(unknown.raw))
  })
}

function reserve(parent: Node, budget: { nodes: number; truncated: boolean }) {
  if (budget.nodes < MAX_MARKDOWN_NODES) {
    budget.nodes++
    return true
  }
  if (!budget.truncated) parent.appendChild(document.createTextNode("\n… Response truncated for display."))
  budget.truncated = true
  return false
}
