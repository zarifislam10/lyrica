import { PLAYER_COLORS, type MatchState, displayName } from "@/domain/match"

export default function HandoverScreen({
  state,
  onContinue,
}: {
  state: MatchState
  onContinue: () => void
}) {
  const next = state.currentPlayer
  const previous = next === 0 ? 1 : 0

  return (
    <main className="screen handover-screen">
      <section className="handover-content">
        <p
          className="player-chip"
          style={{ color: PLAYER_COLORS[next] }}
        >
          <i
            className="player-swatch"
            style={{ background: PLAYER_COLORS[next] }}
          />
          Round {state.round}
        </p>
        <h1>Pass the phone to {displayName(state, next)}</h1>
        <p className="handover-copy">
          {displayName(state, previous)} is done. Keep that score hidden until
          both of you have sung.
        </p>
        <button type="button" onClick={onContinue}>
          {displayName(state, next)} is ready
        </button>
      </section>
    </main>
  )
}
