import { FileTree, type FileTreeOptions, type GitStatusEntry } from "@pierre/trees"

export interface PierreTreeInput {
  readonly paths: ReadonlyArray<string>
  readonly selected_path?: string
  readonly git_status?: ReadonlyArray<GitStatusEntry>
}

export interface PierreTreeMountInput extends PierreTreeInput {
  readonly container: HTMLElement
  readonly onSelectedPath: (path: string) => void
}

export interface PierreTreeHandle {
  readonly update: (input: PierreTreeInput) => void
  readonly focus: (path: string) => void
  readonly destroy: () => void
}

export const mountPierreTree = (input: PierreTreeMountInput): PierreTreeHandle => {
  let suppressSelection = false
  const options: FileTreeOptions = {
    paths: input.paths,
    initialExpansion: "open",
    search: true,
    initialSelectedPaths: input.selected_path === undefined ? [] : [input.selected_path],
    onSelectionChange: (selectedPaths) => {
      if (suppressSelection) return
      const path = selectedPaths[selectedPaths.length - 1]
      if (path === undefined) return
      input.onSelectedPath(path)
    },
    ...(input.git_status === undefined ? {} : { gitStatus: input.git_status }),
  }
  const tree = new FileTree(options)
  tree.render({ containerWrapper: input.container })
  return {
    update: (next) => {
      suppressSelection = true
      try {
        tree.resetPaths(next.paths)
        tree.setGitStatus(next.git_status)
        for (const path of tree.getSelectedPaths()) tree.getItem(path)?.deselect()
        if (next.selected_path !== undefined) tree.getItem(next.selected_path)?.select()
      } finally {
        suppressSelection = false
      }
      tree.render({ containerWrapper: input.container })
    },
    focus: (path) => tree.scrollToPath(path, { focus: true }),
    destroy: () => {
      try {
        tree.cleanUp()
      } finally {
        input.container.replaceChildren()
      }
    },
  }
}
