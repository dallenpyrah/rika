import { existsSync } from "node:fs"
import * as Catalog from "../packages/tools/src/tool-catalog"

const evidence = {
  find_files: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  grep: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  create_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  edit_file: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  apply_patch: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  shell: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  shell_command_status: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  git_status: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  web_search: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_web_page: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  view_media: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  find_thread: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  read_thread: "packages/runtime/test/standard-tool-transcripts.native.test.ts",
  oracle: "packages/app/test/specialty-transcripts.test.ts",
  librarian: "packages/app/test/specialty-transcripts.test.ts",
  painter: "packages/app/test/specialty-transcripts.test.ts",
  task: "packages/app/test/specialty-transcripts.test.ts",
} as const

const catalogNames = Catalog.definitions.map(({ name }) => name).toSorted()
const evidenceNames = Object.keys(evidence).toSorted()

if (JSON.stringify(catalogNames) !== JSON.stringify(evidenceNames)) {
  const missing = catalogNames.filter((name) => !evidenceNames.includes(name))
  const unknown = evidenceNames.filter((name) => !catalogNames.includes(name))
  throw new Error(`Catalog evidence mismatch: missing=${missing.join(",")} unknown=${unknown.join(",")}`)
}

const missingFiles = [...new Set(Object.values(evidence))].filter((path) => !existsSync(path))
if (missingFiles.length > 0) throw new Error(`Missing catalog evidence files: ${missingFiles.join(",")}`)

console.log(
  `Catalog evidence complete: ${catalogNames.length} entries across ${new Set(Object.values(evidence)).size} matrices`,
)
