# Privacy Policy

Effective date: August 20, 2026

This policy applies to the OpenCode Native Sidebar VS Code extension. OpenCode Native Sidebar is an independent community extension and is not affiliated with the OpenCode team. The official OpenCode CLI, model providers, and user-configured integrations have their own privacy practices.

## Summary

OpenCode Native does not operate a publisher-owned backend and does not include publisher analytics, advertising, or telemetry. The publisher does not receive your prompts, source code, files, credentials, conversations, or usage data through the extension.

## Data processed on your device

OpenCode Native starts the user-installed OpenCode CLI in the VS Code Extension Host environment and communicates with it through an authenticated loopback connection. To provide the features you request, the extension may process prompts, responses, session history, tool activity, workspace information, editor selections, and files or attachments that you explicitly add.

Provider credentials entered through `/connect` pass from trusted VS Code host input to the locally running OpenCode Core. They are not intentionally sent to the sidebar Webview or to the OpenCode Native publisher. OpenCode Core controls how provider authentication is stored and used.

## Data sent to third parties

When you submit a prompt or attachment, OpenCode Core may send that content and related context to the model provider you selected. Tool calls may also send relevant data to MCP servers or other integrations that you configured. Those transfers are controlled by OpenCode and the applicable provider or integration, and are governed by their privacy policies and your account settings.

OpenCode agents may read or modify workspace files and run terminal commands according to OpenCode Core configuration and permissions. Do not include secrets or personal data unless you intend to send them to the selected provider or tool.

The `/share` command creates a public chat link only after an explicit confirmation. Anyone with that link may be able to read the shared conversation. Use `/unshare` to remove the link; retention by OpenCode or another service remains subject to that service's policies.

## Storage and retention

OpenCode Native does not keep a separate cloud copy of your conversations. Sessions, configuration, and provider authentication are managed by the OpenCode installation in the environment where the VS Code Extension Host runs. Model providers and configured integrations may retain data under their own policies.

You can delete sessions through History, disconnect providers through OpenCode, remove shared links with `/unshare`, and remove local OpenCode data using the controls and documentation provided by OpenCode. Uninstalling OpenCode Native does not automatically delete data maintained by OpenCode or third parties.

## Security

OpenCode Native keeps authenticated Core credentials out of the Webview and redacts supported credential patterns from displayed command activity. Redaction is a defense-in-depth measure, not a substitute for avoiding secrets in prompts, files, commands, logs, or repository history.

## Changes and contact

Material changes to this policy will be published in this file with an updated effective date.

For privacy questions, open a [GitHub issue](https://github.com/amr-elzoghby/OpenCode-Native/issues) without including secrets or personal data. Report sensitive security issues privately through [GitHub Security Advisories](https://github.com/amr-elzoghby/OpenCode-Native/security/advisories/new).
