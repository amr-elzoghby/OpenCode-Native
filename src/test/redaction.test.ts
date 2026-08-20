import { equal } from "node:assert/strict"
import { redactCommand } from "../redaction"

describe("display-safe command redaction", () => {
  it("redacts complete shell words without hiding redirection syntax", () => {
    const cases = [
      ['TOKEN="first\\"second secret" command', "TOKEN=[redacted] command"],
      ["TOKEN=first\\ second command", "TOKEN=[redacted] command"],
      ["TOKEN='first'\\''second' command", "TOKEN=[redacted] command"],
      ['curl --token="first\\"second secret"', "curl --token=[redacted]"],
      ["TOKEN=secret>target.txt command", "TOKEN=[redacted]>target.txt command"],
      ['curl "https://example.test/#sig=azure-secret"', 'curl "https://example.test/#sig=[redacted]"'],
      ['TOKEN="$(rm -rf /tmp/project)" command', "TOKEN=$(rm -rf /tmp/project) command"],
      ['--token="$(echo ok)" command', "--token=$(echo ok) command"],
      ["Authorization:Bearer\\ literal-secret", "Authorization:[redacted]"],
      ['"Authorization: Bearer "' + "'literal-secret'", '"Authorization: [redacted]"'],
      ['curl -H "  Authorization: Bearer literal-secret"', 'curl -H "Authorization: [redacted]"'],
      ['TOKEN="prefix$(INNER_TOKEN=inside command)suffix" command',
        "TOKEN=[redacted]$(INNER_TOKEN=[redacted] command)[redacted] command"],
      ["--api-key ${KEY:-literal-secret}", "--api-key ${KEY:-[redacted]}"],
      ["GITHUB_PAT=pat-value command", "GITHUB_PAT=[redacted] command"],
      ['curl -d ' + "'{\"password\":\"json-secret\",\"user\":\"ok\"}'",
        'curl -d ' + "'{\"password\":\"[redacted]\",\"user\":\"ok\"}'"],
      ['curl "https://example.test/?token=$(id)"',
        'curl "https://example.test/?token=[redacted]$(id)"'],
      ["curl https://user:$(id)@example.test", "curl https://[redacted]$(id)@example.test"],
      ['curl "--token=literal-secret"', 'curl "--token=[redacted]"'],
      ["TOKEN+=literal-secret command", "TOKEN+=[redacted] command"],
      ['env "TOKEN=literal-secret" command', 'env "TOKEN=[redacted]" command'],
      ["curl -H Authorization\\:\\ Bearer\\ literal-secret", "curl -H Authorization\\:\\ [redacted]"],
      ['$env:OPENAI_API_KEY = "powershell-secret"; command',
        "$env:OPENAI_API_KEY = [redacted]; command"],
      ['curl "-u=user:password-secret"', 'curl "-u=[redacted]"'],
      ['curl "https://example.test/?token=literal$(echo ok)"',
        'curl "https://example.test/?token=[redacted]$(echo ok)"'],
      ['curl "https://user:literal$(echo ok)@example.test/"',
        'curl "https://[redacted]$(echo ok)@example.test/"'],
      ['curl -d "{\\"password\\":\\"literal-secret\\"}"',
        'curl -d "{\\"password\\":\\"[redacted]\\"}"'],
      ["echo \"'token':'$(id)'\"", "echo \"'token':'[redacted]$(id)'\""],
      ['curl --token"=literal-secret"', 'curl --token"=[redacted]"'],
      ['env "TOKEN"=literal-secret command', 'env "TOKEN"=[redacted] command'],
      ['echo "see https://example.test/?token=literal" && rm -rf /tmp/project',
        'echo "see https://example.test/?token=[redacted]" && rm -rf /tmp/project'],
      ['curl https://example.test/?token="literal secret" && echo ok',
        "curl https://example.test/?token=[redacted] && echo ok"],
    ]
    for (const [command, expected] of cases) equal(redactCommand(command!, "[redacted]"), expected)
  })

  it("keeps deeply nested executable substitutions visible", () => {
    let command = "rm -rf /tmp/project"
    for (let index = 0; index < 12; index++) command = "TOKEN=$(" + command + ")"
    equal(redactCommand(command, "[redacted]").includes("rm -rf /tmp/project"), true)
  })

  it("never redacts across shell control operators", () => {
    const command = "echo " + "'\"token\":\"'" + " && rm -rf /tmp/project && echo " + "'\"'"
    const projected = redactCommand(command, "[redacted]")
    equal(projected.includes("rm -rf /tmp/project"), true)
    equal(projected, command)
  })
})
