import type { ViewState } from "./protocol"

type Prompt = ViewState["questions"][number]
type Answer = { questionKey: string; optionKeys: string[]; custom?: string }

export function createQuestions(
  root: HTMLElement,
  reply: (key: string, answers: Answer[]) => void,
  reject: (key: string) => void,
) {
  let active: string | undefined
  let index = 0
  let answers = new Map<string, Answer>()
  let submitted = false

  return {
    update(prompts: Prompt[]) {
      const prompt = prompts[0]
      root.hidden = !prompt
      if (!prompt) {
        active = undefined
        index = 0
        answers.clear()
        submitted = false
        root.replaceChildren()
        return
      }
      if (active !== prompt.key) {
        active = prompt.key
        index = 0
        answers = new Map()
        submitted = false
      } else {
        return
      }
      render(prompt)
    },
  }

  function render(prompt: Prompt) {
    if (index === prompt.questions.length) return renderConfirmation(prompt)
    const question = prompt.questions[index]
    if (!question) return
    const progress = document.createElement("nav")
    progress.className = "question-progress"
    progress.setAttribute("aria-label", "Question navigation")
    const previousStep = button("←", "question-step", () => {
      save(question, options, custom)
      index--
      render(prompt)
    })
    previousStep.disabled = index === 0
    previousStep.setAttribute("aria-label", "Previous question")
    const count = document.createElement("span")
    count.textContent = `Question ${index + 1} of ${prompt.questions.length}`
    const nextStep = button("→", "question-step", () => advance(prompt, question, options, custom))
    nextStep.setAttribute("aria-label", "Next question")
    progress.append(previousStep, count, nextStep)
    const header = document.createElement("h3")
    header.tabIndex = -1
    header.dir = "auto"
    header.textContent = question.header
    const text = document.createElement("p")
    text.className = "question-text"
    text.dir = "auto"
    text.textContent = question.question
    const options = document.createElement("div")
    options.className = "question-options"
    options.setAttribute("role", "group")
    options.setAttribute("aria-label", question.header)
    const saved = answers.get(question.key)
    question.options.forEach((option) => {
      const label = document.createElement("label")
      label.className = "question-option"
      const input = document.createElement("input")
      input.type = question.multiple ? "checkbox" : "radio"
      input.name = `question-${question.key}`
      input.value = option.key
      input.checked = saved?.optionKeys.includes(option.key) === true
      const title = document.createElement("span")
      title.dir = "auto"
      title.textContent = option.label
      const description = document.createElement("small")
      description.dir = "auto"
      description.textContent = option.description
      label.append(input, title, description)
      options.append(label)
    })
    const custom = question.custom ? document.createElement("input") : undefined
    if (custom) {
      custom.type = "text"
      custom.className = "question-custom"
      custom.dir = "auto"
      custom.maxLength = 2_000
      custom.placeholder = "Type another answer"
      custom.setAttribute("aria-label", "Custom answer")
      custom.value = saved?.custom ?? ""
    }
    const actions = document.createElement("div")
    actions.className = "question-actions"
    const cancel = button("Cancel", "question-cancel", () => {
      submitted = true
      disable(actions)
      reject(prompt.key)
      retry(prompt)
    })
    const previous = index > 0 ? button("Back", "question-back", () => {
      save(question, options, custom)
      index--
      render(prompt)
    }) : undefined
    const next = button(index === prompt.questions.length - 1 ? "Review" : "Next", "question-next", () => advance(prompt, question, options, custom))
    actions.append(cancel)
    if (previous) actions.append(previous)
    actions.append(next)
    if (submitted) disable(actions)
    root.replaceChildren(progress, header, text, options)
    if (custom) root.append(custom)
    root.append(actions)
    header.focus()
  }

  function advance(prompt: Prompt, question: Prompt["questions"][number], options: HTMLElement, custom?: HTMLInputElement) {
    if (!save(question, options, custom)) {
      options.querySelector<HTMLInputElement>("input")?.focus()
      return
    }
    index++
    render(prompt)
  }

  function renderConfirmation(prompt: Prompt) {
    const progress = document.createElement("div")
    progress.className = "question-progress"
    progress.textContent = "Review answers"
    const header = document.createElement("h3")
    header.tabIndex = -1
    header.textContent = "Confirm your answers"
    const summary = document.createElement("ol")
    summary.className = "question-summary"
    prompt.questions.forEach((question) => {
      const answer = answers.get(question.key)!
      const selected = question.options.filter((option) => answer.optionKeys.includes(option.key)).map((option) => option.label)
      if (answer.custom) selected.push(answer.custom)
      const row = document.createElement("li")
      const title = document.createElement("strong")
      title.dir = "auto"
      title.textContent = question.header
      const value = document.createElement("span")
      value.dir = "auto"
      value.textContent = selected.join(", ")
      row.append(title, value)
      summary.append(row)
    })
    const actions = document.createElement("div")
    actions.className = "question-actions"
    const cancel = button("Cancel", "question-cancel", () => {
      submitted = true
      disable(actions)
      reject(prompt.key)
      retry(prompt)
    })
    const back = button("Back", "question-back", () => {
      index--
      render(prompt)
    })
    const submit = button("Submit", "question-next", () => {
      submitted = true
      disable(actions)
      reply(prompt.key, prompt.questions.map((item) => answers.get(item.key)!))
      retry(prompt)
    })
    actions.append(cancel, back, submit)
    if (submitted) disable(actions)
    root.replaceChildren(progress, header, summary, actions)
    header.focus()
  }

  function save(question: Prompt["questions"][number], options: HTMLElement, custom?: HTMLInputElement) {
    const optionKeys = Array.from(options.querySelectorAll<HTMLInputElement>("input:checked"), (input) => input.value)
    const value = custom?.value.trim()
    if (optionKeys.length === 0 && !value) return
    const answer = { questionKey: question.key, optionKeys, ...(value ? { custom: value } : {}) }
    answers.set(question.key, answer)
    return answer
  }

  function retry(prompt: Prompt) {
    window.setTimeout(() => {
      if (active !== prompt.key || !submitted) return
      submitted = false
      render(prompt)
    }, 1_500)
  }
}

function button(label: string, className: string, click: () => void) {
  const value = document.createElement("button")
  value.type = "button"
  value.className = className
  value.textContent = label
  value.addEventListener("click", click)
  return value
}

function disable(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true })
}
