export interface Key {
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly sequence: string
}

export interface OpenTuiKey {
  readonly name: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly shift?: boolean
  readonly sequence?: string
}

export const make = (input: {
  readonly name: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly sequence?: string
}): Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
})

export const fromOpenTui = (key: OpenTuiKey): Key => ({
  name: key.name,
  ctrl: key.ctrl === true,
  alt: key.meta === true || key.option === true,
  shift: key.shift === true,
  sequence: key.sequence ?? "",
})

export const isPrintable = (key: Key): boolean => {
  if (key.ctrl || key.alt) return false
  if (key.name === "space") return true
  if (key.sequence.length !== 1) return false
  const code = key.sequence.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f
}

export const char = (key: Key): string => (key.name === "space" ? " " : key.sequence)

export const fromString = (text: string): ReadonlyArray<Key> =>
  Array.from(text).map((character) =>
    character === " "
      ? make({ name: "space", sequence: " " })
      : make({ name: character, sequence: character }),
  )

export const enter = make({ name: "return", sequence: "\r" })
export const escape = make({ name: "escape", sequence: "" })
export const backspace = make({ name: "backspace", sequence: "" })
export const ctrl = (name: string): Key => make({ name, ctrl: true })
export const alt = (name: string): Key => make({ name, alt: true })
