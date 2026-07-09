import { dirname, join, normalize } from "node:path"

const requiredScripts = [
  "db:generate",
  "db:migrate",
  "install:local",
  "lint",
  "typecheck",
  "test",
  "build",
  "format:check",
  "package",
  "package:smoke",
  "update:local",
]
const requiredFiles = [
  "README.md",
  "CONTEXT.md",
  "AGENTS.md",
  "docs/RESEARCH.md",
  "docs/OWNER_MANUAL.md",
  "docs/SECURITY.md",
  "docs/effect-module-conventions.md",
  "docs/runtime-and-layers.md",
  "docs/observability.md",
  "docs/persistence.md",
  ".github/workflows/ci.yml",
  "package.json",
  "turbo.json",
  ".oxlintrc.json",
  "packages/AGENTS.md",
  "packages/agent/AGENTS.md",
  "packages/cli/AGENTS.md",
  "packages/core/AGENTS.md",
  "packages/llm/AGENTS.md",
  "packages/persistence/AGENTS.md",
  "packages/plugin/AGENTS.md",
  "packages/rivet-host/AGENTS.md",
  "packages/tools/AGENTS.md",
  "packages/schema/AGENTS.md",
]

interface DeadAgentReference {
  readonly source: string
  readonly reference: string
  readonly resolved: string
}

const ignoredAgentPath = (path: string) => {
  const segments = path.split("/")
  return segments.includes("node_modules") || segments.includes("dist")
}

const agentReferencePattern = /`([^`]+\/AGENTS\.md)`/g
const agentGlob = new Bun.Glob("**/AGENTS.md")
const agentPaths: Array<string> = []

for await (const path of agentGlob.scan({ cwd: ".", dot: true, absolute: false, onlyFiles: true })) {
  if (!ignoredAgentPath(path)) {
    agentPaths.push(path)
  }
}

const deadAgentReferences = (
  await Promise.all(
    agentPaths.toSorted().map(async (source): Promise<ReadonlyArray<DeadAgentReference>> => {
      const content = await Bun.file(source).text()
      const references = Array.from(content.matchAll(agentReferencePattern), (match) => match[1]).filter(
        (reference): reference is string => reference !== undefined,
      )
      const checks = await Promise.all(
        references.map(async (reference) => {
          const resolved = normalize(join(dirname(source), reference))
          return (await Bun.file(resolved).exists()) ? undefined : { source, reference, resolved }
        }),
      )
      return checks.filter((check): check is DeadAgentReference => check !== undefined)
    }),
  )
).flat()

const packageJson = await Bun.file("package.json").json()
const missingScripts = requiredScripts.filter((script) => packageJson.scripts?.[script] === undefined)
const missingFiles = (
  await Promise.all(requiredFiles.map(async (path) => ((await Bun.file(path).exists()) ? undefined : path)))
).filter((path): path is string => path !== undefined)

if (missingScripts.length === 0 && missingFiles.length === 0 && deadAgentReferences.length === 0) {
  console.log("docs check passed")
  process.exit(0)
}

if (missingScripts.length > 0) {
  console.error(`Missing documented package scripts: ${missingScripts.join(", ")}`)
}

if (missingFiles.length > 0) {
  console.error(`Missing guidance files: ${missingFiles.join(", ")}`)
}

if (deadAgentReferences.length > 0) {
  console.error(
    `Dead AGENTS.md references: ${deadAgentReferences
      .map((reference) => `${reference.source} -> ${reference.reference} (${reference.resolved})`)
      .join(", ")}`,
  )
}

process.exit(1)
