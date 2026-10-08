/**
 * Locale tests: the review prompt, the memory snapshot, and the loop-aware
 * section follow the durable locale preference, and an unset preference is
 * byte-identical to upstream 0.1.16.
 *
 * The "byte-identical" assertions are the load-bearing ones. They are what
 * makes the change safe for a user who never touches Settings → Language:
 * they must get exactly the behaviour of the version this replaces.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = createRequire(import.meta.url)(join(root, 'src/index.js'))
const { __internals: I } = plugin

// The pristine copy of the version under test, used as the oracle. Its
// reviewPrompt is not exported, so the source is evaluated through a CommonJS
// require with one appended export line rather than re-deriving its behaviour
// from its text. `createRequire` keeps this CommonJS-safe even though this test
// file is an ES module.
//
// Resolved from node_modules so the oracle travels with the checkout instead of
// pointing at one developer's dsh profile: if the package is not installed the
// parity tests skip rather than silently passing against nothing.
const UPSTREAM = join(root, 'node_modules', '@weibaohui', 'hermes-loop', 'src', 'index.js')
const haveUpstream = existsSync(UPSTREAM)
const oracle = { skip: haveUpstream ? false : '@weibaohui/hermes-loop is not installed' }

function loadUpstream() {
  const source = readFileSync(UPSTREAM, 'utf8').replace(
    /\n\}\s*$/,
    '\n}\nmodule.exports.__internals.reviewPrompt = reviewPrompt\n',
  )
  const module_ = { exports: {} }
  new Function('module', 'exports', 'require', '__dirname', '__filename', source)(
    module_, module_.exports, createRequire(UPSTREAM), dirname(UPSTREAM), UPSTREAM,
  )
  return module_.exports.__internals
}

// Lazy, so a checkout without the oracle skips instead of failing at import.
let U
function upstream() {
  return (U ??= loadUpstream())
}

/**
 * The zh value upstream actually ships at the site that uses it.
 *
 * Upstream keeps most of these strings inside `runReview`, which it does not
 * export, so they cannot be obtained by calling an upstream function. Asserting
 * them as plain substrings of upstream's source is not enough: the source is
 * ~100 KB of Chinese, so a wrong one-character value ("字" instead of "条",
 * "个", "·") is a substring too, and the check passes on a wrong value. This
 * reads the enclosing string literal out of upstream's own text, so the
 * expected value comes from the version under test rather than from here.
 */
function upstreamLiteral(anchor, what) {
  const source = readFileSync(UPSTREAM, 'utf8')
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `upstream no longer contains ${JSON.stringify(anchor)} (${what})`)
  // Walk back to the opening quote of the literal containing `at`: scan for the
  // nearest quote that starts a string, which is the first one not preceded by a
  // backslash. lastIndexOf alone can land on a previous literal's closing quote.
  let open = source.lastIndexOf("'", at)
  while (open > 0 && source[open - 1] === '\\') open = source.lastIndexOf("'", open - 1)
  // The closing quote needs the same skip: an escaped apostrophe inside the
  // literal (as in "don't") is not a terminator.
  let close = source.indexOf("'", at)
  while (close > 0 && source[close - 1] === '\\') close = source.indexOf("'", close + 1)
  assert.notEqual(close, -1, `unterminated literal for ${what}`)
  return source.slice(open + 1, close).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n')
}

/** A settings service stub whose `locale` descriptor carries `value.preference`. */
function settingsWith(preference, { present = true } = {}) {
  return {
    settings: {
      describe: () => (present
        ? [{ ns: 'locale', value: preference === undefined ? {} : { preference } }]
        : []),
    },
  }
}

test('languageOf collapses locale ids onto the two carried languages', () => {
  assert.equal(I.languageOf('en'), 'en')
  assert.equal(I.languageOf('EN'), 'en')
  assert.equal(I.languageOf('en-US'), 'en')
  assert.equal(I.languageOf('en-GB-oxendict'), 'en')
  assert.equal(I.languageOf('zh'), 'zh')
  assert.equal(I.languageOf('zh-CN'), 'zh')
  assert.equal(I.languageOf(undefined), 'zh')
  assert.equal(I.languageOf(''), 'zh')
})

test('readLocalePreference distinguishes unset from unreadable', () => {
  // An explicit choice, seen.
  assert.deepEqual(I.readLocalePreference(settingsWith('en')), { value: 'en', seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith('zh-CN')), { value: 'zh-cn', seen: true })

  // A readable document with no preference is "seen, unset" — NOT an error.
  assert.deepEqual(I.readLocalePreference(settingsWith(undefined)), { value: undefined, seen: true })

  // Values the client would not treat as a locale are ignored, not trusted.
  assert.deepEqual(I.readLocalePreference(settingsWith('e n')), { value: undefined, seen: true })
  assert.deepEqual(I.readLocalePreference(settingsWith(42)), { value: undefined, seen: true })

  // No document at all: the settings entry has not mounted yet.
  assert.deepEqual(I.readLocalePreference(settingsWith('en', { present: false })), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({}), { value: undefined, seen: false })
  assert.deepEqual(I.readLocalePreference({ settings: { describe () { throw new Error('boom') } } }), { value: undefined, seen: false })
})

/**
 * The loop-aware section upstream assembles, read back out of its source.
 *
 * Upstream inlines this array inside `apply`, so there is no exported function
 * to call. Parsing the literal out of upstream's own text is still a real check:
 * it compares this array against the one that version ships, element by
 * element, rather than merely confirming that each line appears somewhere.
 */
function upstreamLoopAware() {
  const source = readFileSync(UPSTREAM, 'utf8')
  const at = source.indexOf("text: [\n            '# 收尾沉淀")
  assert.notEqual(at, -1, 'upstream no longer registers the loop-aware section as an inline array')
  const body = source.slice(at + 'text: ['.length, source.indexOf("].join('\\n')", at))
  return [...body.matchAll(/^\s*'((?:[^'\\]|\\.)*)',?\s*$/gm)].map((m) => m[1].replace(/\\(['"\\])/g, '$1'))
}

test('the default language is upstream 0.1.16, verified by running upstream', oracle, () => {
  // The load-bearing assertion: with no preference recorded, this change must
  // produce what the package it replaces produced. Comparing against upstream's
  // own function catches any drift in the zh branch itself.
  //
  // The zh branch is deliberately NOT byte-identical any more. It carries one
  // added line, the output-language directive, because a review whose protocol
  // was Chinese still wrote a Chinese skill for a user whose preference is `en`:
  // the protocol's language does not pin the artifact's language, so the zh
  // default needs the same explicit instruction the en branch has. Stripping
  // exactly that line before comparing keeps the assertion as strong as it was:
  // every other character is still required to match upstream exactly, so any
  // real drift still fails here.
  const stripDirective = (text) => {
    const line = '\n' + I.REVIEW_LANGUAGE_DIRECTIVE.zh
    assert.ok(text.endsWith(line), 'the zh prompt must end with the output-language directive')
    return text.slice(0, -line.length)
  }
  // §13 (v0.6) adds two more deliberate lines to the zh branch whenever the
  // memory channel is on: the two-layer routing bullet in the Memory section
  // and the "scope" example line in the conclusion schema. Same discipline as
  // the directive strip: pin the exact additions by pulling them out of the
  // current zh array (so they exist and are singular), remove exactly those
  // lines, and leave every other character under the upstream comparison.
  const zhNow = I.REVIEW_PROMPT_TEXT.zh(true)
  const scopeLineOf = (lines) => lines.filter((l) => l.includes('"scope": "project" | "global",'))
  const bulletLineOf = (lines) => lines.filter((l) => l.startsWith('- store="memory" 分两层'))
  assert.equal(scopeLineOf(zhNow).length, 1, 'exactly one scope example line may exist in the zh prompt')
  assert.equal(bulletLineOf(zhNow).length, 1, 'exactly one two-layer bullet may exist in the zh prompt')
  const stripScopeLines = (text) =>
    text.split('\n').filter((l) => !scopeLineOf([l]).length && !bulletLineOf([l]).length).join('\n')
  for (const eff of [
    { memoryEnabled: true, userProfileEnabled: true },
    { memoryEnabled: true, userProfileEnabled: false },
    { memoryEnabled: false, userProfileEnabled: true },
    { memoryEnabled: false, userProfileEnabled: false },
    {},
  ]) {
    assert.equal(
      stripDirective(stripScopeLines(I.reviewPrompt(eff))),
      upstream().reviewPrompt(eff),
      `zh output drifted from upstream for ${JSON.stringify(eff)}`,
    )
    assert.equal(stripDirective(stripScopeLines(I.reviewPrompt(eff, 'zh'))), upstream().reviewPrompt(eff))
  }

  // The memory snapshot is injected into every session rather than only into the
  // review agent, so parity is checked over every branch renderMemoryContext has:
  // both stores, one store, an enabled-but-empty store, both empty, and the
  // char limits omitted (which falls through to the store defaults).
  const limits = { memoryCharLimit: 2200, userCharLimit: 1375 }
  const bothEntries = (store) => (store === 'user' ? '§ 偏好：直接给答案' : '§ 端口是 3080')
  const cases = [
    ['both stores, one entry each', { ...limits, memoryEnabled: true, userProfileEnabled: true }, bothEntries],
    ['only memory', { ...limits, memoryEnabled: true, userProfileEnabled: false }, bothEntries],
    ['only user', { ...limits, memoryEnabled: false, userProfileEnabled: true }, bothEntries],
    ['enabled store is empty', { ...limits, memoryEnabled: true, userProfileEnabled: true }, () => ''],
    ['no stores enabled', { ...limits, memoryEnabled: false, userProfileEnabled: false }, bothEntries],
    ['char limits omitted', { memoryEnabled: true, userProfileEnabled: true }, bothEntries],
  ]
  for (const [label, eff, readRaw] of cases) {
    assert.equal(
      I.renderMemoryContext(eff, readRaw),
      upstream().renderMemoryContext(eff, readRaw),
      `memory snapshot drifted from upstream: ${label}`,
    )
    assert.equal(I.renderMemoryContext(eff, readRaw, 'zh'), upstream().renderMemoryContext(eff, readRaw))
  }

  // And assert undefined explicitly means zh, so no caller needs a sentinel.
  assert.equal(stripDirective(stripScopeLines(I.reviewPrompt({}))), upstream().reviewPrompt({}))

  // The loop-aware section is injected into every session's system prompt and
  // upstream does not export it, so compare against the array it assembles —
  // read back out of upstream's source, not asserted as a substring of it.
  assert.deepEqual(I.LOOP_AWARE_TEXT.zh, upstreamLoopAware(), 'loop-aware section drifted from the version under test')
  assert.equal(I.LOOP_AWARE_TEXT.zh.join('\n'), upstreamLoopAware().join('\n'))

  // Every remaining zh value is compared against the literal at the exact
  // upstream site that uses it, so a wrong one-character value cannot pass.
  const inUpstream = (actual, anchor, what) =>
    assert.equal(actual, upstreamLiteral(anchor, what), `not the text of the version under test — ${what}`)
  inUpstream(I.REVIEW_INPUT_TEXT.zh.emptyCatalog, '（当前无可用 skill）', 'empty-catalog fallback')
  inUpstream(I.REVIEW_INPUT_TEXT.zh.truncated, '…（截断）', 'suspect truncation marker')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.heading, '# 长期记忆（跨会话持久', 'memory snapshot heading')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.userTitle, 'USER（用户画像/偏好）', 'user store title')
  inUpstream(I.MEMORY_CONTEXT_TEXT.zh.memoryTitle, 'MEMORY（环境/项目事实/约定/教训）', 'memory store title')
  inUpstream(`\n## ${I.REVIEW_MEMORY_BLOCK_TEXT.zh.section}\n`, '## 当前记忆条目（oldText', 'review memory block heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.catalog}\n`, '## 既有 skill 清单（name: description）', 'catalog heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.suspects}\n`, '## 疑似相关 skill 全文', 'suspects heading')
  inUpstream(`\n## ${I.REVIEW_INPUT_TEXT.zh.transcript}\n`, '## 会话转写（保尾截断）', 'transcript heading')

  // The short separators are written inline by upstream's templates rather than
  // stored as literals, so they are pinned against the templates themselves:
  // upstream's memory-block line must still contain exactly these pieces, or the
  // dictionary's parens/items would be rendering something upstream never wrote.
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('}（${entries.length} 条）\\n'),
    'upstream no longer writes the memory-block count as （${entries.length} 条）',
  )
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes("'（推理中）'"),
    'upstream no longer prefixes reasoning previews with （推理中）',
  )
  assert.equal(I.REVIEW_MEMORY_BLOCK_TEXT.zh.open + I.REVIEW_MEMORY_BLOCK_TEXT.zh.items + I.REVIEW_MEMORY_BLOCK_TEXT.zh.close, '（条）')
  assert.equal(I.REVIEW_MEMORY_BLOCK_TEXT.zh.empty, '（空）')
  assert.equal(I.REVIEW_INPUT_TEXT.zh.reasoning, '（推理中）')
  // `字符` and ` 条` are inline fragments of upstream's snapshot template.
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('${memoryStoreLimit(store, eff)} 字符 · ${entries.length} 条'),
    'upstream no longer writes the snapshot count as 字符 · … 条',
  )
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.chars, '字符')
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.items, '条')
  // zh has no singular form, so the count-selected label must equal the plural
  // one. If a future edit gave zh a distinct singular, the rendered zh snapshot
  // would stop matching upstream for a one-entry store.
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.item, '条')
  assert.equal(I.REVIEW_MEMORY_BLOCK_TEXT.zh.item, '条')

  // The memory block is assembled by a template upstream writes inline, so the
  // rendered zh line is compared against that template's own text. This is what
  // pins the count's spacing and its full-width parentheses: checking the
  // dictionary values alone would not notice a template that dropped the space.
  const block = I.renderReviewMemoryBlock([{ store: 'user', entries: ['a', 'b'] }, { store: 'memory', entries: [] }], 'zh')
  assert.equal(
    block,
    upstreamLiteral('## 当前记忆条目（oldText', 'memory block')
    + '### USER（2 条）\n§ a\n§ b\n\n'
    + '### MEMORY（0 条）\n（空）',
    'review memory block drifted from the template upstream writes',
  )
  assert.ok(
    readFileSync(UPSTREAM, 'utf8').includes('}（${entries.length} 条）'),
    'upstream no longer renders the memory-block count as （${entries.length} 条）',
  )
})

test('the memory snapshot renders in the chosen language', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const readRaw = (store) => (store === 'user' ? '§ 用户偏好：回答直接给结论' : '§ 服务跑在 3080 端口')
  // Entry text is user-authored and is never translated; only framing is.
  const en = I.renderMemoryContext(eff, readRaw, 'en')
  const zh = I.renderMemoryContext(eff, readRaw, 'zh')

  assert.ok(en.startsWith(I.MEMORY_CONTEXT_TEXT.en.heading), 'the English heading must be the one the dictionary carries')
  assert.ok(en.includes(`## ${I.MEMORY_CONTEXT_TEXT.en.userTitle}`), 'the English user title must be the one the dictionary carries')
  assert.ok(en.includes(`## ${I.MEMORY_CONTEXT_TEXT.en.memoryTitle}`), 'the English memory title must be the one the dictionary carries')
  // Both stores hold exactly one entry here, so the singular label is what must
  // appear. "1 entries" was the shipped wording and is the defect this pins.
  assert.ok(en.includes(`1 ${I.MEMORY_CONTEXT_TEXT.en.item}`), 'the English entry count must use the singular label')
  assert.ok(!en.includes(`1 ${I.MEMORY_CONTEXT_TEXT.en.items}`), 'the English entry count must not say "1 entries"')
  assert.ok(en.includes(`2200 ${I.MEMORY_CONTEXT_TEXT.en.chars}`), 'the English char count must use the dictionary label')
  assert.ok(en.includes('服务跑在 3080 端口'), 'entry text must survive untouched')

  assert.match(zh, /^# 长期记忆/)
  // zh has no singular form: both labels are 条, so the rendered line is
  // unchanged and the upstream parity comparison still holds.
  assert.equal(I.MEMORY_CONTEXT_TEXT.zh.item, I.MEMORY_CONTEXT_TEXT.zh.items)
  assert.ok(zh.includes(`1 ${I.MEMORY_CONTEXT_TEXT.zh.items}`), 'the zh count must use the dictionary label')
})

test('entry counts use the singular label for exactly one entry, in en', () => {
  // A count of one is the only case where the label changes, and it is reachable
  // whenever a store holds a single entry. Both renderers are checked because
  // they index two different dictionaries.
  const one = (store) => (store === 'user' ? '§ only one' : '')
  const snapshot = I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, one, 'en')
  assert.match(snapshot, /· 1 entry\n/, 'the snapshot must say "1 entry"')
  assert.ok(!snapshot.includes('1 entries'), 'the snapshot must not say "1 entries"')

  const block = I.renderReviewMemoryBlock([{ store: 'user', entries: ['only one'] }], 'en')
  assert.match(block, /### USER \(1 entry\)/, 'the review memory block must say "1 entry"')

  // Plural for anything above one, and zero is plural in English.
  const two = I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, () => '§ a\n§ b', 'en')
  assert.match(two, /· 2 entries\n/, 'two entries must use the plural label')
  const blockTwo = I.renderReviewMemoryBlock([{ store: 'memory', entries: ['a', 'b'] }], 'en')
  assert.match(blockTwo, /### MEMORY \(2 entries\)/, 'two entries must use the plural label in the block')

  // Zero is plural in English, and it IS reachable: the review memory block
  // lists every enabled store, including one that holds nothing (the snapshot
  // skips empty stores, so only the block can render a zero). `n > 1 ? many : one`
  // says "0 entry" and would otherwise pass every assertion above.
  const blockNone = I.renderReviewMemoryBlock([{ store: 'memory', entries: [] }], 'en')
  assert.match(blockNone, /### MEMORY \(0 entries\)/, 'an empty store must say "0 entries"')
  assert.ok(!blockNone.includes('0 entry)'), 'an empty store must not say "0 entry"')
  assert.match(
    I.renderReviewMemoryBlock([{ store: 'memory', entries: [] }], 'zh'),
    /### MEMORY（0 条）/,
    'zh must render a zero count as 条',
  )

  // zh must not change between the two counts, since both labels are 条.
  const zhOne = I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, one, 'zh')
  const zhTwo = I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, () => '§ a\n§ b', 'zh')
  assert.match(zhOne, /· 1 条\n/)
  assert.match(zhTwo, /· 2 条\n/)
})

test('the review prompt switches wholesale and keeps its contract', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true }
  const en = I.reviewPrompt(eff, 'en')
  const zh = I.reviewPrompt(eff, 'zh')

  assert.match(en, /^You are the background review agent/)
  assert.match(en, /## Wrap-up distillation|## Positive signals/)
  assert.ok(!/[一-鿿]/.test(en), 'the English prompt must contain no Chinese')

  // Both branches must expose the same machine-readable contract, or the
  // conclusion parser silently starts rejecting results. Checked per element:
  // a bare field-name substring list would also pass a prompt that had lost the
  // fence, the per-field `required for` annotations, or the enums.
  for (const [text, label] of [[en, 'en'], [zh, 'zh']]) {
    for (const field of ['"action"', '"skill"', '"description"', '"body"', '"baseHash"', '"baseDescription"', '"rationale"', '"memory"', '"store"', '"text"', '"oldText"']) {
      assert.ok(text.includes(field), `${label}: output contract field missing: ${field}`)
    }
    assert.ok(text.includes('```json'), `${label}: the protocol must be a fenced json block`)
    assert.ok(text.includes('```'), `${label}: the json fence must be closed`)
    // The per-field required-for annotations, in the language's own wording.
    // These are what tell the model which fields are mandatory; losing them is
    // the failure that produces conclusions the parser rejects.
    const annotations = label === 'en'
      ? ['required for create/patch', 'required for create', 'required for patch', 'required for add/replace/remove']
      : ['create/patch 必填', 'create 必填', 'patch 必填', 'add/replace/remove 必填']
    for (const annotation of annotations) {
      assert.ok(text.includes(annotation), `${label}: missing field annotation "${annotation}"`)
    }
    for (const value of ['"nothing"', '"create"', '"patch"', '"add"', '"replace"', '"remove"']) {
      assert.ok(text.includes(value), `${label}: missing action value ${value}`)
    }
    assert.ok(text.includes('When to Use / Prerequisites / Procedure / Pitfalls / Verification'), `${label}: body section convention missing`)
  }

  // Structural parity: the two languages must correspond position by position,
  // so a line cannot be dropped, added, or reordered in one of them. Heading
  // lines are matched by shape (a `## ` title) rather than by text, so renaming
  // one section in a single language is caught.
  const headingCount = (lines, prefix) => lines.filter((l) => l.startsWith(prefix)).length
  for (const memoryOn of [true, false]) {
    const a = I.REVIEW_PROMPT_TEXT.zh(memoryOn)
    const b = I.REVIEW_PROMPT_TEXT.en(memoryOn)
    assert.equal(a.length, b.length, `zh/en prompt length differs with memoryOn=${memoryOn}`)
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i] === '', b[i] === '', `zh/en line ${i} is blank in only one language`)
      assert.equal(
        a[i].startsWith('## '), b[i].startsWith('## '),
        `zh/en line ${i} is a section heading in only one language: ${JSON.stringify([a[i], b[i]])}`,
      )
      assert.equal(/^\d\./.test(a[i]), /^\d\./.test(b[i]), `zh/en line ${i} is a numbered item in only one language`)
      assert.equal(a[i].startsWith('- '), b[i].startsWith('- '), `zh/en line ${i} is a bullet in only one language`)
      assert.equal(a[i].includes('```'), b[i].includes('```'), `zh/en line ${i} is a fence in only one language`)
    }
    assert.equal(headingCount(a, '## '), headingCount(b, '## '))
    assert.equal(a.filter((l) => /^\d\./.test(l)).length, b.filter((l) => /^\d\./.test(l)).length)
  }
  // The review protocol's sections, by the same index in both languages. Renaming
  // or dropping one in a single language changes the protocol the model follows,
  // so the whole sequence is pinned rather than only its shape.
  const zhSections = I.REVIEW_PROMPT_TEXT.zh(true).filter((l) => l.startsWith('## '))
  const enSections = I.REVIEW_PROMPT_TEXT.en(true).filter((l) => l.startsWith('## '))
  assert.deepEqual(
    zhSections.map((l) => l.slice(3).replace(/（[^）]*）/g, '')),
    ['主动倾向', '正向信号', '负面清单', '优先序', '命名纪律', '记忆', '分工', '输出协议'],
    'the zh review protocol lost or reordered a section',
  )
  assert.deepEqual(
    enSections.map((l) => l.slice(3).replace(/\s*\([^)]*\)/g, '')),
    ['Lean toward acting', 'Positive signals', 'Negative list', 'Priority order', 'Naming discipline', 'Memory', 'Division of labour', 'Output protocol'],
    'the en review protocol lost or reordered a section',
  )
  // Every dictionary the call sites index must carry both languages.
  for (const [name, dict] of Object.entries({ MEMORY_CONTEXT_TEXT: I.MEMORY_CONTEXT_TEXT, REVIEW_MEMORY_BLOCK_TEXT: I.REVIEW_MEMORY_BLOCK_TEXT, REVIEW_INPUT_TEXT: I.REVIEW_INPUT_TEXT })) {
    assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), `${name}: zh/en keys differ`)
  }
  assert.equal(I.LOOP_AWARE_TEXT.zh.length, I.LOOP_AWARE_TEXT.en.length)

  // The English copy is pinned exactly. The zh copy is pinned against the version
  // under test by running its code; there is no upstream English to compare with,
  // so an English string can only be pinned against itself. Pinning it is what
  // turns an unnoticed edit to the English wording into a failing test.
  assert.deepEqual(I.MEMORY_CONTEXT_TEXT.en, {
    heading: '# Long-term memory (persists across sessions, maintained on demand by the background review; this is the latest full snapshot)',
    userTitle: 'USER (user profile / preferences)',
    memoryTitle: 'MEMORY (environment facts, project facts, conventions, lessons)',
    // §13 (v0.6): the workspace-layer title joins the dictionary. Default-input
    // renders never emit it (the fourth renderMemoryContext argument stays
    // undefined), so upstream parity above is unaffected.
    workspaceTitle: 'MEMORY · workspace ({label})',
    chars: 'chars',
    item: 'entry',
    items: 'entries',
  }, 'the English memory snapshot copy changed')
  assert.deepEqual(I.REVIEW_MEMORY_BLOCK_TEXT.en, {
    section: "Current memory entries (oldText must match exactly one entry's original text; omit the memory field entirely when nothing is worth recording)",
    item: 'entry',
    items: 'entries',
    open: ' (',
    close: ')',
    empty: '(empty)',
    // §13 (v0.6): workspace-layer block title, used only for stores carrying
    // variant: 'workspace'; default renders are byte-identical to upstream.
    workspace: 'MEMORY (workspace)',
  }, 'the English review memory block copy changed')
  assert.deepEqual(I.REVIEW_INPUT_TEXT.en, {
    catalog: 'Existing skill catalog (name: description)',
    suspects: 'Full text of likely-relevant skills',
    transcript: 'Session transcript (tail-preserving truncation)',
    reasoning: '(reasoning)',
    transcriptTruncated: '…(earlier messages dropped; tail kept)',
    emptyCatalog: '(no skills available)',
    truncated: '\n… (truncated)',
  }, 'the English review input copy changed')
  // The directives are pinned verbatim, for the same reason as every other
  // model-facing string here: `prompt.includes(directive)` reads the very
  // constant that builds the prompt, so a wording edit that guts the
  // instruction ("English.") still satisfies every containment assertion. The
  // model obeys this text, so only a literal pin turns an unnoticed weakening
  // of it into a failure. The zh side is pinned here too rather than against
  // upstream, because upstream has no such line to compare against.
  assert.deepEqual(I.REVIEW_LANGUAGE_DIRECTIVE, {
    zh: '所有自然语言字段（description、body、memory.text、rationale）一律用中文写。这由用户的语言设置决定，与转写、技能目录或记忆条目本身用什么语言无关。',
    en: "Write every natural-language field (description, body, memory.text, rationale) in English. This follows the user's language setting and is independent of whatever language the transcript, skill catalog, or memory entries happen to use.",
  }, 'an output-language directive changed wording; update the pin only if the new wording still names its language and stays independent of the surrounding context')
  assert.deepEqual(I.LOOP_AWARE_TEXT.en, [
    '# Wrap-up distillation (the background learning loop is running)',
    '',
    '- When wrapping up, if you find that a **skill loaded in this session** is wrong, missing steps, or outdated: fix it **immediately with your own tools** rather than leaving it to the background review (the background review will also catch it, but your context here is the most complete one).',
    '- Leave all other distillation (new skills, lessons learned) to the background learning loop. **Do not** proactively write new skill files — two competing sets of instructions would fight each other.',
  ], 'the English loop-aware copy changed')

  // The English review prompt is the largest model-facing surface and is pinned
  // here for the same reason as the dictionaries: the model obeys this text, and
  // `parseConclusion` reads the keys it names. Renaming `rationale` in the
  // English prompt while the parser still reads `rationale` would turn every
  // English review into a silent no-op, with the suite green.
  //
  // Changing English wording means editing here too. That is the cost of having
  // no upstream English to compare against; the zh branch is pinned against the
  // real 0.1.16 functions instead and has no equivalent duplication.
  assert.deepEqual(I.REVIEW_PROMPT_TEXT.en(true), [
    'You are the background review agent: analyze a transcript of a just-finished conversation and decide whether it holds experience worth distilling into a skill.',
    '',
    '## Lean toward acting',
    'Be ACTIVE — most conversations are worth at least one small update. Doing nothing is not a neutral outcome; it is a missed learning opportunity.',
    '',
    '## Positive signals (act if any holds)',
    '1. The user corrected style/tone/format/verbosity ("stop doing X" / "too verbose" / "just give me the answer") — this is a FIRST-CLASS signal;',
    '2. The user corrected the workflow or the order of steps;',
    '3. A non-trivial technique, fix, workaround, debugging path, or tool usage appeared;',
    '4. An injected existing skill was found wrong, incomplete, or outdated → PATCH it immediately.',
    '',
    '## Negative list (never distill these)',
    '- Environment dependency failures (missing binary, unconfigured credentials — things the user can fix themselves);',
    '- Negative assertions about tools ("X is broken" hardens into a permanent refusal);',
    '- Transient errors already resolved within the session (what is worth storing is the retry pattern, not the failure itself);',
    '- One-off task narrative (it does not constitute a category of work);',
    '- Unresolved failures — an unverified dead end must never be packaged as a reliable procedure.',
    '',
    '## Priority order',
    '1. PATCH a skill that appeared in the transcript and whose full text was injected;',
    '2. PATCH an existing class-level umbrella skill (see the catalog below);',
    '3. Only when neither covers it, CREATE a new skill.',
    '',
    '## Naming discipline',
    'Use kebab-case class-level names. No PR numbers, error strings, or one-off codenames (fix-X / debug-Y style).',
    "If the name only makes sense for today's task, it is wrong — go back to priority 1/2 and extend an existing skill instead.",
    '',
    '## Memory (optional conclusion — most reviews should produce none)',
    'Besides skills, consider writing memory only when the conversation **explicitly** surfaced:',
    '- user profile, preferences, expectations about how you behave → store="user";',
    '- environment/project facts, conventions, lessons (e.g. "releases require OTP", "the service runs on port 19080") → store="memory";',
    '- processes, steps, pitfalls → these remain skills; never write them into memory.',
    // §13 (v0.6): the two-layer routing line ships unconditionally with the memory section
    '- store="memory" has two layers: facts/conventions that only apply to the current project (paths, ports, scripts, project-specific rules) → add "scope": "project" to the conclusion, written to the current workspace store (the "MEMORY (workspace)" block below); cross-project environment facts/conventions → omit scope (or use "global") for the global store. oldText of replace/remove is located within the same layer.',
    'Produce on demand: if nothing is clearly worth keeping, omit the memory field — do not write for the sake of writing. The memory stores are small, tightly-curated lists; mediocre entries crowd out real ones, while a missed entry costs almost nothing.',
    'When a store nears its limit, prefer replace (merge and rewrite an existing entry) or remove (drop a stale entry) over add.',
    '',
    '## Division of labour',
    'Processes, steps, pitfalls → skill; environment facts/conventions/lessons and user profile → memory (rules above).',
    '',
    '## Output protocol (strictly obey)',
    'Output one fenced JSON code block and nothing else:',
    '```json',
    '{ "action": "nothing" | "create" | "patch",',
    '  "skill": "kebab-case-name",            // required for create/patch',
    '  "description": "≤500 characters",       // required for create',
    '  "body": "Complete SKILL.md body, without frontmatter",  // required for create/patch',
    '  "baseHash": "<echo the injected suspect baseHash verbatim>",  // required for patch',
    '  "baseDescription": "<echo the injected suspect description verbatim>",  // required for patch',
    '  "rationale": "One sentence: why it is worth storing, or why not",',
    '  "memory": {                            // optional; most reviews should omit the whole field',
    '    "action": "nothing" | "add" | "replace" | "remove",',
    '    "store": "memory" | "user",           // required for add/replace/remove',
    '    "scope": "project" | "global",           // optional; store="memory" only, defaults to global',
    '    "text": "New entry, one sentence (required for add/replace)",',
    '    "oldText": "A substring of the original text that uniquely matches one entry in the memory list below (required for replace/remove)",',
    '    "rationale": "Why record / change / delete" }',
    '}',
    '```',
    'On patch, the body must be derived by modifying the injected target text (keep what is correct, change only what must change); never rewrite it from scratch.',
    'Body section convention: When to Use / Prerequisites / Procedure / Pitfalls / Verification.',
    I.REVIEW_LANGUAGE_DIRECTIVE.en,
  ], 'the English review prompt changed')
  const enOff = I.REVIEW_PROMPT_TEXT.en(false)
  assert.equal(enOff.length, 44, 'the English memory-off prompt must drop exactly the two memory blocks')
  assert.ok(!enOff.some((l) => l.startsWith('## Memory')), 'no memory guidance section when memory is off')
  assert.ok(!enOff.some((l) => l.includes('"memory":')), 'no memory conclusion schema when memory is off')
  assert.deepEqual(
    enOff.slice(26, 29),
    ['## Division of labour', 'Processes, steps, pitfalls → skill. User profile/preference information is not distilled this round.', ''],
    'the English memory-off division-of-labour line must say memory is not distilled',
  )
})

test('each review prompt pins the artifact language to its own language', () => {
  // The regression this guards: `preference=en` produced a fully Chinese skill,
  // because the prompt localized the protocol's own copy but left the
  // model-written `description`, `body`, `rationale`, and `memory.text`
  // unconstrained. The model drifted toward the surrounding context, which held
  // a Chinese skill catalog and Chinese memory entries. Pinning the protocol
  // language is therefore not enough on its own; the artifact language must be
  // stated, and it must follow the same `lang` as the rest of the prompt.
  const eff = { memoryEnabled: true, userProfileEnabled: true }
  for (const lang of ['zh', 'en']) {
    const prompt = I.reviewPrompt(eff, lang)
    const directive = I.REVIEW_LANGUAGE_DIRECTIVE[lang]
    assert.ok(directive, `${lang}: no output-language directive is defined`)
    assert.ok(prompt.includes(directive), `${lang}: the review prompt does not carry its language directive`)
    // Position matters only in that it must be inside the protocol, after the
    // contract the model is asked to fill in, not stranded in an earlier
    // section where it reads as a statement about the transcript.
    assert.ok(
      prompt.indexOf(directive) > prompt.lastIndexOf('Body section convention'),
      `${lang}: the language directive must follow the output protocol`,
    )
  }

  // The two directives must differ, and each must name its own language: a copy
  // that named the wrong one would silently invert the setting.
  assert.notEqual(I.REVIEW_LANGUAGE_DIRECTIVE.zh, I.REVIEW_LANGUAGE_DIRECTIVE.en)
  assert.match(I.REVIEW_LANGUAGE_DIRECTIVE.en, /English/, 'the en directive must name English')
  assert.match(I.REVIEW_LANGUAGE_DIRECTIVE.zh, /中文/, 'the zh directive must name Chinese')
  assert.ok(
    !/English/.test(I.REVIEW_LANGUAGE_DIRECTIVE.zh),
    'the zh directive must not name English',
  )

  // With memory off the artifact language still has to hold: `description`,
  // `body`, and `rationale` remain in the contract.
  for (const lang of ['zh', 'en']) {
    assert.ok(
      I.reviewPrompt({ memoryEnabled: false, userProfileEnabled: false }, lang)
        .includes(I.REVIEW_LANGUAGE_DIRECTIVE[lang]),
      `${lang}: the directive must survive the memory-off branch`,
    )
  }
})

test('no English surface leaks Chinese or fullwidth punctuation', () => {
  // Han alone is not enough: the fullwidth parentheses the zh branch keeps are
  // CJK punctuation, and a half-translated heading is the defect this catches.
  const cjk = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/
  const surfaces = {
    'review prompt': I.reviewPrompt({ memoryEnabled: true, userProfileEnabled: true }, 'en'),
    'memory snapshot': I.renderMemoryContext({ memoryEnabled: true, userProfileEnabled: true }, () => '\u00a7 entry', 'en'),
    'review memory block': I.renderReviewMemoryBlock([{ store: 'user', entries: ['a'] }, { store: 'memory', entries: [] }], 'en'),
    'loop-aware': I.LOOP_AWARE_TEXT.en.join('\n'),
    'review input': Object.values(I.REVIEW_INPUT_TEXT.en).join('\n'),
    'memory context dict': Object.values(I.MEMORY_CONTEXT_TEXT.en).join('\n'),
    // The transcript is spliced into the prompt verbatim, past every dictionary,
    // so it has to be rendered here or a marker it owns goes unchecked.
    'rendered transcript (truncated)': I.renderTranscript(
      Array.from({ length: 40 }, () => ({ role: 'user', content: 'y'.repeat(380) })),
      { lang: 'en' },
    ),
  }
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(!cjk.test(text), `${name} still contains CJK: ${JSON.stringify(text.match(cjk))}`)
  }
  // Under-length transcripts and zh must both still work.
  assert.ok(!cjk.test(I.renderTranscript([{ role: 'user', content: 'short' }], { lang: 'en' })))
  // The per-message cap runs first, so exceeding the transcript limit needs many
  // messages rather than one long one.
  const long = Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(380) }))
  assert.match(I.renderTranscript(long, { lang: 'zh' }), /^…（早段已按保尾策略截断）/,
    'the zh transcript marker must stay byte-identical to the historical text')
  assert.match(I.renderTranscript(long, { lang: 'en' }), /^…\(earlier messages dropped; tail kept\)/,
    'the English transcript must carry its own marker')
})

// A minimal stand-in for the parts of the host context `apply` touches. The
// provider wiring is only reachable through `apply`, so testing the dictionaries
// directly cannot prove the runner passes the right language to each renderer.
function hostContext({ preference = 'en', unset = false } = {}) {
  const sections = [], contexts = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: { describe: () => [{ ns: 'locale', value: unset ? {} : { preference } }] },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      context: (c) => { contexts.push(c); return () => {} },
    },
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }
  ctx.plugin = plugin
  plugin.apply(ctx)
  return {
    section: (name) => sections.find((s) => s.name === name),
    context: (name) => contexts.find((c) => c.name === name),
  }
}

test('the loop-aware section provider renders the chosen language', () => {
  // Forcing the provider to zh would leave an English-preference user with
  // Chinese discipline instructions and no test failure, because every previous
  // assertion read LOOP_AWARE_TEXT.en directly instead of calling the provider.
  const en = hostContext({ preference: 'en' }).section('hermes:loop-aware')
  assert.equal(en.text(), I.LOOP_AWARE_TEXT.en.join('\n'))
  assert.equal(en.text(), I.LOOP_AWARE_TEXT.en.join('\n'), 'the provider is stable across calls')

  const zh = hostContext({ unset: true }).section('hermes:loop-aware')
  assert.equal(zh.text(), I.LOOP_AWARE_TEXT.zh.join('\n'))

  // Production calls the provider with an assembly scope. A scope the memory
  // context has not frozen yet must fall back to the live language rather than
  // returning undefined — reading `memoryLang.get(scope)` unguarded throws a
  // TypeError and takes the whole prompt assembly down.
  assert.equal(en.text({ scope: {} }), I.LOOP_AWARE_TEXT.en.join('\n'), 'an unfrozen scope falls back')
  assert.equal(zh.text({ scope: {} }), I.LOOP_AWARE_TEXT.zh.join('\n'), 'an unfrozen scope falls back in zh too')
})

test('the section and the frozen snapshot agree within one session', () => {
  // The scope branch above only covers the fallback. Here the session actually
  // freezes: the memory context renders first, then the section is asked for the
  // same scope after the language changed. Both must keep the session's language,
  // otherwise one session carries two languages.
  //
  // renderMemoryContext returns '' when every store has zero entries, so the zh
  // heading asserted below only appears if MEMORY.md holds at least one entry.
  // Point DSH_HOME at a temp fixture so the test does not depend on the
  // developer's real ~/.dsh/memory/MEMORY.md (which is absent on CI runners).
  const home = mkdtempSync(join(tmpdir(), 'hermes-i18n-snap-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    mkdirSync(join(home, 'memory'), { recursive: true })
    writeFileSync(join(home, 'memory', 'MEMORY.md'), '§ i18n fixture entry\n')
    let preference = 'zh'
    let update = null
    const sections = [], contexts = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      settings: { describe: () => [{ ns: 'locale', value: { preference } }] },
      systemPrompt: {
        section: (x) => { sections.push(x); return () => {} },
        context: (x) => { contexts.push(x); return () => {} },
      },
      effect: (fn) => fn(),
      on: (ev, h) => { if (ev === 'settings/document-updated') update = h; return () => {} },
      get: () => undefined,
    }
    ctx.plugin = plugin
    plugin.apply(ctx)
    const section = sections.find((x) => x.name === 'hermes:loop-aware')
    const memory = contexts.find((x) => x.name === 'hermes:memory')
    const scope = {}

    assert.match(memory.text({ scope }), /^# 长期记忆/, 'the session snapshot starts in zh')
    preference = 'en'
    update('locale')
    assert.equal(section.text({ scope }), I.LOOP_AWARE_TEXT.zh.join('\n'),
      'the section keeps the language the session froze')
    assert.match(memory.text({ scope }), /^# 长期记忆/, 'the frozen snapshot is unchanged')

    // A new session picks up the new language on both surfaces.
    const fresh = {}
    assert.equal(section.text({ scope: fresh }), I.LOOP_AWARE_TEXT.en.join('\n'))
    assert.match(memory.text({ scope: fresh }), /^# Long-term memory/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the runner passes its language to every renderer', () => {
  // The transcript marker reaches the model only through the runner's call, and
  // the runner's call is not reachable from here — it needs a session, an agent,
  // and the review pipeline. A source-text assertion for it is defeated by a
  // comment containing the same string, and is blind to the resolved language
  // value, so the wiring is covered end-to-end in test/loop.test.mjs instead.
  // What is pinned here is the renderer contract the runner depends on.
  const long = Array.from({ length: 40 }, () => ({ role: 'user', content: 'y'.repeat(380) }))
  assert.match(I.renderTranscript(long, { lang: 'en' }), /^…\(earlier messages dropped; tail kept\)/)
  assert.match(I.renderTranscript(long, { lang: 'zh' }), /^…（早段已按保尾策略截断）/)
  // No lang at all must stay on the historical text, never invent English.
  assert.match(I.renderTranscript(long, {}), /^…（早段已按保尾策略截断）/)
})

test('an absent locale row costs nothing once the retry budget is spent', () => {
  // describe() walks every plugin row in the profile. A profile with no locale
  // row (headless, or before the entry mounts) must stop paying for it rather
  // than re-reading on every prompt assembly forever.
  //
  // This drives the SHIPPED resolver (`createLanguageResolver`, the same factory
  // `apply` calls), not a local reimplementation. An earlier version of this test
  // copied the guard inline, so mutating LANGUAGE_RETRIES to 1000 in src/index.js
  // left the whole suite green; the retry budget was untested.
  let calls = 0
  const ctx = { settings: { describe: () => { calls++; return [] } } }
  const read = () => I.readLocalePreference(ctx)

  // The production budget is what the assertion below is about, so pin it first.
  // A bare `LANGUAGE_RETRIES = 1000` edit fails here with the reason.
  assert.equal(I.LANGUAGE_RETRIES, 15, 'the retry budget changed; ~30 s at 2 s per retry')

  // Timer-driven retries are captured instead of waited on, so the budget is
  // drained synchronously and no test sleeps for 30 s.
  const pending = []
  const language = I.createLanguageResolver({ read, schedule: (fn) => pending.push(fn) })

  // First call reads, finds nothing readable, and schedules exactly one retry.
  assert.equal(language(), 'zh', 'an unreadable document resolves conservatively')
  assert.equal(pending.length, 1, 'exactly one retry must be scheduled per attempt')
  assert.equal(calls, 1, 'the first call reads once')

  // Drain the scheduled retries. The guard is `attempts++ > LANGUAGE_RETRIES`
  // starting from 0, so the retry that settles the resolver is the 16th attempt:
  // 15 retries that reschedule, then one that gives up. Reads are one per
  // attempt plus the initial one.
  let drains = 0
  while (pending.length > 0) {
    drains++
    assert.ok(drains <= I.LANGUAGE_RETRIES + 2, 'the retry budget must be bounded')
    pending.shift()()
  }
  assert.equal(drains, I.LANGUAGE_RETRIES + 1, 'the resolver must stop retrying at the budget')
  assert.equal(calls, I.LANGUAGE_RETRIES + 2, 'one initial read, then one per attempt')
  assert.equal(language(), 'zh', 'the give-up answer is the historical Chinese')

  // Once settled it must not read again: that is the cost this cache exists to avoid.
  const settled = calls
  for (let i = 0; i < 50; i++) language()
  assert.equal(calls - settled, 0, 'language() must cache the give-up answer instead of re-reading')
  assert.equal(pending.length, 0, 'a settled resolver must not schedule more retries')
})

test('a readable document with no preference resolves at once, without retrying', () => {
  // The distinction the resolver exists for: `seen:true, value:undefined` is a
  // readable document where the user simply never chose a language. It must
  // settle immediately; only an UNREADABLE document (seen:false) retries.
  const ctx = { settings: { describe: () => [{ ns: 'locale', value: {} }] } }
  const pending = []
  const language = I.createLanguageResolver({
    read: () => I.readLocalePreference(ctx),
    schedule: (fn) => pending.push(fn),
  })
  assert.equal(language(), 'zh', 'no explicit preference means the historical text')
  assert.equal(pending.length, 0, 'a readable document must not schedule retries')
})

test('invalidate() re-reads the document, so a language change takes effect', () => {
  // The Language row writes through `settings/document-updated`, which calls
  // invalidate(). Without it the first resolved language would stick for the
  // life of the host process.
  let preference = 'en'
  const ctx = () => ({ settings: { describe: () => [{ ns: 'locale', value: { preference } }] } })
  const language = I.createLanguageResolver({ read: () => I.readLocalePreference(ctx()) })
  assert.equal(language(), 'en', 'the initial preference resolves')
  preference = 'zh'
  assert.equal(language(), 'en', 'the cache holds until invalidated')
  language.invalidate()
  assert.equal(language(), 'zh', 'invalidate() must pick up the new preference')
  preference = 'en'
  language.invalidate()
  assert.equal(language(), 'en', 'invalidation is repeatable in both directions')
})

test('invalidate() restores the full retry budget, not just the cache', () => {
  // The retry counter must be reset along with the cache, or a locale row that
  // mounts AFTER the budget was already spent would be read once and then
  // immediately settle on the conservative answer. This is exactly the
  // late-mount scenario the budget exists for, so the counter reset is
  // load-bearing: `invalidate = () => { cache = undefined }` alone (dropping
  // `attempts = 0`) passes the test above, because that resolver never retries.
  let readable = false
  const pending = []
  const language = I.createLanguageResolver({
    read: () => (readable
      ? { value: 'en', seen: true }
      : { value: undefined, seen: false }),
    schedule: (fn) => pending.push(fn),
  })

  // Burn the budget while the document is unreadable.
  assert.equal(language(), 'zh', 'an unreadable document resolves conservatively')
  while (pending.length > 0) pending.shift()()
  assert.equal(language(), 'zh', 'the budget is exhausted')
  assert.equal(pending.length, 0, 'a spent budget schedules nothing further')
  assert.equal(language.state().attempts, I.LANGUAGE_RETRIES + 2, 'the counter recorded the spend')

  // The locale row mounts late and the settings event fires.
  readable = true
  language.invalidate()
  assert.equal(language(), 'en', 'a late-mounting row must be picked up after invalidate()')
  assert.equal(language.state().attempts, 0, 'invalidate() must reset the retry counter too')

  // And the restored budget must be a FULL one, so a second unreadable stretch
  // retries as many times as the first rather than giving up at once.
  readable = false
  language.invalidate()
  assert.equal(language(), 'zh')
  assert.equal(pending.length, 1, 'one retry scheduled')
  let drains = 0
  while (pending.length > 0) { drains++; pending.shift()() }
  assert.equal(drains, I.LANGUAGE_RETRIES + 1, 'the second stretch gets the same full budget')
})

test('the memory block drops its section when both stores are off, in both languages', () => {
  const off = { memoryEnabled: false, userProfileEnabled: false }
  assert.ok(!I.reviewPrompt(off, 'en').includes('"memory"'))
  assert.ok(!I.reviewPrompt(off, 'zh').includes('"memory"'))
  assert.match(I.reviewPrompt(off, 'en'), /not distilled this round/)
})
// ── §13 (v0.6) workspace memory copy ──────────────────────────────────────
// The scope copy ships unconditionally with the memory section (no toggle —
// the review agent decides project vs global per conclusion). The upstream
// parity loop above keeps pinning the v0.5 text by stripping exactly these
// lines; this block pins the new copy itself.

test('workspace scope lines: zh/en mirror each other and ship with the memory section', () => {
  const on = { memoryEnabled: true, userProfileEnabled: true }
  const zh = I.reviewPrompt(on, 'zh')
  const en = I.reviewPrompt(on, 'en')

  // Both languages carry the scope bullet and the protocol example line.
  assert.ok(zh.includes('"scope": "project" | "global"'), 'zh protocol example carries scope')
  assert.ok(en.includes('"scope": "project" | "global"'), 'en protocol example carries scope')
  assert.ok(zh.includes('MEMORY（工作区）'), 'zh names the workspace block')
  assert.ok(en.includes('MEMORY (workspace)'), 'en names the workspace block')
  assert.ok(zh.includes('写入当前工作区库'), 'zh explains project routing')
  assert.ok(en.includes('written to the current workspace store'), 'en explains project routing')

  // The example line sits inside the memory conclusion example, right after store.
  // (Find the protocol-example line specifically — the Memory section bullet
  // mentions "scope" too, and it appears earlier in the prompt.)
  const scopeLine = (l) => l.includes('"scope": "project" | "global",')
  const zhLines = zh.split('\n')
  const enLines = en.split('\n')
  assert.ok(zhLines[zhLines.indexOf(zhLines.find(scopeLine)) - 1].trimStart().startsWith('"store"'), 'zh scope line follows the store line')
  assert.ok(enLines[enLines.indexOf(enLines.find(scopeLine)) - 1].trimStart().startsWith('"store"'), 'en scope line follows the store line')

  // Memory channel fully off → the scope copy leaves with the whole section.
  const off = { memoryEnabled: false, userProfileEnabled: false }
  assert.ok(!I.reviewPrompt(off, 'zh').includes('"scope"'))
  assert.ok(!I.reviewPrompt(off, 'en').includes('"scope"'))

  // The gated en copy must not leak CJK or fullwidth punctuation.
  const cjk = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/
  assert.ok(!cjk.test(en), `en prompt with scope lines contains CJK: ${JSON.stringify(en.match(cjk))}`)
})

test('workspace layer renders in the snapshot and the review block, in both languages', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const ws = { label: '/Users/mac/proj', raw: '§ workspace fact' }
  const readRaw = (store) => (store === 'memory' ? '§ global fact' : '')

  const zhSnap = I.renderMemoryContext(eff, readRaw, 'zh', ws)
  const enSnap = I.renderMemoryContext(eff, readRaw, 'en', ws)
  assert.ok(zhSnap.includes(I.MEMORY_CONTEXT_TEXT.zh.workspaceTitle.replace('{label}', '/Users/mac/proj')))
  assert.ok(enSnap.includes(I.MEMORY_CONTEXT_TEXT.en.workspaceTitle.replace('{label}', '/Users/mac/proj')))
  // zh/en dictionary values differ only in framing; entry text passes through.
  assert.ok(zhSnap.includes('§ workspace fact') && enSnap.includes('§ workspace fact'))

  const zhBlock = I.renderReviewMemoryBlock([{ store: 'memory', entries: ['a'], variant: 'workspace' }], 'zh')
  const enBlock = I.renderReviewMemoryBlock([{ store: 'memory', entries: ['a'], variant: 'workspace' }], 'en')
  assert.ok(zhBlock.includes(`### ${I.REVIEW_MEMORY_BLOCK_TEXT.zh.workspace}（1 条）`))
  assert.ok(enBlock.includes(`### ${I.REVIEW_MEMORY_BLOCK_TEXT.en.workspace} (1 entry)`))

  // The en surfaces stay CJK-free with the workspace copy active.
  const cjk = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/
  assert.ok(!cjk.test(enSnap), 'en workspace snapshot contains CJK')
  assert.ok(!cjk.test(enBlock), 'en workspace block contains CJK')
})
