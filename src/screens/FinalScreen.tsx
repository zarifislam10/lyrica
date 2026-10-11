import {
  PLAYER_COLORS,
  ROUNDS_PER_MATCH,
  type MatchState,
  displayName,
  soloTotal,
} from "@/domain/match"
import WordsCard from "@/components/WordsCard"
import SongTag from "@/screens/SongTag"

function SoloFinal({ state }: { state: MatchState }) {
  return (
    <>
      <p className="player-chip" style={{ color: PLAYER_COLORS[0] }}>
        {displayName(state, 0)}
      </p>
      {/* Final-screen Words bar is intentionally wav={null} — per-round
       takes aren't aggregated, so we show the Tune total alongside an
       honest "Unavailable" word score rather than inventing a number. */}
      <WordsCard
        tune={soloTotal(state)}
        wav={null}
        songId={state.song.id}
        lineId={0}
      />
      {state.soloScores.length > 1 && (
        <div className="solo-rounds">
          {state.soloScores.map((score, index) => (
            <span key={index}>
              Round {index + 1}
              <b>{score}</b>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

function BattleFinal({ state }: { state: MatchState }) {
  const winner: 0 | 1 = state.roundWins[0] >= state.roundWins[1] ? 0 : 1
  // One round: "1 – 0" says nothing, so show the Tune scores instead.
  const tally =
    ROUNDS_PER_MATCH === 1
      ? [state.turnScores[0] ?? 0, state.turnScores[1] ?? 0]
      : state.roundWins

  return (
    <>
      <p className="player-chip" style={{ color: PLAYER_COLORS[winner] }}>
        Winner
      </p>
      <h1>{displayName(state, winner)}</h1>
      <div className="scoreboard-row">
        <span style={{ color: PLAYER_COLORS[0] }}>{displayName(state, 0)}</span>
        <span>
          {tally[0]} – {tally[1]}
        </span>
        <span style={{ color: PLAYER_COLORS[1] }}>{displayName(state, 1)}</span>
      </div>
    </>
  )
}

export default function FinalScreen({
  state,
  onRematch,
  onHome,
}: {
  state: MatchState
  onRematch: () => void
  onHome: () => void
}) {
  const solo = state.mode === "solo"

  return (
    <main className="screen final-screen">
      <section className="final-content">
        <SongTag song={state.song} />
        {solo ? <SoloFinal state={state} /> : <BattleFinal state={state} />}
        <div className="final-actions">
          <button className="primary-button" type="button" onClick={onRematch}>
            {solo ? "Sing again" : "Rematch"}
          </button>
          <button className="secondary-button" type="button" onClick={onHome}>
            Home
          </button>
        </div>
      </section>
    </main>
  )
}
