const root = new URL("../..", import.meta.url).pathname

export const packageCli = async () => {
  if (process.argv.includes("list")) return
  const target = `${process.platform}-${process.arch}`
  const child = Bun.spawn(["bun", "run", "package", "--", "--target", target], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`Packaging ${target} exited with code ${exitCode}`)
  const staging = `${root}/artifacts/extracted.${process.pid}`
  const extracted = `${root}/artifacts/extracted`
  await Bun.$`rm -rf ${staging}`.quiet()
  await Bun.$`mkdir -p ${staging}`.quiet()
  const extract = Bun.spawn(["tar", "-xzf", `${root}/artifacts/rika-${target}.tar.gz`, "-C", staging], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const extractExit = await extract.exited
  if (extractExit !== 0) throw new Error(`Extracting rika-${target}.tar.gz exited with code ${extractExit}`)
  await Bun.$`rm -rf ${extracted}`.quiet()
  await Bun.$`mv ${staging} ${extracted}`.quiet()
}

export default packageCli
