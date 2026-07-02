import { TournamentService } from "@rika/agent"

export const formatResult = (result: TournamentService.TournamentResult) =>
  [
    "Rank\tThread\tMode\tScore\tStrengths",
    ...result.ranking.map((row) =>
      [row.rank, row.thread_id, row.mode, row.median_score, oneLine(row.strengths)].join("\t"),
    ),
    `Winner\t${result.winner_thread_id}`,
    `Continue\trika --thread ${result.winner_thread_id}`,
  ].join("\n")

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()
