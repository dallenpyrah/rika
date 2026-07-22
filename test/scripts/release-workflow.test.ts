import { expect, test } from "vitest"

type Step = {
  readonly uses?: string
  readonly run?: string
}

type Job = {
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: ReadonlyArray<Step>
}

type Workflow = {
  readonly permissions?: Readonly<Record<string, string>>
  readonly jobs?: Readonly<Record<string, Job>>
}

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/publish.yml").text()) as Workflow
const jobs = workflow.jobs ?? {}
const steps = (job: string) => jobs[job]?.steps ?? []
const commands = (job: string) =>
  steps(job)
    .flatMap((step) => (step.run === undefined ? [] : [step.run]))
    .join("\n")

test("publishes only unchanged, attested native archives from a validated tag", () => {
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(jobs.package?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
  expect(jobs.aggregate?.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" })
  expect(jobs.publish?.permissions).toEqual({ contents: "write" })

  expect(commands("package").match(/bun run package/g)).toHaveLength(1)
  expect(commands("package")).toContain("bun run release-smoke")
  expect(commands("aggregate")).toContain("bun run package -- --aggregate")
  expect(commands("aggregate")).toContain("gh attestation verify")
  expect(commands("publish")).not.toMatch(/bun (?:install|build)|bun run package/)
  expect(commands("publish")).toContain("sha256sum --check SHA256SUMS")
  expect(commands("publish")).toContain("gh release create")
  expect(commands("publish")).toContain("gh release edit")

  const actionReferences = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
  expect(actionReferences.length).toBeGreaterThan(0)
  for (const reference of actionReferences) expect(reference).toMatch(/@[a-f0-9]{40}$/)
  expect(actionReferences.filter((reference) => reference.startsWith("actions/attest-build-provenance@"))).toHaveLength(
    2,
  )
  expect(actionReferences.some((reference) => reference.startsWith("actions/attest@"))).toBe(false)
  expect(JSON.stringify(workflow)).not.toMatch(/npm (?:publish|pack)/)
})
