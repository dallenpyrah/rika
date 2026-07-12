import { Path } from "effect"

const mention = /(?:^|\s)@((?:"[^"]+")|(?:'[^']+')|[^\s,;]+)/g

export const parse = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(mention)]
    .map((match) => match[1] ?? "")
    .map((value) => value.replace(/^(["'])|(["'])$/g, ""))
    .filter(Boolean)

export const resolve = (workspace: string, text: string, path: Path.Path): ReadonlyArray<string> =>
  [...new Set(parse(text).map((value) => path.resolve(workspace, value)))].toSorted()
