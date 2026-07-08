import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const servicesPath = join(root, "deploy/railway/services.json")
const readmePath = join(root, "deploy/railway/README.md")

describe("Railway deploy config", () => {
  test("railway service configs declare Rivet engine storage backend explicitly", () => {
    expect(existsSync(servicesPath)).toBe(true)
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as {
      services: Array<{ name: string; storageBackend?: string }>
    }
    const engine = config.services.find((service) => service.name === "rika-rivet-engine")
    expect(engine?.storageBackend).toBeDefined()
    expect(typeof engine?.storageBackend).toBe("string")
    expect(engine?.storageBackend?.length).toBeGreaterThan(0)
  })

  test("railway pre-deploy runs relational migrations only", () => {
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as {
      services: Array<{ name: string; preDeployCommand?: string }>
    }
    const edge = config.services.find((service) => service.name === "rika-edge")
    expect(edge?.preDeployCommand).toBe("bun run db:migrate")
    expect(edge?.preDeployCommand).not.toMatch(/rm\s+-rf|actor c\.db|filesystem volume/i)
  })

  test("railway PR environments inherit staging not production", () => {
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as {
      environments: {
        staging: { isBaseForPrEnvironments: boolean }
        production: { isBaseForPrEnvironments: boolean }
        pr: { inheritsFrom: string }
      }
    }
    expect(config.environments.staging.isBaseForPrEnvironments).toBe(true)
    expect(config.environments.production.isBaseForPrEnvironments).toBe(false)
    expect(config.environments.pr.inheritsFrom).toBe("staging")
  })

  test("railway public networking documents websocket resume from GetEvents cursor", () => {
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as {
      websocketResume: { required: boolean; mechanism: string }
    }
    const readme = readFileSync(readmePath, "utf8")
    expect(config.websocketResume.required).toBe(true)
    expect(config.websocketResume.mechanism).toMatch(/GetEvents/)
    expect(readme).toMatch(/GetEvents/)
    expect(readme).toMatch(/reconnect/i)
  })

  test("edge service disables idle timeout for long-lived streams", () => {
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as {
      services: Array<{ name: string; idleTimeoutDisabled?: boolean; healthcheckPath?: string }>
    }
    const edge = config.services.find((service) => service.name === "rika-edge")
    expect(edge?.idleTimeoutDisabled).toBe(true)
    expect(edge?.healthcheckPath).toBe("/health")
  })

  test("project is scoped to personal workspace dallenpyrah", () => {
    const config = JSON.parse(readFileSync(servicesPath, "utf8")) as { workspace: string; repository: string }
    expect(config.workspace).toBe("dallenpyrah")
    expect(config.repository).toBe("dallenpyrah/rika")
  })
})
