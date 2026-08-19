import type { ViewState } from "./protocol"

type Permission = ViewState["permissions"][number]

export function createPermissions(
  root: HTMLElement,
  reply: (key: string, decision: "allow" | "deny") => void,
  review: (reviewKey: string, fileKey: string) => void,
) {
  let active: string | undefined
  let submitted = false

  return {
    update(permissions: Permission[]) {
      const permission = permissions[0]
      root.hidden = !permission
      if (!permission) {
        active = undefined
        submitted = false
        root.replaceChildren()
        return
      }
      if (active === permission.key && !submitted) return
      active = permission.key
      submitted = false
      const title = document.createElement("strong")
      title.dir = "auto"
      title.textContent = permission.title
      const details = document.createElement("div")
      details.className = "permission-details"
      permission.details.forEach((value) => {
        const line = document.createElement("code")
        line.dir = "ltr"
        line.textContent = value
        details.append(line)
      })
      permission.files.forEach((file) => {
        const open = button(`Review ${file.path}`, "permission-review", () => review(permission.key, file.key))
        details.append(open)
      })
      const actions = document.createElement("div")
      actions.className = "permission-actions"
      const deny = button("Deny", "permission-deny", () => submit("deny"))
      const allow = button("Allow", "permission-allow", () => submit("allow"))
      actions.append(deny, allow)
      root.replaceChildren(title, details, actions)

      function submit(decision: "allow" | "deny") {
        submitted = true
        Array.from(actions.querySelectorAll("button")).forEach((item) => { item.disabled = true })
        reply(permission.key, decision)
      }
    },
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
