/**
 * The inventory's `text=` search, a full-text search (verified on a real
 * tenant): words are separated by anything but
 * letters, digits, and `_`, compared without case and diacritics (`gdansk`
 * finds `Gdańsk`), English stop words are left out, and the rest is stemmed
 * with the Snowball (Porter2) English stemmer (`purging` finds `Purge`,
 * `approvals` finds `Approval`), so parts of words find nothing. `"..."` is a
 * phrase (every phrase must occur in one field, as text), `-word` and
 * `-"..."` exclude. A document matches if it has any of the other words
 * (phrase words count) and every phrase, and none of the excluded ones; a
 * search without such words finds nothing.
 */

/**
 * The parsed search value; build it once per request.
 */
export interface TextSearch {
  /**
   * Stems by word and the stemmed words of each field value seen so far (the
   * same types, owners, and external id types come again and again).
   */
  stems: Map<string, string>
  fieldTerms: Map<string, string[]>
  terms: Set<string>
  /**
   * Per term, a text every word with that stem contains (a cheap first check).
   */
  probes: string[]
  excluded: Set<string>
  phrases: string[]
  excludedPhrases: string[]
}

// English stop words (the apostrophe forms split into these words)
const STOP_WORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can cannot could '
  + 'did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself let me '
  + 'more most my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them '
  + 'themselves then there these they this those through to too under until up very was we were what when where which while who whom why with would you your yours '
  + 'yourself yourselves').split(' '))

/**
 * Lower case without diacritics (`ń` becomes `n`, `ß` stays).
 * @param value - Text
 */
export function foldText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(value) ? value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() : value.toLowerCase()
}

/**
 * The stemmed words of a text, stop words left out.
 * @param value - Text
 * @param stems - Stems by word, shared by the calls of one request
 * @param folded - The value already folded (`foldText()`)
 */
export function textTerms(value: string, stems: Map<string, string>, folded: string = foldText(value)): string[] {
  const terms: string[] = []
  // eslint-disable-next-line no-control-regex
  for (const word of folded.split(/[^\x00-\x7F]/.test(folded) ? /[^\p{L}\p{N}_]+/u : /[^a-z0-9_]+/)) {
    if (word === '' || STOP_WORDS.has(word)) {
      continue
    }
    // the stemmer leaves words without vowels (numbers, ids) alone
    if (!/[aeiouy]/.test(word)) {
      terms.push(word)
      continue
    }
    let stem = stems.get(word)
    if (stem === undefined) {
      stem = stemEnglish(word)
      stems.set(word, stem)
    }
    terms.push(stem)
  }
  return terms
}

/**
 * Parses a `text=` value.
 * @param text - The search value
 */
export function parseTextSearch(text: string): TextSearch {
  const stems = new Map<string, string>()
  const search: TextSearch = { stems, fieldTerms: new Map(), terms: new Set(), probes: [], excluded: new Set(), phrases: [], excludedPhrases: [] }
  // phrases first, then the words around them; `-` negates at the start of a word
  const rest = text.replace(/(^|\s)(-?)"([^"]*)"?/g, (_match, before: string, minus: string, phrase: string) => {
    const words = textTerms(phrase, stems)
    if (minus) {
      search.excludedPhrases.push(foldText(phrase))
    } else {
      search.phrases.push(foldText(phrase))
      for (const word of words) {
        search.terms.add(word)
      }
    }
    return `${before} `
  })
  for (const word of rest.split(/\s+/)) {
    const excluded = word.startsWith('-')
    for (const term of textTerms(excluded ? word.slice(1) : word, stems)) {
      (excluded ? search.excluded : search.terms).add(term)
    }
  }
  search.probes = [...search.terms].map(stemProbe)
  return search
}

/**
 * Whether the searched fields of a document match a search.
 * @param search - The parsed search
 * @param fields - The searched field values
 */
export function matchesText(search: TextSearch, fields: string[]): boolean {
  if (search.terms.size === 0) {
    return false
  }
  const folded = fields.map(foldText)
  const joined = folded.join('\n')
  if (!search.probes.some((probe) => joined.includes(probe))) {
    return false
  }
  let found = false
  for (const field of folded) {
    let terms = search.fieldTerms.get(field)
    if (terms === undefined) {
      terms = textTerms(field, search.stems, field)
      // names and external ids are mostly unique: keep only short lists
      if (search.fieldTerms.size < 10000) {
        search.fieldTerms.set(field, terms)
      }
    }
    for (const term of terms) {
      if (search.excluded.has(term)) {
        return false
      }
      found ||= search.terms.has(term)
    }
  }
  if (!found) {
    return false
  }
  if (search.phrases.length === 0 && search.excludedPhrases.length === 0) {
    return true
  }
  return search.phrases.every((phrase) => folded.some((field) => field.includes(phrase)))
    && !search.excludedPhrases.some((phrase) => folded.some((field) => field.includes(phrase)))
}

const VOWELS = 'aeiouy'
const DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt']
const LI_ENDINGS = 'cdeghkmnrt'
const EXCEPTIONS: Record<string, string> = {
  skis: 'ski',
  skies: 'sky',
  dying: 'die',
  lying: 'lie',
  tying: 'tie',
  idly: 'idl',
  gently: 'gentl',
  ugly: 'ugli',
  early: 'earli',
  only: 'onli',
  singly: 'singl',
  sky: 'sky',
  news: 'news',
  howe: 'howe',
  atlas: 'atlas',
  cosmos: 'cosmos',
  bias: 'bias',
  andes: 'andes',
}
const AFTER_STEP_1A = new Set(['inning', 'outing', 'canning', 'herring', 'earring', 'proceed', 'exceed', 'succeed'])
const STEP_2: Array<[string, string]> = [
  ['ization', 'ize'],
  ['ational', 'ate'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['iveness', 'ive'],
  ['tional', 'tion'],
  ['biliti', 'ble'],
  ['lessli', 'less'],
  ['entli', 'ent'],
  ['ation', 'ate'],
  ['alism', 'al'],
  ['aliti', 'al'],
  ['ousli', 'ous'],
  ['iviti', 'ive'],
  ['fulli', 'ful'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['abli', 'able'],
  ['izer', 'ize'],
  ['ator', 'ate'],
  ['alli', 'al'],
  ['bli', 'ble'],
  ['ogi', 'og'],
  ['li', ''],
]
const STEP_3: Array<[string, string]> = [
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['alize', 'al'],
  ['icate', 'ic'],
  ['iciti', 'ic'],
  ['ative', ''],
  ['ical', 'ic'],
  ['ness', ''],
  ['ful', ''],
]
const STEP_4 = ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'ion', 'al', 'er', 'ic']

const isVowel = (char: string | undefined) => char !== undefined && VOWELS.includes(char)

/**
 * Start of the region after the first non-vowel that follows a vowel.
 * @param word - The word
 * @param from - Where to start looking
 */
function regionStart(word: string, from: number): number {
  for (let i = from + 1; i < word.length; i++) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      return i + 1
    }
  }
  return word.length
}

/**
 * Whether the word ends in a short syllable.
 * @param word - The word
 */
function endsShort(word: string): boolean {
  const n = word.length
  if (n === 2) {
    return isVowel(word[0]) && !isVowel(word[1])
  }
  return n > 2 && !isVowel(word[n - 3]) && isVowel(word[n - 2]) && !isVowel(word[n - 1]) && !'wxY'.includes(word[n - 1]!)
}

/**
 * The Snowball (Porter2) English stem of a lower-case word.
 * @param input - The word
 */
export function stemEnglish(input: string): string {
  if (input.length <= 2) {
    return input
  }
  if (Object.hasOwn(EXCEPTIONS, input)) {
    return EXCEPTIONS[input]!
  }
  let word = input.startsWith('\'') ? input.slice(1) : input
  word = word.replace(/^y/, 'Y').replace(/([aeiouy])y/g, '$1Y')
  const prefix = /^(?:gener|commun|arsen)/.exec(word)
  const r1 = prefix ? prefix[0].length : regionStart(word, 0)
  const r2 = regionStart(word, r1)
  const inR1 = (suffix: string) => word.length - suffix.length >= r1
  const inR2 = (suffix: string) => word.length - suffix.length >= r2
  const cut = (suffix: string) => word.slice(0, word.length - suffix.length)

  // step 0
  for (const suffix of ['\'s\'', '\'s', '\'']) {
    if (word.endsWith(suffix)) {
      word = cut(suffix)
      break
    }
  }
  // step 1a
  if (word.endsWith('sses')) {
    word = cut('es')
  } else if (word.endsWith('ied') || word.endsWith('ies')) {
    word = word.length > 4 ? cut('es') : cut('s')
  } else if (word.endsWith('us') || word.endsWith('ss')) {
    // unchanged
  } else if (word.endsWith('s') && /[aeiouy]/.test(word.slice(0, -2))) {
    word = cut('s')
  }
  if (AFTER_STEP_1A.has(word)) {
    return word
  }
  // step 1b
  const step1b = ['eedly', 'ingly', 'edly', 'eed', 'ing', 'ed'].find((suffix) => word.endsWith(suffix))
  if (step1b === 'eed' || step1b === 'eedly') {
    if (inR1(step1b)) {
      word = `${cut(step1b)}ee`
    }
  } else if (step1b !== undefined && /[aeiouy]/.test(cut(step1b))) {
    word = cut(step1b)
    if (/(?:at|bl|iz)$/.test(word)) {
      word += 'e'
    } else if (DOUBLES.some((double) => word.endsWith(double))) {
      word = word.slice(0, -1)
    } else if (r1 >= word.length && endsShort(word)) {
      word += 'e'
    }
  }
  // step 1c
  if (word.length > 2 && /[yY]$/.test(word) && !isVowel(word[word.length - 2])) {
    word = `${word.slice(0, -1)}i`
  }
  // step 2
  const step2 = STEP_2.find(([suffix]) => word.endsWith(suffix))
  if (step2 && inR1(step2[0])) {
    const [suffix, replacement] = step2
    if (suffix === 'ogi') {
      if (cut(suffix).endsWith('l')) {
        word = `${cut(suffix)}${replacement}`
      }
    } else if (suffix === 'li') {
      if (LI_ENDINGS.includes(cut(suffix).slice(-1))) {
        word = cut(suffix)
      }
    } else {
      word = `${cut(suffix)}${replacement}`
    }
  }
  // step 3
  const step3 = STEP_3.find(([suffix]) => word.endsWith(suffix))
  if (step3 && inR1(step3[0]) && (step3[0] !== 'ative' || inR2(step3[0]))) {
    word = `${cut(step3[0])}${step3[1]}`
  }
  // step 4
  const step4 = STEP_4.find((suffix) => word.endsWith(suffix))
  if (step4 && inR2(step4) && (step4 !== 'ion' || /[st]$/.test(cut(step4)))) {
    word = cut(step4)
  }
  // step 5
  if (word.endsWith('e')) {
    if (inR2('e') || (inR1('e') && !endsShort(cut('e')))) {
      word = cut('e')
    }
  } else if (word.endsWith('ll') && inR2('l')) {
    word = word.slice(0, -1)
  }
  return word.replaceAll('Y', 'y')
}

/**
 * A text every word with this stem contains: the stemmer only changes the
 * last two letters of what it keeps (`happy` becomes `happi`, `ability` `abil`),
 * apart from a few irregular words.
 * @param stem - A stem
 */
export function stemProbe(stem: string): string {
  if (Object.values(EXCEPTIONS).includes(stem)) {
    return stem.slice(0, 1)
  }
  return stem.length <= 2 ? stem : stem.slice(0, Math.max(2, stem.length - 2))
}
