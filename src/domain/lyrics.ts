import type { PracticeLine, Syllable } from "@/domain/types"

/**
 * How much of each syllable has been sung at `time` seconds into the take:
 * 0 before it starts, 1 once it ends, and the fraction in between. Drives the
 * colour sweep, so sung syllables stay lit and upcoming ones stay dim.
 */
export function syllableFill(syllables: Syllable[], time: number): number[] {
  return syllables.map(({ start, end }) => {
    if (time <= start) return 0
    if (time >= end) return 1
    return (time - start) / (end - start)
  })
}

export type BallPosition = {
  // Fractional syllable index: 2 sits on the third syllable, 2.5 is halfway
  // to the fourth.
  slot: number
  // Height of the hop, 0 (touching the syllable) to 1 (top of the arc).
  lift: number
}

/**
 * Where the bouncing ball is at `time` seconds into the take. It lands on
 * each syllable at the moment that syllable starts, so it hops on the
 * melody's beat, and rests on the last syllable once it's reached.
 */
export function bouncingBall(
  syllables: Syllable[],
  time: number,
): BallPosition {
  const last = syllables.length - 1
  if (last < 0 || time <= syllables[0].start) return { slot: 0, lift: 0 }
  for (let i = 0; i < last; i += 1) {
    const from = syllables[i].start
    const to = syllables[i + 1].start
    if (time < to) {
      const progress = to > from ? (time - from) / (to - from) : 1
      return { slot: i + progress, lift: 4 * progress * (1 - progress) }
    }
  }
  return { slot: last, lift: 0 }
}

const ZERO_WIDTH_JOINER = "\u200d"
// Harakat, tanween, sukun and the dagger alif: marks that sit on a letter and
// don't affect how it joins.
const ARABIC_MARKS = /[\u064b-\u065f\u0670]/g
const ARABIC_LETTER = /[\u0620-\u064a]/
// Letters that join to the letter before them but never to the one after.
const JOINS_BACKWARD_ONLY = new Set([..."ءآأؤإاةدذرزو"])

function joinsForward(text: string): boolean {
  const letters = text.replace(ARABIC_MARKS, "")
  const last = letters.charAt(letters.length - 1)
  return ARABIC_LETTER.test(last) && !JOINS_BACKWARD_ONLY.has(last)
}

function startsWithArabicLetter(text: string): boolean {
  return ARABIC_LETTER.test(text.replace(ARABIC_MARKS, "").charAt(0))
}

/**
 * Syllable texts ready to render one per chip. Arabic letters change shape
 * depending on their neighbours, so a syllable cut out of a word (مِي from
 * مِيلادٍ) would show isolated forms. A zero-width joiner on each side of a cut
 * that falls between two joining letters keeps the connected shapes. Other
 * scripts pass through unchanged.
 */
export function syllableDisplayTexts(line: PracticeLine): string[] {
  const texts = line.syllables.map((s) => s.text)
  let cursor = 0
  for (let i = 0; i < texts.length - 1; i += 1) {
    cursor += line.syllables[i].text.length
    const sameWord = cursor < line.text.length && !/\s/.test(line.text[cursor])
    while (cursor < line.text.length && /\s/.test(line.text[cursor]))
      cursor += 1
    const next = line.syllables[i + 1].text
    if (
      sameWord &&
      joinsForward(line.syllables[i].text) &&
      startsWithArabicLetter(next)
    ) {
      texts[i] += ZERO_WIDTH_JOINER
      texts[i + 1] = ZERO_WIDTH_JOINER + texts[i + 1]
    }
  }
  return texts
}
