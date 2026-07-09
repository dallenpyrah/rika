import { $ } from "bun"
import { homedir } from "node:os"

export interface InstallPlanInput {
  readonly platform: string
  readonly arch: string
  readonly installDir: string
  readonly shareDir: string
  readonly pid?: number
}

export interface InstallPlan {
  readonly artifactName: string
  readonly source: string
  readonly target: string
  readonly tempTarget: string
  readonly shareDir: string
  readonly installDir: string
  readonly compiledSource?: string
  readonly compiledTarget?: string
  readonly compiledTempTarget?: string
}

export const artifactNameFor = (platform: string, arch: string) =>
  `rika-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`

export const installPlan = (input: InstallPlanInput): InstallPlan => {
  const artifactName = artifactNameFor(input.platform, input.arch)
  const pid = input.pid ?? process.pid
  const source = `dist/release/${artifactName}`
  const target = `${input.installDir}/rika${input.platform === "win32" ? ".exe" : ""}`
  const tempTarget = `${target}.tmp-${pid}`
  if (input.platform === "win32") {
    return { artifactName, source, target, tempTarget, shareDir: input.shareDir, installDir: input.installDir }
  }

  const compiledName = `${artifactName}.bin`
  const compiledTarget = `${input.installDir}/${compiledName}`
  return {
    artifactName,
    source,
    target,
    tempTarget,
    shareDir: input.shareDir,
    installDir: input.installDir,
    compiledSource: `dist/release/${compiledName}`,
    compiledTarget,
    compiledTempTarget: `${compiledTarget}.tmp-${pid}`,
  }
}

export const planFromEnv = () => {
  const installDir = Bun.env.RIKA_INSTALL_DIR ?? `${homedir()}/.local/bin`
  return installPlan({
    platform: process.platform,
    arch: process.arch,
    installDir,
    shareDir: Bun.env.RIKA_SHARE_DIR ?? `${installDir}/../share/rika`,
  })
}

export const installRelease = async (plan: InstallPlan = planFromEnv()) => {
  await $`bun run package`
  await $`mkdir -p ${plan.installDir}`
  if (plan.compiledSource !== undefined && plan.compiledTempTarget !== undefined && plan.compiledTarget !== undefined) {
    await $`cp ${plan.compiledSource} ${plan.compiledTempTarget}`
    await $`chmod +x ${plan.compiledTempTarget}`
    await $`mv ${plan.compiledTempTarget} ${plan.compiledTarget}`
  }
  await $`cp ${plan.source} ${plan.tempTarget}`
  await $`chmod +x ${plan.tempTarget}`
  await $`mv ${plan.tempTarget} ${plan.target}`
  await $`rm -rf ${plan.shareDir}`
  await $`mkdir -p ${plan.shareDir}`
  await $`cp -R dist/share/rika/. ${plan.shareDir}`

  console.log(JSON.stringify({ installed: plan.target, share: plan.shareDir, source: plan.source }))
}

if (import.meta.main) await installRelease()
