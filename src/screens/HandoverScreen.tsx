import { PLAYER_COLORS, type MatchState, displayName } from "@/domain/match"
import SongTag, { SongTitle } from "@/screens/SongTag"

export default function HandoverScreen({
  state,
  onContinue,
}: {
  state: MatchState
  onContinue: () => void
}) {
  const next = state.currentPlayer
  const previous = next === 0 ? 1 : 0
  const multiRound = state.rounds > 1

  return (
    <main className="screen handover-screen">
      <section className="handover-content">
        <p className="player-chip" style={{ color: PLAYER_COLORS[next] }}>
          <i
            className="player-swatch"
            style={{ background: PLAYER_COLORS[next] }}
          />
          {multiRound ? `Round ${state.round}` : "Your turn"}
        </p>
        <SongTag song={state.song} />
        <h1>Pass the mic to {displayName(state, next)}</h1>
        <p className="handover-copy">
          {displayName(state, previous)} just sang{" "}
          {multiRound && <>line {state.round} of </>}
          <SongTitle song={state.song} />. Keep that score hidden until both of
          you have sung.
        </p>
        <button type="button" onClick={onContinue}>
          {displayName(state, next)} is ready
        </button>
      </section>
    </main>
  )
}
