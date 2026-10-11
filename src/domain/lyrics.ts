import type { PracticeLine } from "@/domain/types"

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
