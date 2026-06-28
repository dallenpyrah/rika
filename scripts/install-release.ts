import { $ } from "bun"
import { homedir } from "node:os"

const artifactName = `rika-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
const source = `dist/release/${artifactName}`
const installDir = Bun.env.RIKA_INSTALL_DIR ?? `${homedir()}/.local/bin`
const target = `${installDir}/rika${process.platform === "win32" ? ".exe" : ""}`

await $`bun run package`
await $`mkdir -p ${installDir}`
await $`cp ${source} ${target}`
await $`chmod +x ${target}`

console.log(JSON.stringify({ installed: target, source }))
