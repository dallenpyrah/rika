const terminalTitleText = (value: string) =>
  value
    .replace(/\p{C}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

const terminalTitleSequence = (title: string, workspace: string) =>
  `\u001b]0;${terminalTitleText(title)} - rika - ${terminalTitleText(workspace.replace(/^\/Users\/[^/]+/, "~"))}\u0007`

export const internal = { terminalTitleSequence }
