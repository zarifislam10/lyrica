import { PLAYER_COLORS, type MatchState, displayName } from "@/domain/match"

export default function FinalScreen({
  state,
  onRematch,
  onHome,
}: {
  state: MatchState
  onRematch: () => void
  onHome: () => void
}) {
  const winner: 0 | 1 = state.roundWins[0] >= state.roundWins[1] ? 0 : 1

  return (
    <main className="screen final-screen">
      <section className="final-content">
        <p className="player-chip" style={{ color: PLAYER_COLORS[winner] }}>
          Winner
        </p>
        <h1>{displayName(state, winner)}</h1>
        <div className="scoreboard-row">
          <span style={{ color: PLAYER_COLORS[0] }}>
            {displayName(state, 0)}
          </span>
          <span>
            {state.roundWins[0]} – {state.roundWins[1]}
          </span>
          <span style={{ color: PLAYER_COLORS[1] }}>
            {displayName(state, 1)}
          </span>
        </div>
        <div className="final-actions">
          <button className="primary-button" type="button" onClick={onRematch}>
            Rematch
          </button>
          <button className="secondary-button" type="button" onClick={onHome}>
            Home
          </button>
        </div>
      </section>
    </main>
  )
}
