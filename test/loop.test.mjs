import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// 测试全程把 DSH_HOME 指向临时目录：插件的 activity.jsonl 审计日志与全局
// skill 目录都按 $DSH_HOME 解析，否则会污染真实 ~/.dsh。
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'hermes-loop-tests-'))

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const {
  reasonKind, contentToText, renderTranscript, rankSuspects, parseConclusion,
  sha256, buildSkillMd, applyConclusion, descriptionOf, DEFAULTS,
} = plugin.__internals

// ── reasonKind ──────────────────────────────────────────────────────────

test('reasonKind unwraps the {kind} payload and tolerates bare strings', () => {
  assert.equal(reasonKind({ kind: 'completed' }), 'completed')
  assert.equal(reasonKind({ kind: 'aborted' }), 'aborted')
  assert.equal(reasonKind('completed'), 'completed')
  assert.equal(reasonKind(undefined), undefined)
  assert.equal(reasonKind(42), undefined)
})

// ── contentToText / renderTranscript ────────────────────────────────────

test('contentToText extracts text blocks and names tool calls', () => {
  assert.equal(contentToText('plain'), 'plain')
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'tool_call', name: 'read' }, { type: 'thinking', text: 'skip' }]), 'a\n[tool read]')
  assert.equal(contentToText({ text: 'obj' }), 'obj')
  assert.equal(contentToText(undefined), '')
})

test('renderTranscript keeps the tail and skips empty messages', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [] },
    { role: 'user', content: 'second' },
  ]
  const out = renderTranscript(messages, { maxChars: 10_000, maxMessages: 2 })
  assert.match(out, /### user\nsecond/)
  assert.doesNotMatch(out, /first/) // beyond the tail window
  const tiny = renderTranscript([{ role: 'user', content: 'x'.repeat(500) }], { maxChars: 100, maxMessages: 40 })
  assert.ok(tiny.length <= 100 + '…（早段已按保尾策略截断）\n'.length)
  assert.match(tiny, /早段已按保尾策略截断/)
})

// ── rankSuspects ────────────────────────────────────────────────────────

test('rankSuspects scores name hits above description hits and handles CJK', () => {
  const catalog = [
    { name: 'rust-daily', description: 'daily rust workflow' },
    { name: 'unrelated-skill', description: 'something else entirely' },
    { name: 'deploy-flow', description: '部署流程与回滚步骤' },
  ]
  const transcript = 'we ran the deploy-flow today and had to rollback. 部署流程 worked'
  const ranked = rankSuspects(catalog, transcript)
  assert.equal(ranked[0].name, 'deploy-flow')
  assert.ok(ranked.some((s) => s.name === 'rust-daily') === false) // no hit at all
})

// ── parseConclusion ─────────────────────────────────────────────────────

test('parseConclusion accepts a fenced create conclusion', () => {
  const text = '前置说明\n```json\n{ "action": "create", "skill": "my-skill", "description": "d", "body": "# hi", "rationale": "r" }\n```'
  const c = parseConclusion(text)
  assert.equal(c.action, 'create')
  assert.equal(c.skill, 'my-skill')
  assert.equal(c.body, '# hi')
})

test('parseConclusion accepts patch only with baseHash (CAS input)', () => {
  const good = parseConclusion('{"action":"patch","skill":"a-b","body":"x","baseHash":"deadbeef","baseDescription":"d"}')
  assert.equal(good.action, 'patch')
  assert.equal(good.baseHash, 'deadbeef')
  assert.equal(parseConclusion('{"action":"patch","skill":"a-b","body":"x"}'), undefined)
})

test('parseConclusion fail-closes on junk: bad action, bad name, empty body, non-JSON', () => {
  assert.equal(parseConclusion('{"action":"delete","skill":"a"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"Bad_Name","description":"d","body":"b"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"a","description":"","body":"b"}'), undefined)
  assert.equal(parseConclusion('{"action":"create","skill":"a","description":"d","body":""}'), undefined)
  assert.equal(parseConclusion('not json at all'), undefined)
  assert.equal(parseConclusion('{"action":"nothing"}').action, 'nothing')
})

// ── buildSkillMd / descriptionOf ────────────────────────────────────────

test('buildSkillMd emits valid frontmatter and descriptionOf round-trips it', () => {
  const content = buildSkillMd('my-skill', 'does things', '## When to Use\nbody text\n')
  assert.match(content, /^---\n/)
  assert.equal(descriptionOf(content), 'does things')
  const quoted = buildSkillMd('my-skill', 'has "quotes" and\nnewline', 'b')
  assert.equal(descriptionOf(quoted), 'has "quotes" and newline')
})

// ── applyConclusion (real filesystem, temp globalDir) ───────────────────

async function tempGlobalDir() {
  return mkdtemp(join(tmpdir(), 'hermes-loop-test-'))
}

test('applyConclusion: create writes atomically; conflict refuses to overwrite', async () => {
  const dir = await tempGlobalDir()
  try {
    const out = await applyConclusion(
      { action: 'create', skill: 'new-skill', description: 'd1', body: 'body v1' },
      { globalDir: dir })
    assert.equal(out.result, 'created')
    const written = await readFile(join(dir, 'new-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /^---\nname: /)
    assert.match(written, /body v1/)
    // no temp leftovers
    const entries = await readdir(join(dir, 'new-skill'))
    assert.deepEqual(entries, ['SKILL.md'])
    const conflict = await applyConclusion(
      { action: 'create', skill: 'new-skill', description: 'd2', body: 'body v2' },
      { globalDir: dir })
    assert.equal(conflict.result, 'create-conflict')
    assert.match(await readFile(join(dir, 'new-skill', 'SKILL.md'), 'utf8'), /body v1/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('applyConclusion: patch passes CAS when unchanged, fails when file drifted', async () => {
  const dir = await tempGlobalDir()
  try {
    await mkdir(join(dir, 'p-skill'), { recursive: true })
    const original = '---\nname: "p-skill"\ndescription: "orig"\n---\n\nbody v1\n'
    await writeFile(join(dir, 'p-skill', 'SKILL.md'), original)
    const baseHash = sha256(original)
    const ok = await applyConclusion(
      { action: 'patch', skill: 'p-skill', body: 'body v2', baseHash, baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(ok.result, 'patched')
    const after = await readFile(join(dir, 'p-skill', 'SKILL.md'), 'utf8')
    assert.match(after, /body v2/)
    assert.match(after, /description: "orig"/) // description preserved through patch

    const drifted = await applyConclusion(
      { action: 'patch', skill: 'p-skill', body: 'body v3', baseHash, baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(drifted.result, 'cas-conflict')

    const missing = await applyConclusion(
      { action: 'patch', skill: 'ghost-skill', body: 'x', baseHash: 'aa' },
      { globalDir: dir })
    assert.equal(missing.result, 'patch-missing')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── end-to-end through apply(): fake services drive a full review ───────

function fakeServices(conclusionText) {
  const created = []
  const agent = {
    session: {
      seq: 0,
      events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: conclusionText }] } } }],
    },
    followup(message) { created.push(message) },
    whenIdle: async () => {},
    cancel() {},
  }
  return {
    created,
    agents: { create: async (opts) => { created.push(opts); return { agent, dispose: async () => {} } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov', model: 'mdl' }) },
  }
}

function setupPlugin(config, services) {
  const handlers = []
  const cleanups = []
  const infos = []
  const warns = []
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    skills: { snapshot: async () => ({ skills: [{ name: 'known-skill', description: 'a known skill about deploys', invocation: { modelInvocable: true } }], complete: true }) },
    // 静态注入契约：服务直接挂在 ctx 上；settings 缺席时走 config+defaults 回退
    settings: undefined,
    ...services,
  }
  plugin.apply(ctx, config)
  return {
    fire: (session, event) => { for (const h of handlers) h(session, event) },
    infos, warns, cleanups,
  }
}

const completedTurn = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

test('loop end-to-end: threshold fires review, log-only mode logs the conclusion', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', rationale: 'one-off task' })
  const services = fakeServices('```json\n' + conclusion + '\n```')
  const t = setupPlugin({ turnInterval: 2, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-real', header: {}, deriveMessages: () => [{ role: 'user', content: 'hi' }] }
  t.fire(session, completedTurn)
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  // action=nothing 结算在 runner 内（无需进 writer），直接落日志
  assert.ok(t.infos.some((m) => m.includes('→ nothing') && m.includes('one-off task')), t.infos.join('|'))
})

test('loop end-to-end: auto mode lands the skill in $DSH_HOME/skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-home-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'e2e-skill', description: 'from e2e test', body: 'e2e body' })
    const services = fakeServices('```json\n' + conclusion + '\n```')
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-e2e', header: { cwd: home }, deriveMessages: () => [{ role: 'user', content: 'do the thing' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const written = await readFile(join(home, 'skills', 'e2e-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /e2e body/)
    assert.match(written, /description: "from e2e test"/)
    // review agent was created zero-tool, standard preset, subagent origin, dedicated namespace
    const createOpts = services.created.find((c) => c && c.sessionId)
    assert.match(createOpts.sessionId, /^hermes-loop-review-/)
    assert.equal(createOpts.meta.origin, 'subagent')
    assert.equal(createOpts.meta.agentPreset, 'standard')
    assert.match(createOpts.meta.cwd, /hermes-loop-home-/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('exclusions and gating: self/subagent/aborted never count, cooldown gates', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  let reviews = 0
  services.agents.create = async () => { reviews += 1; return { agent: fakeIdleAgent('{"action":"nothing"}'), dispose: async () => {} } }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 60, mode: 'log-only' }, services)
  const session = { id: 'session-gate', header: {}, deriveMessages: () => [] }
  t.fire({ id: 'hermes-loop-review-x', header: {} }, completedTurn) // own namespace
  t.fire({ id: 'session-sub', header: { origin: 'subagent' } }, completedTurn) // subagent
  t.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }) // aborted
  t.fire(session, { type: 'assistant/chunk' }) // unrelated event type
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(reviews, 0, 'no review for excluded sessions/events')
  t.fire(session, completedTurn) // 1st completed turn → fires (interval=1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(reviews, 1)
  t.fire(session, completedTurn) // inside 60min cooldown → no second review
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(reviews, 1)
})

test('tool/call window also triggers; disabled plugin stays silent', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 3, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-tools', header: {}, deriveMessages: () => [] }
  // tool 计数线与 Hermes 同构：计数随时累计，结算点仍在 turn 尾（不做 mid-turn 触发）
  t.fire(session, { type: 'tool/call' })
  t.fire(session, { type: 'tool/call' })
  t.fire(session, { type: 'tool/call' })
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(t.infos.every((m) => !m.includes('→ nothing')), 'no mid-turn trigger')
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(t.infos.some((m) => m.includes('→ nothing')), 'tool window fired at turn end', t.infos.join('|'))

  const silent = setupPlugin({ enabled: false }, services)
  silent.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(silent.infos.every((m) => !m.includes('log-only mode')))
})

test('unparseable conclusions are dropped with a warn, not written', async () => {
  const services = fakeServices('I think nothing is worth saving.')
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
  const session = { id: 'session-junk', header: {}, deriveMessages: () => [] }
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(t.warns.some((m) => m.includes('unparseable')), t.warns.join('|'))
})

function fakeIdleAgent(text) {
  return {
    session: { seq: 0, events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }] },
    followup() {}, whenIdle: async () => {}, cancel() {},
  }
}
