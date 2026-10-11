// No Words number until the /ml probe passes; never fill this with a stand-in score.
export default function WordsComingSoon() {
  return (
    <div className="score-slot pending" aria-label="Words — coming soon">
      <small>Words</small>
      <span>coming soon</span>
    </div>
  )
}
