export type PickerOption = {
  value: string
  label: string
  group?: string
}

let pickerCount = 0

export function createPicker(root: HTMLElement, searchable: boolean, select: (value: string) => void) {
  const pickerID = `opencode-picker-${pickerCount++}`
  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "picker-trigger"
  trigger.setAttribute("aria-haspopup", "listbox")
  trigger.setAttribute("aria-expanded", "false")
  trigger.setAttribute("aria-controls", pickerID)
  const label = document.createElement("span")
  label.className = "picker-label"
  label.dir = "auto"
  const chevron = document.createElement("span")
  chevron.className = "picker-chevron"
  chevron.ariaHidden = "true"
  trigger.append(label, chevron)

  const menu = document.createElement("div")
  menu.className = "picker-menu"
  menu.hidden = true
  const search = document.createElement("input")
  search.className = "picker-search"
  search.type = "search"
  search.placeholder = "Search…"
  search.setAttribute("aria-label", "Search options")
  search.setAttribute("aria-controls", pickerID)
  search.setAttribute("aria-haspopup", "listbox")
  search.setAttribute("aria-expanded", "false")
  search.hidden = !searchable
  const list = document.createElement("div")
  list.id = pickerID
  list.className = "picker-list"
  list.setAttribute("role", "listbox")
  menu.append(search, list)
  root.append(trigger, menu)

  let options: PickerOption[] = []
  let selected: string | undefined
  const visibleButtons: HTMLButtonElement[] = []
  let active = -1

  trigger.addEventListener("click", () => {
    const opening = menu.hidden
    closeOpenPickers()
    if (opening) open()
  })
  search.addEventListener("input", renderList)
  root.addEventListener("keydown", (event) => {
    if (menu.hidden && event.key === "ArrowDown") {
      event.preventDefault()
      open()
      return
    }
    if (menu.hidden) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      trigger.focus()
      return
    }
    if (event.key === "Tab") {
      close()
      return
    }
    if (event.key === "ArrowDown") move(1, event)
    if (event.key === "ArrowUp") move(-1, event)
    if (event.key === "Home") activate(0, event)
    if (event.key === "End") activate(visibleButtons.length - 1, event)
    if (event.key === "Enter") {
      event.preventDefault()
      visibleButtons[active]?.click()
    }
  })
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target as Node)) close()
  })

  return {
    update(next: PickerOption[], value: string | undefined, placeholder: string, disabled: boolean) {
      options = next
      selected = value
      label.textContent = next.find((item) => item.value === value)?.label ?? placeholder
      trigger.disabled = disabled
      trigger.title = label.textContent
      if (menu.hidden) return
      renderList()
    },
    hide(value: boolean) {
      root.hidden = value
      if (value) close()
    },
    open() {
      if (!trigger.disabled && root.hidden === false) open()
    },
    isOpen() {
      return !menu.hidden
    },
  }

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = options.filter((item) => !query || `${item.group ?? ""} ${item.label}`.toLocaleLowerCase().includes(query))
    const groups = new Map<string, PickerOption[]>()
    visible.forEach((item) => groups.set(item.group ?? "", [...(groups.get(item.group ?? "") ?? []), item]))
    active = -1
    visibleButtons.length = 0
    list.replaceChildren(...[...groups].flatMap(([group, items]) => {
      const heading = document.createElement("div")
      heading.className = "picker-group"
      heading.textContent = group
      heading.hidden = !group
      return [heading, ...items.map((item) => {
        const option = document.createElement("button")
        option.type = "button"
        option.className = "picker-option"
        option.id = `${pickerID}-${visibleButtons.length}`
        option.tabIndex = -1
        option.dir = "auto"
        option.setAttribute("role", "option")
        option.setAttribute("aria-selected", String(item.value === selected))
        option.textContent = item.label
        option.addEventListener("click", () => {
          select(item.value)
          close()
          trigger.focus()
        })
        option.addEventListener("pointerenter", () => setActive(visibleButtons.indexOf(option)))
        visibleButtons.push(option)
        return option
      })]
    }))
    setActive(Math.max(0, visibleButtons.findIndex((item) => item.getAttribute("aria-selected") === "true")))
  }

  function close() {
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
    trigger.removeAttribute("aria-activedescendant")
    search.removeAttribute("aria-activedescendant")
    search.setAttribute("aria-expanded", "false")
  }

  function open() {
    menu.hidden = false
    trigger.setAttribute("aria-expanded", "true")
    search.setAttribute("aria-expanded", "true")
    search.value = ""
    renderList()
    if (searchable) search.focus()
    if (!searchable) trigger.focus()
  }

  function move(offset: number, event: KeyboardEvent) {
    if (!visibleButtons.length) return
    activate((active + offset + visibleButtons.length) % visibleButtons.length, event)
  }

  function activate(index: number, event: KeyboardEvent) {
    if (!visibleButtons[index]) return
    event.preventDefault()
    setActive(index)
    visibleButtons[index].scrollIntoView({ block: "nearest" })
  }

  function setActive(index: number) {
    active = index
    visibleButtons.forEach((item, itemIndex) => item.classList.toggle("active", itemIndex === active))
    const id = visibleButtons[active]?.id
    if (!id) return
    trigger.setAttribute("aria-activedescendant", id)
    search.setAttribute("aria-activedescendant", id)
  }

  function closeOpenPickers() {
    document.querySelectorAll<HTMLElement>(".picker-menu:not([hidden])").forEach((item) => {
      item.hidden = true
      item.previousElementSibling?.setAttribute("aria-expanded", "false")
      item.previousElementSibling?.removeAttribute("aria-activedescendant")
      item.querySelector("input")?.setAttribute("aria-expanded", "false")
      item.querySelector("input")?.removeAttribute("aria-activedescendant")
    })
  }
}
