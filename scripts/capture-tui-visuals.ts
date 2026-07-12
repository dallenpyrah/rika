import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureVisuals } from "../packages/tui/test/visual.capture"

const candidate = await mkdtemp(join(tmpdir(), "rika-visual-candidate-"))
try {
  await captureVisuals(candidate)
  if (process.argv.includes("--approve")) {
    const approved = join(import.meta.dir, "../packages/tui/test/fixtures/visual")
    await rm(approved, { recursive: true, force: true })
    await cp(candidate, approved, { recursive: true })
    console.log(`Approved visual baseline: ${approved}`)
  } else {
    console.log(`Captured visual candidate: ${candidate}`)
    console.log("Review it, then run with --approve to replace the frozen baseline.")
  }
} finally {
  if (process.argv.includes("--approve")) await rm(candidate, { recursive: true, force: true })
}
