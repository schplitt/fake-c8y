/**
 * The inventory's `text=` search: the Snowball English stemmer against
 * reference output, and the cheap first check it relies on.
 */
import { expect, it } from 'vitest'
import { stemEnglish, stemProbe } from '../../src/api/text-search'

// from the Snowball English vocabulary and its reference output
const REFERENCE: Record<string, string> = {
  consign: 'consign',
  consigned: 'consign',
  consigning: 'consign',
  consignment: 'consign',
  consist: 'consist',
  consisted: 'consist',
  consistency: 'consist',
  consistent: 'consist',
  consistently: 'consist',
  consisting: 'consist',
  consists: 'consist',
  consolation: 'consol',
  consolations: 'consol',
  consolatory: 'consolatori',
  console: 'consol',
  consoled: 'consol',
  consoles: 'consol',
  consolidate: 'consolid',
  consolidated: 'consolid',
  consolidating: 'consolid',
  consoling: 'consol',
  consolingly: 'consol',
  consols: 'consol',
  consonant: 'conson',
  consort: 'consort',
  consorted: 'consort',
  consorting: 'consort',
  conspicuous: 'conspicu',
  conspicuously: 'conspicu',
  conspiracy: 'conspiraci',
  conspirator: 'conspir',
  conspirators: 'conspir',
  conspire: 'conspir',
  conspired: 'conspir',
  conspiring: 'conspir',
  constable: 'constabl',
  constables: 'constabl',
  constance: 'constanc',
  constancy: 'constanc',
  constant: 'constant',
  knack: 'knack',
  knackeries: 'knackeri',
  knacks: 'knack',
  knag: 'knag',
  knave: 'knave',
  knaves: 'knave',
  knavish: 'knavish',
  kneaded: 'knead',
  kneading: 'knead',
  knee: 'knee',
  kneel: 'kneel',
  kneeled: 'kneel',
  kneeling: 'kneel',
  kneels: 'kneel',
  knees: 'knee',
  knell: 'knell',
  knelt: 'knelt',
  knew: 'knew',
  knife: 'knife',
  knight: 'knight',
  knightly: 'knight',
  knights: 'knight',
  knit: 'knit',
  knits: 'knit',
  knitted: 'knit',
  knitting: 'knit',
  knives: 'knive',
  knob: 'knob',
  knobs: 'knob',
  knock: 'knock',
  knocked: 'knock',
  knocker: 'knocker',
  knockers: 'knocker',
  knocking: 'knock',
  knocks: 'knock',
  generate: 'generat',
  generously: 'generous',
  communication: 'communic',
  skies: 'sky',
  dying: 'die',
  happy: 'happi',
  cries: 'cri',
  ties: 'tie',
  ability: 'abil',
  hopefulness: 'hope',
  machining: 'machin',
  machine: 'machin',
  purging: 'purg',
  purged: 'purg',
  approvals: 'approv',
  werke: 'werk',
  filters: 'filter',
  cmms: 'cmms',
  sensors: 'sensor',
  pumps: 'pump',
  compressors: 'compressor',
  running: 'run',
  devices: 'devic',
  temperature: 'temperatur',
  gateways: 'gateway',
  meters: 'meter',
  vibration: 'vibrat',
  critical: 'critic',
  active: 'activ',
}

it('stems like the Snowball English stemmer', () => {
  for (const [word, stem] of Object.entries(REFERENCE)) {
    expect(stemEnglish(word), word).toBe(stem)
  }
})

it('finds every stem\'s probe in the word', () => {
  for (const word of Object.keys(REFERENCE)) {
    expect(word.includes(stemProbe(stemEnglish(word))), word).toBe(true)
  }
})

it('finds the probe also in generated words with every suffix the stemmer rewrites', () => {
  const bases = ['happ', 'gener', 'ab', 'condit', 'nat', 'flu', 'rel', 'x', 'spr', 'organ', 'commun', 'arsen', 'tr', 'b']
  const suffixes = ['', 'y', 'ies', 'ied', 'ing', 'ingly', 'ed', 'edly', 'eed', 'eedly', 's', 'ly', 'ational', 'tional', 'enci', 'anci', 'abli', 'entli', 'izer', 'ization', 'ation', 'ator', 'alism', 'aliti', 'alli', 'fulness', 'ousli', 'ousness', 'iveness', 'iviti', 'biliti', 'bli', 'logi', 'fulli', 'lessli', 'cli', 'alize', 'icate', 'iciti', 'ical', 'ful', 'ness', 'ative', 'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'sion', 'tion', 'e', 'll', 'ency', 'ably', 'ibly', 'bility', 'ality', 'ously', 'ively', 'ingness']
  for (const base of bases) {
    for (const suffix of suffixes) {
      for (const extra of ['', 's', 'ly', 'ing', 'ed']) {
        const word = `${base}${suffix}${extra}`
        expect(word.includes(stemProbe(stemEnglish(word))), word).toBe(true)
      }
    }
  }
})
