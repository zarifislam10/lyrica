import {
  PLAYER_COLORS,
  type MatchState,
  displayName,
  soloTotal,
} from "@/domain/match"
import WordsComingSoon from "@/screens/WordsComingSoon"

function SoloFinal({ state }: { state: MatchState }) {
  return (
    <>
      <p className="player-chip" style={{ color: PLAYER_COLORS[0] }}>
        {displayName(state, 0)}
      </p>
      <div className="score-slots final-score-slots">
        <div className="score-slot">
          <small>Tune</small>
          <strong>{soloTotal(state)}</strong>
        </div>
        <WordsComingSoon />
      </div>
      <div className="solo-rounds">
        {state.soloScores.map((score, index) => (
          <span key={index}>
            Round {index + 1}
            <b>{score}</b>
          </span>
        ))}
      </div>
    </>
  )
}

function BattleFinal({ state }: { state: MatchState }) {
  const winner: 0 | 1 = state.roundWins[0] >= state.roundWins[1] ? 0 : 1

  return (
    <>
      <p className="player-chip" style={{ color: PLAYER_COLORS[winner] }}>
        Winner
      </p>
      <h1>{displayName(state, winner)}</h1>
      <div className="scoreboard-row">
        <span style={{ color: PLAYER_COLORS[0] }}>{displayName(state, 0)}</span>
        <span>
          {state.roundWins[0]} – {state.roundWins[1]}
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
