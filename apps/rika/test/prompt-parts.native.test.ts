import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { ViewState } from "@rika/tui"
import {
  countAddedLines,
  countAddedLinesFromFile,
  defaultOpenArguments,
  initialSubmitAction,
  materializePromptParts,
  parseChangedFiles,
  pasteClipboardPng,
  pastedImagePath,
  persistPastedImage,
  readChangedFiles,
  resolveWorkspaceFile,
} from "../src/main"

const workspaces: Array<string> = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => Bun.$`rm -rf ${path}`.quiet()))
})

test("materializes ordered text and dropped image paths for submission", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-prompt-parts-${crypto.randomUUID()}`
  workspaces.push(workspace)
  await Bun.write(`${workspace}/relative image.png`, Uint8Array.from([1, 2, 3]))
  await Bun.write(`${workspace}/url image.webp`, Uint8Array.from([4, 5]))
  const prompt = `before relative\\ image.png middle file://${workspace}/url%20image.webp after`
  const parts = await Effect.runPromise(materializePromptParts(ViewState.promptParts(prompt), workspace))
  expect(parts).toEqual([
    { type: "text", text: "before " },
    { type: "image", mediaType: "image/png", data: "AQID", filename: "relative image.png" },
    { type: "text", text: " middle " },
    { type: "image", mediaType: "image/webp", data: "BAU=", filename: `${workspace}/url image.webp` },
    { type: "text", text: " after" },
  ])
})

test("materializes exact precomputed pasted text and image parts without reparsing text", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-prompt-parts-${crypto.randomUUID()}`
  workspaces.push(workspace)
  await Bun.write(`${workspace}/shot.png`, Uint8Array.from([1, 2, 3]))
  const input = [
    { type: "text", text: "pasted line one\npasted [not-an-attachment.png] line two" },
    { type: "image", path: "shot.png" },
  ] as const

  expect(await Effect.runPromise(materializePromptParts(input, workspace))).toEqual([
    input[0],
    { type: "image", mediaType: "image/png", data: "AQID", filename: "shot.png" },
  ])
})

test("preserves expanded text-only paste parts instead of falling back to the composer token", async () => {
  const token = String.fromCharCode(0xe000)
  const model = ViewState.update(
    { ...ViewState.initial("/work"), input: "before ", cursor: 7 },
    { _tag: "Pasted", text: "first line\nsecond line" },
  )
  const completed = ViewState.update(model, {
    _tag: "KeyPressed",
    key: { name: "x", sequence: " after", ctrl: false, alt: false, meta: false, shift: false, eventType: "press" },
  })

  expect(completed.input).toBe(`before ${token} after`)
  expect(
    await Effect.runPromise(
      materializePromptParts(ViewState.promptParts(completed.input, completed.pastedText), "/work"),
    ),
  ).toEqual([{ type: "text", text: "before first line\nsecond line after" }])
})

test("builds the initial interactive submission from CLI prompt words and selected mode", () => {
  expect(initialSubmitAction([], "medium")).toBeUndefined()
  expect(initialSubmitAction(["inspect", "this.png"], "ultra")).toEqual({
    _tag: "Submit",
    prompt: "inspect this.png",
    parts: [
      { type: "text", text: "inspect " },
      { type: "image", path: "this.png" },
    ],
    mode: "ultra",
  })
})

test("parses nested changed paths, rename destinations, and diff counts", () => {
  expect(
    parseChangedFiles(
      "?? apps/rika/src/new file.ts\0 M packages/tui/src/adapter.ts\0R  docs/new -> name.ts\0old.ts\0?? odd\tline\nname.ts\0",
      ["4\t1\tpackages/tui/src/adapter.ts", "2\t0\t", "old.ts", "docs/new -> name.ts", ""].join("\0"),
    ),
  ).toEqual([
    { path: "apps/rika/src/new file.ts", status: "??" },
    { path: "packages/tui/src/adapter.ts", status: "M", added: 4, removed: 1 },
    { path: "docs/new -> name.ts", status: "R", added: 2, removed: 0 },
    { path: "odd\tline\nname.ts", status: "??" },
  ])
})

test("counts text additions for untracked files and treats empty or binary files as zero", () => {
  expect(countAddedLines(new TextEncoder().encode("one\ntwo\n"))).toBe(2)
  expect(countAddedLines(new TextEncoder().encode("one\ntwo"))).toBe(2)
  expect(countAddedLines(new Uint8Array())).toBe(0)
  expect(countAddedLines(Uint8Array.from([1, 0, 2]))).toBe(0)
})

test("opens files with the platform default application when no editor is configured", () => {
  expect(defaultOpenArguments("/work/file.ts", "darwin")).toEqual(["open", "/work/file.ts"])
  expect(defaultOpenArguments("/work/file.ts", "linux")).toEqual(["xdg-open", "/work/file.ts"])
  expect(defaultOpenArguments("C:\\work\\file.ts", "win32")).toEqual(["cmd", "/c", "start", "", "C:\\work\\file.ts"])
})

test("rejects workspace symlinks that resolve outside the workspace before opening or counting", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-path-root-${crypto.randomUUID()}`
  const outside = `${process.env.TMPDIR ?? "/tmp"}/rika-path-outside-${crypto.randomUUID()}.ts`
  workspaces.push(workspace, outside)
  await Bun.write(outside, "private\ncontent\n")
  await Bun.$`mkdir -p ${workspace}`
  await Bun.$`ln -s ${outside} ${workspace}/link.ts`

  await expect(resolveWorkspaceFile(workspace, { path: "link.ts" })).rejects.toThrow("outside the workspace")
  await expect(countAddedLinesFromFile(workspace, "link.ts")).rejects.toThrow("outside the workspace")
})

test("loads counts from a repository without HEAD and streams untracked text counts", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-unborn-head-${crypto.randomUUID()}`
  workspaces.push(workspace)
  await Bun.$`git init -q ${workspace}`
  await Bun.write(`${workspace}/staged.ts`, "one\ntwo\nthree\n")
  await Bun.write(`${workspace}/untracked.ts`, "one\ntwo")
  await Bun.$`git -C ${workspace} add staged.ts`

  expect(await readChangedFiles(workspace)).toEqual([
    { path: "staged.ts", status: "A", added: 3, removed: 0 },
    { path: "untracked.ts", status: "??", added: 2, removed: 0 },
  ])
})

test("parses the exact NUL-delimited output from a real Git repository", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-changed-files-${crypto.randomUUID()}`
  workspaces.push(workspace)
  await Bun.$`git init -q ${workspace}`
  await Bun.$`git -C ${workspace} config user.email test@example.com`
  await Bun.$`git -C ${workspace} config user.name Test`
  await Bun.write(`${workspace}/old name.ts`, "one\ntwo\nthree\n")
  await Bun.$`git -C ${workspace} add .`
  await Bun.$`git -C ${workspace} commit -qm initial`
  await Bun.$`mkdir -p ${workspace}/docs/nested ${workspace}/untracked/deep`
  await Bun.$`git -C ${workspace} mv ${workspace}/old\ name.ts ${workspace}/docs/nested/new\ -\>\ name.ts`
  await Bun.write(`${workspace}/untracked/deep/file with spaces.ts`, "new")
  const status = await Bun.$`git -C ${workspace} status --porcelain=v1 -z --untracked-files=all`.arrayBuffer()
  const numstat = await Bun.$`git -C ${workspace} diff --numstat -z -M HEAD`.arrayBuffer()

  expect(parseChangedFiles(new TextDecoder().decode(status), new TextDecoder().decode(numstat))).toEqual([
    { path: "docs/nested/new -> name.ts", status: "R", added: 0, removed: 0 },
    { path: "untracked/deep/file with spaces.ts", status: "??" },
  ])
})

test("extracts a clipboard image in a fresh workspace with the path passed outside AppleScript", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika clipboard-'-${crypto.randomUUID()}`
  workspaces.push(workspace)
  let receivedScript = ""
  let receivedPath = ""
  const relative = await Effect.runPromise(
    pasteClipboardPng(
      workspace,
      () => 42,
      async (script, path) => {
        receivedScript = script
        receivedPath = path
        await Bun.write(path, Uint8Array.from([1, 2, 3]))
        return 0
      },
    ),
  )
  expect(relative).toBe(".rika/pasted/paste-42.png")
  expect(receivedPath).toBe(`${workspace}/${relative}`)
  expect(receivedScript).toContain("POSIX file (item 1 of argv)")
  expect(receivedScript).not.toContain(workspace)
  expect(await Bun.file(receivedPath).exists()).toBe(true)
})

test("persists terminal image paste bytes with their media type", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-pasted-image-${crypto.randomUUID()}`
  workspaces.push(workspace)
  const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const relative = pastedImagePath(
    bytes,
    "IMAGE/WEBP",
    () => 42,
    () => "one",
  )
  expect(relative).toBe(".rika/pasted/paste-42-one.webp")
  if (relative === undefined) throw new Error("expected a WebP path")
  const persisted = await Effect.runPromise(persistPastedImage(workspace, relative, bytes))
  expect(persisted).toBe(true)
  expect(await Bun.file(`${workspace}/${relative}`).bytes()).toEqual(bytes)
})

test("rejects unsupported, unrecognized, and mismatched terminal image bytes", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(
    pastedImagePath(
      png,
      "image/png",
      () => 1,
      () => "png",
    ),
  ).toBe(".rika/pasted/paste-1-png.png")
  expect(pastedImagePath(png, "image/jpeg")).toBeUndefined()
  expect(pastedImagePath(Uint8Array.from([1, 2, 3]), "image/png")).toBeUndefined()
  expect(pastedImagePath(new TextEncoder().encode("<svg/>"), "image/svg+xml")).toBeUndefined()
})

test.each([
  ["failed", 1, Uint8Array.from([1])],
  ["empty", 0, new Uint8Array()],
])("removes %s clipboard extraction output", async (_name, exit, output) => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-clipboard-${crypto.randomUUID()}`
  workspaces.push(workspace)
  const absolute = `${workspace}/.rika/pasted/paste-7.png`
  const relative = await Effect.runPromise(
    pasteClipboardPng(
      workspace,
      () => 7,
      async (_script, path) => {
        await Bun.write(path, output)
        return exit
      },
    ),
  )
  expect(relative).toBeUndefined()
  expect(await Bun.file(absolute).exists()).toBe(false)
})

test("removes clipboard output when extraction throws", async () => {
  const workspace = `${process.env.TMPDIR ?? "/tmp"}/rika-clipboard-${crypto.randomUUID()}`
  workspaces.push(workspace)
  const absolute = `${workspace}/.rika/pasted/paste-9.png`
  const relative = await Effect.runPromise(
    pasteClipboardPng(
      workspace,
      () => 9,
      async () => {
        throw new Error("unavailable")
      },
    ),
  )
  expect(relative).toBeUndefined()
  expect(await Bun.file(absolute).exists()).toBe(false)
})
