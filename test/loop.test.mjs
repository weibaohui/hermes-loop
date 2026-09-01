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
  sha256, buildSkillMd, mergeFrontmatter, applyConclusion, descriptionOf, DEFAULTS,
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
  const routes = []
  const ctx = {
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)) },
    on: (name, fn) => { handlers.push(fn); return () => {} },
    effect: (fn) => { cleanups.push(fn()) },
    skills: { snapshot: async () => ({ skills: [{ name: 'known-skill', description: 'a known skill about deploys', invocation: { modelInvocable: true } }], complete: true }) },
    // 静态注入契约：服务直接挂在 ctx 上；settings 缺席时走 config+defaults 回退
    settings: undefined,
    ...services,
  }
  // 宿主面动态注入 webServer（skills-management share-services 同款，已验证可用）
  const calls = ctx.inject ? [...ctx.inject] : []
  ctx.inject = (deps, cb) => { calls.push(deps); if (deps.includes('webServer')) cb({ webServer: { register: (route) => routes.push(route) } }) }
  plugin.apply(ctx, config)
  return {
    fire: (session, event) => { for (const h of handlers) h(session, event) },
    infos, warns, cleanups, routes,
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

// ── client API routes (fake webServer) ─────────────────────────────────

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.writeHead = (status) => { res.statusCode = status }
  res.end = (b) => { res.body = b }
  return res
}

test('GET /hermes-loop/api/status exposes settings, per-session counters and written skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-api-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(t.routes.length, 1)
    const route = t.routes[0]
    assert.equal(route.path, '/hermes-loop/api')
    const session = { id: 'session-api', header: {}, deriveMessages: () => [] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=session-api' }, res)
    const body = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.equal(body.settings.mode, 'log-only')
    assert.equal(body.current.turns, 0) // 已被 review 消耗重置
    assert.ok(body.sessions['session-api'].lastReviewAt > 0)
    assert.ok(Array.isArray(body.activity) && body.activity.length > 0)
    assert.ok(Array.isArray(body.written))
    const notFound = fakeRes()
    await route.handler({ method: 'GET', url: '/hermes-loop/api/nope' }, notFound)
    assert.equal(notFound.statusCode, 404)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('POST /hermes-loop/api/settings patches mode via settings scope', async () => {
  const updates = []
  const scope = { get: () => ({ mode: 'approval' }), update: async (patch) => { updates.push(patch) } }
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({ turnInterval: 5 }, { ...services, settings: { register: () => scope } })
  await new Promise((r) => setTimeout(r, 20))
  const route = t.routes[0]
  const res = fakeRes()
  await route.handler(reqBody({ patch: { mode: 'approval' } }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updates, [{ mode: 'approval' }])
  assert.equal(body.settings.mode, 'approval')
})

function reqBody(obj) {
  const data = JSON.stringify(obj)
  const req = new (require('node:events').EventEmitter)()
  req.method = 'POST'
  req.url = '/hermes-loop/api/settings'
  process.nextTick(() => { req.emit('data', Buffer.from(data)); req.emit('end') })
  return req
}
reqBody.__doc = 'returns a live EventEmitter; route.handler must attach listeners synchronously'

// ── loop-aware section: registers only when hermes-prompt is absent ────

test('loop-aware section registers when hermesPrompt marker is absent', () => {
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: () => undefined, // 无 hermes-prompt 标记
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    skills: { snapshot: async () => ({ skills: [] }) },
    settings: undefined,
  }
  plugin.apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'hermes:loop-aware')
  assert.equal(sections[0].order, 51)
})

test('loop-aware section is skipped when hermesPrompt marker is present', () => {
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (fn) => fn(),
    get: (name) => name === 'hermesPrompt' ? { version: '0.1.0' } : undefined,
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    skills: { snapshot: async () => ({ skills: [] }) },
    settings: undefined,
  }
  plugin.apply(ctx, {})
  assert.equal(sections.length, 0)
})

// ── source-session notice: appended as plugin notice on write ──────────

test('write outcomes echo a plugin-notice user/message into the source session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-echo-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const notices = []
    const conclusion = JSON.stringify({ action: 'create', skill: 'echo-skill', description: 'd', body: 'b', rationale: '值得存' })
    const services = fakeServices('```json\n' + conclusion + '\n```')
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = {
      id: 'session-echo',
      header: {},
      deriveMessages: () => [],
      append: (type, data) => { notices.push({ type, data }) },
    }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].type, 'user/message')
    assert.equal(notices[0].data.source.kind, 'plugin')
    assert.equal(notices[0].data.source.plugin, 'hermes-loop')
    assert.equal(notices[0].data.source.form, 'notice')
    assert.match(notices[0].data.source.summary, /echo-skill/)
    assert.match(notices[0].data.source.summary, /值得存/)
    // append 抛错不影响写入流程
    const sessionBroken = {
      id: 'session-echo-broken',
      header: {},
      deriveMessages: () => [],
      append() { throw new Error('append not allowed here') },
    }
    t.fire(sessionBroken, completedTurn)
    await new Promise((r) => setTimeout(r, 100))
    const written = await readFile(join(home, 'skills', 'echo-skill', 'SKILL.md'), 'utf8')
    assert.match(written, /^---/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

// ── manual review-now route ────────────────────────────────────────────

test('POST review-now starts a review for a live session, bypassing thresholds', async () => {
  const services = fakeServices('```json\n{"action":"nothing","rationale":"manual check"}\n```')
  const live = { id: 'session-manual', header: {}, deriveMessages: () => [] }
  const t = setupPlugin({ turnInterval: 999, cooldownMinutes: 999, mode: 'log-only' }, {
    ...services,
    sessions: { get: (sid) => sid === 'session-manual' ? live : undefined },
  })
  await new Promise((r) => setTimeout(r, 30))
  const route = t.routes[0]
  const post = (body) => new Promise((fulfil) => {
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    const req = new (require('node:events').EventEmitter)()
    req.method = 'POST'; req.url = '/hermes-loop/api/review-now'
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
    route.handler(req, res).then(() => fulfil({ status: res.statusCode, body: JSON.parse(res.body) }))
  })
  // 未知会话 → 404
  const missing = await post({ sessionId: 'session-ghost' })
  assert.equal(missing.status, 404)
  // 空 sessionId → 400
  const empty = await post({})
  assert.equal(empty.status, 400)
  // 正常触发：阈值远未达到也能立即复盘
  const ok = await post({ sessionId: 'session-manual' })
  assert.equal(ok.status, 202)
  assert.equal(ok.body.state, 'started')
  await new Promise((r) => setTimeout(r, 100))
  if (!t.infos.some((m) => m.includes('→ nothing'))) console.log('DEBUG infos:', t.infos, 'warns:', t.warns)
  assert.ok(t.infos.some((m) => m.includes('→ nothing')), 'manual review ran and concluded')
  // review 会话运行中重复点 → already-running（用阻塞 agent 模拟）
  let release
  const gate = new Promise((r) => { release = r })
  services.agents.create = async () => ({ agent: { ...fakeIdleAgent('{"action":"nothing"}'), whenIdle: () => gate }, dispose: async () => {} })
  const again = await post({ sessionId: 'session-manual' })
  assert.equal(again.body.state, 'started')
  await new Promise((r) => setTimeout(r, 30))
  const during = await post({ sessionId: 'session-manual' })
  assert.equal(during.body.state, 'already-running')
  release()
})

// ── skill usage statistics ─────────────────────────────────────────────

test('usage stats: skill tool/call counts, catalog exposure, persisted and exposed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-usage-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    const route = t.routes[0]
    const session = { id: 'session-usage', header: {}, deriveMessages: () => [] }
    // 模型调用 skill 工具两次（mac-a）+ 一次（mac-b）
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c1', arguments: JSON.stringify({ name: 'mac-a' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c2', arguments: JSON.stringify({ name: 'mac-a' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'skill', callId: 'c3', arguments: JSON.stringify({ name: 'mac-b' }) } })
    t.fire(session, { type: 'tool/call', data: { name: 'bash', callId: 'c4', arguments: '{}' } }) // 非 skill 工具不计数
    // 目录曝光（skill-catalog 注入）
    t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'catalog' }], source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'mac-a' }, { name: 'ghost-skill' }] } } })
    // 防抖冲洗
    await new Promise((r) => setTimeout(r, 5600))
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    await route.handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=session-usage' }, res)
    const body = JSON.parse(res.body)
    if (body.usage.totalCalls !== 3) console.log('DEBUG usage:', JSON.stringify(body.usage), 'warns:', t.warns, 'routes:', t.routes.length)
    assert.equal(body.usage.totalCalls, 3)
    assert.equal(body.usage.rows.find((r) => r.skill === 'mac-a').count, 2)
    assert.ok(body.usage.rows.find((r) => r.skill === 'mac-a').lastUsedAt)
    assert.equal(body.usage.rows.find((r) => r.skill === 'ghost-skill').count, 0) // 只曝光未调用
    assert.equal(body.usage.neverCalled, 1)
    assert.equal(body.usage.catalogEntries, 2)
    // 持久化文件
    const saved = JSON.parse(await readFile(join(home, 'hermes-loop', 'usage.json'), 'utf8'))
    assert.equal(saved.usage['mac-a'].count, 2)
    assert.equal(saved.catalog['ghost-skill'].count, 1)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('usage stats survive a restart (loaded from usage.json)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-usage2-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({ savedAt: 'x', usage: { 'old-skill': { count: 7, lastUsedAt: '2026-08-01T00:00:00.000Z', lastSessionId: 's1' } }, catalog: {} }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    await new Promise((r) => setTimeout(r, 30))
    const res = { statusCode: null, body: null, writeHead(s) { this.statusCode = s }, end(b) { this.body = b } }
    await t.routes[0].handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=' }, res)
    const row = JSON.parse(res.body).usage.rows.find((r) => r.skill === 'old-skill')
    assert.equal(row.count, 7)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('mergeFrontmatter preserves governance keys (disable-model-invocation etc.) on patch', async () => {
  const dir = await tempGlobalDir()
  try {
    await mkdir(join(dir, 'governed'), { recursive: true })
    const original = '---\nname: "governed"\ndescription: "orig"\ndisable-model-invocation: true\nversion: "1.2"\n---\n\nbody v1\n'
    await writeFile(join(dir, 'governed', 'SKILL.md'), original)
    const ok = await applyConclusion(
      { action: 'patch', skill: 'governed', body: 'body v2', baseHash: sha256(original), baseDescription: 'orig' },
      { globalDir: dir })
    assert.equal(ok.result, 'patched')
    const after = await readFile(join(dir, 'governed', 'SKILL.md'), 'utf8')
    assert.match(after, /disable-model-invocation: true/)
    assert.match(after, /version: "1\.2"/)
    assert.match(after, /body v2/)
    assert.equal(descriptionOf(after), 'orig')
    // 纯函数：无 frontmatter 的内容回退为新建
    const fresh = mergeFrontmatter('plain body', 'x', 'd', 'nb')
    assert.match(fresh, /nb/)
    assert.match(fresh, /^---\nname: "x"/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── Curator: setModelInvocation + curatorTransitions (pure) ─────────────

const { setModelInvocation, curatorTransitions } = plugin.__internals

test('setModelInvocation toggles disable-model-invocation, preserving other keys and body', () => {
  const base = '---\nname: "s"\ndescription: "d"\nversion: "1"\n---\n\nbody text\n'
  const off = setModelInvocation(base, false)
  assert.match(off, /disable-model-invocation: true/)
  assert.match(off, /version: "1"/)
  assert.match(off, /body text/)
  const on = setModelInvocation(off, true)
  assert.doesNotMatch(on, /disable-model-invocation/)
  assert.match(on, /version: "1"/)
  assert.match(on, /body text/)
  // 无 frontmatter：关=补一块，开=原样
  assert.match(setModelInvocation('no front', false), /^---\ndisable-model-invocation: true\n---\n\nno front/)
  assert.equal(setModelInvocation('no front', true), 'no front')
  // 幂等：重复关不叠加键
  const offTwice = setModelInvocation(off, false)
  assert.equal(offTwice.split('disable-model-invocation').length - 1, 1)
})

test('curatorTransitions: grace / stale / archive / revive / no-auto-unarchive / NaN safety', () => {
  const NOW = '2026-08-30T00:00:00.000Z'
  const days = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString()
  const opts = { now: NOW, staleDays: 30, archiveDays: 90 }
  const run = (records, usage = {}) => curatorTransitions(
    new Map(Object.entries(records)),
    new Map(Object.entries(usage)),
    opts)
  // 零调用且创建不足 30 天 → 宽限，不动
  assert.equal(run({ 'fresh': { createdAt: days(3), state: 'active' } }).length, 0)
  // 零调用但创建超过 90 天 → 直接归档（宽限只挡到 stale 线）
  assert.deepEqual(run({ 'old-virgin': { createdAt: days(100), state: 'active' } }),
    [{ skill: 'old-virgin', from: 'active', to: 'archived', reason: 'archive' }])
  // 40 天前用过 → stale（只标记）
  assert.deepEqual(run({ 'mid': { createdAt: days(100), state: 'active' } }, { mid: { count: 2, lastUsedAt: days(40) } }),
    [{ skill: 'mid', from: 'active', to: 'stale', reason: 'stale' }])
  // 已 stale 且仍 40 天 → 无重复转移
  assert.equal(run({ 'mid': { createdAt: days(100), state: 'stale' } }, { mid: { count: 2, lastUsedAt: days(40) } }).length, 0)
  // stale 期间又被用到 → 复活
  assert.deepEqual(run({ 'mid': { createdAt: days(100), state: 'stale' } }, { mid: { count: 3, lastUsedAt: days(1) } }),
    [{ skill: 'mid', from: 'stale', to: 'active', reason: 'revive' }])
  // active 且 100 天前用过 → 直接 archived
  assert.deepEqual(run({ 'dead': { createdAt: days(200), state: 'active' } }, { dead: { count: 5, lastUsedAt: days(100) } }),
    [{ skill: 'dead', from: 'active', to: 'archived', reason: 'archive' }])
  // archived 无自动出口——昨天被用过也不复活（恢复只能走 restore 路由）
  assert.equal(run({ 'dead': { createdAt: days(200), state: 'archived' } }, { dead: { count: 9, lastUsedAt: days(1) } }).length, 0)
  // lastRestoredAt 顶 anchor：恢复后不会再立刻归档
  assert.equal(run({ 'dead': { createdAt: days(200), state: 'active', lastRestoredAt: days(1) } }).length, 0)
  // 坏时间戳 fail-safe：不转移
  assert.equal(run({ 'broken': { createdAt: 'not-a-date', state: 'active' } }).length, 0)
})

// ── Curator routes e2e: run → archived + flag flipped; restore → flag removed ──

function postJson(url, obj) {
  const req = new (require('node:events').EventEmitter)()
  req.method = 'POST'
  req.url = url
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(obj))); req.emit('end') })
  return req
}

test('curator: manual pass archives an aged managed skill (flag flip), restore reverses it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-curator-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const days = (n) => new Date(Date.now() - n * 86400000).toISOString()
    // 纳管技能落盘 + usage.json 种子（lastRunAt 置新，避免加载时的惰性 pass 抢先跑）
    await mkdir(join(home, 'skills', 'old-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'old-skill', 'SKILL.md'), '---\nname: "old-skill"\ndescription: "aged"\n---\n\naged body\n')
    await mkdir(join(home, 'skills', 'mid-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'mid-skill', 'SKILL.md'), '---\nname: "mid-skill"\ndescription: "stale-ish"\n---\n\nmid body\n')
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({
      savedAt: days(0),
      usage: {
        'old-skill': { count: 3, lastUsedAt: days(100) },
        'mid-skill': { count: 2, lastUsedAt: days(40) },
      },
      catalog: {},
      curator: {
        lastRunAt: days(0), runCount: 1, lastSummary: 'seed',
        skills: {
          'old-skill': { createdAt: days(200), state: 'active' },
          'mid-skill': { createdAt: days(200), state: 'active' },
        },
      },
    }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({}, services)
    await new Promise((r) => setTimeout(r, 50)) // usageLoaded
    const route = t.routes[0]

    // 巡检：old → archived（文件翻键），mid → stale（文件不动）
    const runRes = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/run', {}), runRes)
    assert.equal(runRes.statusCode, 200)
    const report = JSON.parse(runRes.body).report
    assert.deepEqual(report.transitions.map((x) => [x.skill, x.to]).sort(),
      [['mid-skill', 'stale'], ['old-skill', 'archived']])
    assert.match(await readFile(join(home, 'skills', 'old-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/)
    assert.doesNotMatch(await readFile(join(home, 'skills', 'mid-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation/)

    // status 快照透出状态与计数
    const statusRes = fakeRes()
    await route.handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=' }, statusRes)
    const curator = JSON.parse(statusRes.body).curator
    assert.equal(curator.counts.archived, 1)
    assert.equal(curator.counts.stale, 1)
    assert.equal(curator.skills.find((r) => r.skill === 'old-skill').state, 'archived')

    // 恢复：移除治理键 + 状态回 active + lastRestoredAt 顶住再归档
    const restoreRes = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/restore', { name: 'old-skill' }), restoreRes)
    assert.equal(restoreRes.statusCode, 200)
    assert.doesNotMatch(await readFile(join(home, 'skills', 'old-skill', 'SKILL.md'), 'utf8'), /disable-model-invocation/)
    const rerunRes = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/run', {}), rerunRes)
    assert.equal(JSON.parse(rerunRes.body).report.transitions.length, 0, 'restored skill must not re-archive next pass')

    // 错误路径：非纳管 404，非归档 400，坏名字 400
    const unknown = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/restore', { name: 'ghost' }), unknown)
    assert.equal(unknown.statusCode, 404)
    const notArchived = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/restore', { name: 'old-skill' }), notArchived)
    assert.equal(notArchived.statusCode, 400)
    const badName = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/restore', { name: 'Bad Name' }), badName)
    assert.equal(badName.statusCode, 400)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('curator: pre-existing plugin-created skills are backfilled from the audit ledger', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-backfill-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 存量：审计账本里有两条 created 记录；legacy-1 的文件还在，ghost-2 的文件被用户删了
    await mkdir(join(home, 'skills', 'legacy-1'), { recursive: true })
    await writeFile(join(home, 'skills', 'legacy-1', 'SKILL.md'), '---\nname: "legacy-1"\ndescription: "old"\n---\n\nbody\n')
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'activity.jsonl'), [
      JSON.stringify({ at: '2026-08-28T15:00:00.000Z', event: 'write-outcome', skill: 'legacy-1', result: 'created', path: '/x' }),
      JSON.stringify({ at: '2026-08-28T16:00:00.000Z', event: 'write-outcome', skill: 'ghost-2', result: 'created', path: '/y' }),
      JSON.stringify({ at: '2026-08-29T00:00:00.000Z', event: 'write-outcome', skill: 'legacy-1', result: 'patched', path: '/x' }),
    ].join('\n') + '\n')
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({}, services)
    await new Promise((r) => setTimeout(r, 80)) // usageLoaded + backfill
    const res = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=' }, res)
    const skills = JSON.parse(res.body).curator.skills
    const legacy = skills.find((r) => r.skill === 'legacy-1')
    assert.ok(legacy, 'audit-ledger created skill must be backfilled into the managed set')
    assert.equal(legacy.createdAt, '2026-08-28T15:00:00.000Z')
    assert.equal(legacy.state, 'active')
    assert.ok(!skills.some((r) => r.skill === 'ghost-2'), 'deleted skill must not be managed (no ghosts)')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('curator: disabled setting skips the pass; created conclusions get registered as managed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-curator2-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ curatorEnabled: false }, services)
    await new Promise((r) => setTimeout(r, 30))
    const route = t.routes[0]
    const runRes = fakeRes()
    await route.handler(postJson('/hermes-loop/api/curator/run', {}), runRes)
    assert.equal(JSON.parse(runRes.body).report.skipped, 'disabled')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }

  const home2 = await mkdtemp(join(tmpdir(), 'hermes-loop-curator3-'))
  process.env.DSH_HOME = home2
  try {
    const conclusion = JSON.stringify({ action: 'create', skill: 'curator-e2e', description: 'd', body: 'b' })
    const services = fakeServices('```json\n' + conclusion + '\n```')
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-cur', header: {}, deriveMessages: () => [] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    const statusRes = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=' }, statusRes)
    const row = JSON.parse(statusRes.body).curator.skills.find((r) => r.skill === 'curator-e2e')
    assert.ok(row, 'created skill must enter the managed set')
    assert.equal(row.state, 'active')
  } finally {
    process.env.DSH_HOME = oldHome
    await rm(home2, { recursive: true, force: true })
  }
})

// ── signal-accelerated triggering (v0.4) ─────────────────────────────────

function countingServices() {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const counter = { reviews: 0 }
  services.agents.create = async () => { counter.reviews += 1; return { agent: fakeIdleAgent('{"action":"nothing"}'), dispose: async () => {} } }
  return { services, counter }
}

test('signal: aborted turn accelerates the next completed turn below threshold', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-sig-abort', header: {}, deriveMessages: () => [] }
  t.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(counter.reviews, 0, 'abort marks the window but never fires mid-turn')
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'accelerated window fires at the next completed turn despite thresholds')
  // 信号已被消费：再来一个 completed turn（仍低于阈值）不再触发
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'signal is consumed by the review it fired')
})

test('signal: tool failure burst accelerates at the configured minimum', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalToolFailureMin: 3 }, services)
  const session = { id: 'session-sig-fail', header: {}, deriveMessages: () => [] }
  const okResult = { type: 'tool/result', data: { message: { isError: false, content: [] } } }
  const failResult = { type: 'tool/result', data: { message: { isError: true, content: [] } } }
  t.fire(session, failResult)
  t.fire(session, okResult) // 成功结果不计数
  t.fire(session, failResult)
  t.fire(session, completedTurn) // 只有 2 次失败，未到阈值 → 不触发
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'below the failure minimum: no acceleration')
  t.fire(session, failResult) // 第 3 次失败 → 窗口标记
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'third failure accelerates')
})

test('signal: correction words only count real user input, not plugin notices', async () => {
  const { services, counter } = countingServices()
  const t = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, services)
  const session = { id: 'session-sig-word', header: {}, deriveMessages: () => [] }
  // 我们自己的回显（kind=plugin）和目录注入（kind=skill-catalog）绝不算用户纠正
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '这个结果不对吧' }], source: { kind: 'plugin' } } })
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对' }], source: { kind: 'skill-catalog', entries: [] } } })
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'plugin/catalog messages must not accelerate')
  t.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对，重来' }], source: { kind: 'user' } } })
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(counter.reviews, 1, 'correction word in a real user message accelerates')
})

test('signal: master switch disables all acceleration; cooldown still gates signals', async () => {
  const { services, counter } = countingServices()
  const off = setupPlugin({ turnInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalTriggerEnabled: false }, services)
  const session = { id: 'session-sig-off', header: {}, deriveMessages: () => [] }
  off.fire(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  off.fire(session, { type: 'user/message', data: { content: [{ type: 'text', text: '不对' }], source: { kind: 'user' } } })
  off.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counter.reviews, 0, 'signalTriggerEnabled=false disables every signal kind')

  // 冷却仍生效：先正常触发一次复盘（turnInterval=1），随后信号命中，
  // 冷却期内的 completed turn 不能点火
  const gated = countingServices()
  const t2 = setupPlugin({ turnInterval: 1, cooldownMinutes: 60, mode: 'log-only' }, gated.services)
  const s2 = { id: 'session-sig-cool', header: {}, deriveMessages: () => [] }
  t2.fire(s2, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(gated.counter.reviews, 1)
  t2.fire(s2, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }) // 信号命中
  t2.fire(s2, completedTurn) // 冷却中 → 不应触发
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(gated.counter.reviews, 1, 'cooldown gates signal-accelerated reviews too')
})

test('parseCorrectionWords splits comma/enumeration separators and lowercases', () => {
  const { parseCorrectionWords, matchCorrectionWord } = plugin.__internals
  assert.deepEqual(parseCorrectionWords('不对, Wrong， 重来；;Try Again\n别这样'), ['不对', 'wrong', '重来', 'try again', '别这样'])
  assert.equal(matchCorrectionWord('你这个结果 Wrong 吧', parseCorrectionWords('wrong')), 'wrong')
  assert.equal(matchCorrectionWord('完全正常', parseCorrectionWords('不对,错了')), undefined)
})

// ── 审查修复回归（2026-08-30 code review round）─────────────────────────

test('review fix: patch succeeds for skills with description longer than the catalog cap', async () => {
  // 回归 P1-1：baseDescription 曾用目录截断值做 CAS 基准，长描述技能永远 cas-conflict
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-longdesc-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const longDesc = 'd'.repeat(600) // 超过 catalogDescriptionMax 默认 500
    const skillDir = join(home, 'skills', 'long-desc-skill')
    await mkdir(skillDir, { recursive: true })
    const original = `---\nname: "long-desc-skill"\ndescription: "${longDesc}"\n---\n\noriginal body\n`
    await writeFile(join(skillDir, 'SKILL.md'), original)
    const conclusion = JSON.stringify({
      action: 'patch', skill: 'long-desc-skill', body: 'patched body',
      baseHash: sha256(original), baseDescription: longDesc,
    })
    const services = fakeServices('```json\n' + conclusion + '\n```')
    // snapshot 返回目录截断后的 description（复现真实环境），resourceBase 在全局库内
    services.skills = {
      snapshot: async () => ({ skills: [{ name: 'long-desc-skill', description: longDesc.slice(0, 500), resourceBase: { kind: 'directory', path: skillDir }, invocation: { modelInvocable: true } }], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, services)
    const session = { id: 'session-longdesc', header: {}, deriveMessages: () => [{ role: 'user', content: 'we used long-desc-skill today' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 120))
    assert.match(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), /patched body/, 'long-description skill must be patchable')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: project-level suspects are not injected (writer only knows the global library)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-proj-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    services.skills = {
      snapshot: async () => ({ skills: [{ name: 'proj-skill', description: 'project scoped', resourceBase: { kind: 'directory', path: join(home, 'project', '.dsh', 'skills', 'proj-skill') }, invocation: { modelInvocable: true } }], complete: true }),
    }
    const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
    const session = { id: 'session-proj', header: {}, deriveMessages: () => [{ role: 'user', content: 'used proj-skill here' }] }
    t.fire(session, completedTurn)
    await new Promise((r) => setTimeout(r, 80))
    const followup = services.created.find((c) => c && c.content)
    const prompt = followup.content[0].text
    assert.ok(!prompt.includes('### suspect:'), 'project-level skill must not be injected as a suspect (patch would be guaranteed patch-missing)')
    assert.ok(prompt.includes('proj-skill'), 'catalog listing still includes it')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: usage.json load merges with in-memory increments instead of clobbering', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-merge-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'hermes-loop'), { recursive: true })
    await writeFile(join(home, 'hermes-loop', 'usage.json'), JSON.stringify({
      savedAt: 'x',
      usage: { 'merge-skill': { count: 7, lastUsedAt: '2026-08-01T00:00:00.000Z' } },
      catalog: {},
    }))
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    const t = setupPlugin({ turnInterval: 999, mode: 'log-only' }, services)
    const session = { id: 'session-merge', header: {}, deriveMessages: () => [] }
    // 加载 resolve 之前就可能到达的事件（竞态窗口）
    t.fire(session, { type: 'tool/call', data: { name: 'skill', arguments: JSON.stringify({ name: 'merge-skill' }) } })
    await new Promise((r) => setTimeout(r, 60))
    const res = fakeRes()
    await t.routes[0].handler({ method: 'GET', url: '/hermes-loop/api/status?sessionId=' }, res)
    assert.equal(JSON.parse(res.body).usage.rows.find((r) => r.skill === 'merge-skill').count, 8,
      'in-memory increment during the load window must survive the disk load')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('review fix: two same-tick thresholds never run concurrently (serial invariant)', async () => {
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  let inFlight = 0
  let maxInFlight = 0
  let gate
  const hold = new Promise((r) => { gate = r })
  let created = 0
  services.agents.create = async () => {
    created += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return {
      agent: {
        session: { seq: 0, events: [{ seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"nothing"}' }] } } }] },
        followup() {},
        whenIdle: () => (created === 1 ? hold : Promise.resolve()), // 第一个复盘吊住
        cancel() {},
      },
      dispose: async () => { inFlight -= 1 },
    }
  }
  const t = setupPlugin({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, services)
  const s1 = { id: 'session-serial-1', header: {}, deriveMessages: () => [] }
  const s2 = { id: 'session-serial-2', header: {}, deriveMessages: () => [] }
  // 同一同步调用栈连发两个阈值命中——微任务间隙曾是串行不变量的破口
  t.fire(s1, completedTurn)
  t.fire(s2, completedTurn)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(created, 1, 'second review must queue, not start')
  assert.equal(maxInFlight, 1)
  gate() // 放行第一个 → drainNext 接力第二个
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(created, 2, 'queued review runs after the first finishes')
  assert.equal(maxInFlight, 1, 'never concurrent')
})

test('review fix: settings fallback path validates instead of raw Object.assign', async () => {
  const { sanitizeSettingsPatch } = plugin.__internals
  assert.deepEqual(sanitizeSettingsPatch({ mode: 'typo', turnInterval: 0, cooldownMinutes: -5 }), {})
  assert.deepEqual(sanitizeSettingsPatch({ mode: 'approval', turnInterval: 3 }), { mode: 'approval', turnInterval: 3 })
  // 路由级：无 settings scope 时非法 patch 不生效
  const services = fakeServices('```json\n{"action":"nothing"}\n```')
  const t = setupPlugin({}, services) // settings: undefined → 回退路径
  await new Promise((r) => setTimeout(r, 30))
  const res = fakeRes()
  await t.routes[0].handler(postJson('/hermes-loop/api/settings', { patch: { mode: 'typo', cooldownMinutes: -1 } }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.settings.mode, 'auto', 'invalid mode must not fall into the auto write branch silently')
  assert.equal(body.settings.cooldownMinutes, 30, 'out-of-range numbers rejected')
})

test('review fix: overlong description is truncated, not dropped (fail-closed stays for body)', () => {
  const c = parseConclusion(JSON.stringify({ action: 'create', skill: 'long-desc', description: 'x'.repeat(600), body: 'b' }))
  assert.ok(c, 'conclusion survives an overlong description')
  assert.equal(c.description.length, 500)
  assert.equal(parseConclusion(JSON.stringify({ action: 'create', skill: 'x', description: 'd', body: 'y'.repeat(129 * 1024) })), undefined, 'oversized body still fail-closed')
})

// ── Memory 通道（design §12，v0.5）──────────────────────────────────────

const {
  parseMemoryEntries, serializeMemoryEntries, planMemoryChange, scanMemoryEntry,
  applyMemoryConclusion, renderMemoryContext, memoryStoreFile,
} = plugin.__internals

test('memory store: parse/serialize round-trips § entries, ignores noise, flattens newlines', () => {
  const raw = '# MEMORY\n\n§ first entry\nsome handwritten note\n\n§ second entry\n'
  assert.deepEqual(parseMemoryEntries(raw), ['first entry', 'second entry'])
  assert.equal(serializeMemoryEntries('memory', ['a', 'b']), '# MEMORY\n\n§ a\n§ b\n')
  assert.equal(serializeMemoryEntries('user', []), '# USER\n\n')
  // 条目内换行折叠成空格：格式钉死一行一条
  assert.equal(parseMemoryEntries(serializeMemoryEntries('memory', ['x\ny']))[0], 'x y')
})

test('memory scan rejects invisible unicode, control chars and credential patterns', () => {
  assert.equal(scanMemoryEntry('normal entry about deploys'), null)
  assert.equal(scanMemoryEntry('has\u200Bzero-width'), 'invisible-unicode')
  assert.equal(scanMemoryEntry('bad\u0007bell'), 'control-char')
  assert.equal(scanMemoryEntry('the key is sk-abcdefghijklmnop123456 ok'), 'credential-pattern')
  assert.equal(scanMemoryEntry('password=hunter2'), 'credential-pattern')
})

test('planMemoryChange: add appends; duplicate / scan / over-limit rejections (§12.4 ①②③)', () => {
  const base = ['existing entry']
  const ok = planMemoryChange(base, { action: 'add', text: 'fresh fact' }, { limit: 2200 })
  assert.equal(ok.ok, true)
  assert.equal(ok.result, 'added')
  assert.deepEqual(ok.entries, ['existing entry', 'fresh fact'])
  // ① 去重——规范化空白后相同即拒绝
  const dup = planMemoryChange(base, { action: 'add', text: 'existing   entry' }, { limit: 2200 })
  assert.equal(dup.ok, false)
  assert.equal(dup.reason, 'duplicate')
  // ② 扫描
  const scanned = planMemoryChange(base, { action: 'add', text: 'tok\u200Ben looks fine' }, { limit: 2200 })
  assert.equal(scanned.ok, false)
  assert.equal(scanned.reason, 'invisible-unicode')
  // ③ 限额：超限拒绝（不连坐 skill 由 dispatch 通道隔离保证）
  const over = planMemoryChange(base, { action: 'add', text: 'x'.repeat(50) }, { limit: 20 })
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'over-limit')
})

test('planMemoryChange: replace/remove need oldText to hit exactly one entry (§12.4 ④)', () => {
  const base = ['alpha one', 'beta two']
  const rep = planMemoryChange(base, { action: 'replace', oldText: 'beta', text: 'beta three' }, { limit: 2200 })
  assert.equal(rep.ok, true)
  assert.equal(rep.result, 'replaced')
  assert.deepEqual(rep.entries, ['alpha one', 'beta three'])
  const amb = planMemoryChange(base, { action: 'remove', oldText: 'a' }, { limit: 2200 }) // 命中两条
  assert.equal(amb.ok, false)
  assert.equal(amb.reason, 'old-text-ambiguous')
  const miss = planMemoryChange(base, { action: 'remove', oldText: 'gamma' }, { limit: 2200 })
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'old-text-missing')
  const rem = planMemoryChange(base, { action: 'remove', oldText: 'alpha one' }, { limit: 2200 })
  assert.equal(rem.ok, true)
  assert.deepEqual(rem.entries, ['beta two'])
})

test('parseConclusion: memory rides along; malformed memory drops without touching the skill conclusion', () => {
  const both = parseConclusion('{"action":"create","skill":"a-b","description":"d","body":"b","memory":{"action":"add","store":"memory","text":"fact","rationale":"r"}}')
  assert.equal(both.memory.action, 'add')
  assert.equal(both.memory.store, 'memory')
  // skill=nothing 但 memory 有效 → memory 保留（通道独立）
  const memOnly = parseConclusion('{"action":"nothing","memory":{"action":"add","store":"user","text":"likes terse answers"}}')
  assert.equal(memOnly.action, 'nothing')
  assert.equal(memOnly.memory.text, 'likes terse answers')
  // 畸形 memory（store 非法）只丢 memory
  const badStore = parseConclusion('{"action":"create","skill":"a-b","description":"d","body":"b","memory":{"action":"add","store":"galaxy","text":"x"}}')
  assert.equal(badStore.memory, undefined)
  // remove 缺 oldText → 丢 memory
  const noOld = parseConclusion('{"action":"nothing","memory":{"action":"remove","store":"memory"}}')
  assert.equal(noOld.memory, undefined)
  // 无 memory 字段 → undefined
  assert.equal(parseConclusion('{"action":"nothing"}').memory, undefined)
  // 超长 text 截断到 500（description 截断同款纪律）
  const long = parseConclusion('{"action":"nothing","memory":{"action":"add","store":"memory","text":"' + 'x'.repeat(600) + '"}}')
  assert.equal(long.memory.text.length, 500)
})

test('renderMemoryContext renders per-store usage; empty stores / all-disabled yield empty string', () => {
  const eff = { memoryEnabled: true, userProfileEnabled: true, memoryCharLimit: 2200, userCharLimit: 1375 }
  const readRaw = (store) => (store === 'memory' ? '# MEMORY\n\n§ fact one\n§ fact two\n' : '')
  const out = renderMemoryContext(eff, readRaw)
  assert.match(out, /长期记忆/)
  assert.match(out, /MEMORY（环境\/项目事实\/约定\/教训） — 16\/2200 字符 · 2 条/)
  assert.match(out, /§ fact one/)
  assert.doesNotMatch(out, /USER（用户画像/) // 空库整节不出现
  assert.equal(renderMemoryContext({ ...eff, memoryEnabled: false, userProfileEnabled: false }, readRaw), '')
  assert.equal(renderMemoryContext(eff, () => ''), '')
})

test('applyMemoryConclusion: add/dup/replace/remove land in dir; store-disabled short-circuits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-loop-mem-'))
  try {
    const limits = { memory: 2200, user: 1375 }
    const enabled = { memory: true, user: false }
    const add = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'publish needs otp' }, { dir, limits, enabled })
    assert.equal(add.result, 'added')
    assert.equal(add.entries, 1)
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /^# MEMORY\n\n§ publish needs otp\n$/)
    const dup = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'publish needs otp' }, { dir, limits, enabled })
    assert.equal(dup.result, 'rejected')
    assert.equal(dup.reason, 'duplicate')
    const rep = await applyMemoryConclusion({ action: 'replace', store: 'memory', oldText: 'publish needs otp', text: 'publish must use otp' }, { dir, limits, enabled })
    assert.equal(rep.result, 'replaced')
    assert.match(await readFile(join(dir, 'MEMORY.md'), 'utf8'), /publish must use otp/)
    const dis = await applyMemoryConclusion({ action: 'add', store: 'user', text: 'x' }, { dir, limits, enabled })
    assert.equal(dis.result, 'store-disabled')
    const over = await applyMemoryConclusion({ action: 'add', store: 'memory', text: 'y'.repeat(3000) }, { dir, limits, enabled })
    assert.equal(over.result, 'rejected')
    assert.equal(over.reason, 'over-limit')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('memory context: session-frozen snapshots (Hermes semantics) — mid-session writes only visible to new sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-memctx-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const contexts = []
    const sections = []
    const services = fakeServices('```json\n{"action":"nothing"}\n```')
    services.systemPrompt = { section: (s) => sections.push(s), context: (c) => contexts.push(c) }
    setupPlugin({ turnInterval: 999 }, services)
    const memCtx = contexts.find((c) => c.name === 'hermes:memory')
    assert.ok(memCtx, 'hermes:memory context registered')
    assert.equal(typeof memCtx.text, 'function')
    await mkdir(join(home, 'memory'), { recursive: true })
    // 无 scope 的调用（非常规/旧路径）：现算不冻结
    assert.equal(memCtx.text(), '')
    // ── 会话首冻结（§12.2，Hermes 语义）：scope 即 agent 对象，一会话一快照 ──
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ durable fact\n')
    const scopeA = { tag: 'session-A' }
    assert.match(memCtx.text({ scope: scopeA }), /§ durable fact/)
    // 会话中途写入：scopeA 冻结在开局快照，看不到新条目
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ durable fact\n§ second fact\n')
    assert.doesNotMatch(memCtx.text({ scope: scopeA }), /second fact/, 'frozen snapshot ignores mid-session writes')
    // 下个会话（新 scope）读到的才是新内容
    assert.match(memCtx.text({ scope: { tag: 'session-B' } }), /§ second fact/)
    // 空快照同样冻结：开局空库的会话不会因中途写入突然出现记忆
    const scopeC = { tag: 'session-C' }
    await rm(join(home, 'memory', 'MEMORY.md'))
    assert.equal(memCtx.text({ scope: scopeC }), '')
    await writeFile(join(home, 'memory', 'MEMORY.md'), '# MEMORY\n\n§ late fact\n')
    assert.equal(memCtx.text({ scope: scopeC }), '', 'empty snapshot stays frozen for the whole session')
    // 读盘故障（EISDIR）：该会话以空快照冻结，绝不抛
    await rm(join(home, 'memory', 'MEMORY.md'))
    await mkdir(join(home, 'memory', 'MEMORY.md'))
    assert.equal(memCtx.text({ scope: { tag: 'session-D' } }), '')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

async function runE2E(config, conclusionText) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-loop-mem-e2e-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const notices = []
  const services = fakeServices('```json\n' + conclusionText + '\n```')
  const t = setupPlugin(config, services)
  const session = {
    id: 'session-mem-e2e',
    header: {},
    deriveMessages: () => [{ role: 'user', content: 'do the thing' }],
    append: (type, data) => notices.push(data),
  }
  t.fire(session, completedTurn)
  await new Promise((r) => setTimeout(r, 90))
  const followup = services.created.find((c) => c && c.content)
  return { home, oldHome, notices, t, followup }
}

test('memory e2e: skill=nothing with memory add writes USER.md, echoes a notice, injects entries into the review prompt', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', rationale: 'no skill this time', memory: { action: 'add', store: 'user', text: 'user prefers terse answers', rationale: 'said 直接给答案' } })
  const { home, oldHome, notices, followup } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    assert.match(await readFile(join(home, 'memory', 'USER.md'), 'utf8'), /§ user prefers terse answers/)
    assert.ok(notices.some((n) => n.source && n.source.form === 'notice' && n.source.summary.includes('记忆')), notices.map((n) => n.source && n.source.summary).join('|'))
    assert.ok(notices.some((n) => n.source.summary.includes('下个会话生效')), 'echo must state next-session semantics')
    // 当前记忆条目注入 review prompt（oldText 定位与去重的基准）+ 记忆规则段（按需产出）
    assert.ok(JSON.stringify(followup).includes('当前记忆条目'))
    assert.ok(JSON.stringify(followup).includes('多数复盘应该没有记忆'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('memory e2e: combined conclusion writes skill AND memory; guards only reject their own channel', async () => {
  const conclusion = JSON.stringify({
    action: 'create', skill: 'mem-e2e-skill', description: 'has both channels', body: 'body here',
    memory: { action: 'add', store: 'memory', text: 'deploy needs otp' },
  })
  const { home, oldHome } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    assert.match(await readFile(join(home, 'skills', 'mem-e2e-skill', 'SKILL.md'), 'utf8'), /body here/)
    assert.match(await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8'), /§ deploy needs otp/)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('memory e2e: log-only logs the memory conclusion without touching disk; approval stages a pending JSON', async () => {
  const mkConclusion = () => JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'web runs on 19080' } })
  // log-only
  {
    const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'log-only' }, mkConclusion())
    try {
      assert.ok(t.infos.some((m) => m.includes('log-only') && m.includes('memory')), t.infos.join('|'))
      let absent = false
      try { await readFile(join(home, 'memory', 'MEMORY.md'), 'utf8') } catch { absent = true }
      assert.ok(absent, 'log-only must not write memory files')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  }
  // approval：纯记忆结论也有稳定 pending 标识与 memoryDir 提示
  {
    const { home, oldHome } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'approval' }, mkConclusion())
    try {
      const { readdir } = await import('node:fs/promises')
      const staged = await readdir(join(home, 'hermes-loop', 'pending'))
      assert.equal(staged.length, 1)
      assert.match(staged[0], /-memory-memory\.json$/)  // `${ts36}-memory-${store}` 后缀
      const payload = JSON.parse(await readFile(join(home, 'hermes-loop', 'pending', staged[0]), 'utf8'))
      assert.equal(payload.memoryDir, join(home, 'memory'))
      assert.equal(payload.conclusion.memory.text, 'web runs on 19080')
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('GET status exposes memory stores (enabled/chars/limit/entries) and the last memory outcome', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'fact for status' } })
  const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    const route = t.routes[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/hermes-loop/api/status' }, res)
    const body = JSON.parse(res.body)
    assert.equal(res.statusCode, 200)
    assert.ok(body.memory && body.memory.stores)
    const mem = body.memory.stores.memory
    assert.equal(mem.enabled, true)
    assert.equal(mem.chars, 'fact for status'.length)
    assert.equal(mem.limit, 2200)
    assert.equal(mem.entries, 1)
    assert.ok(mem.lastWriteAt, 'lastWriteAt fed from the memory-outcome audit record')
    assert.equal(body.memory.stores.user.entries, 0)
    assert.equal(body.memory.lastOutcome.result, 'added')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})

test('v0.5 追加：默认纠正词表含「记住,记忆」持久化意图词，不含「总结」', () => {
  const words = plugin.__internals.parseCorrectionWords(DEFAULTS.signalCorrectionWords)
  assert.ok(words.includes('记住') && words.includes('记忆'))
  assert.ok(!words.includes('总结'), '总结 too common — deliberately excluded')
  assert.ok(!words.includes('wrong ') && words.includes('wrong'))
})

test('v0.5 追加：默认词表下「记住：X」命中信号提前复盘，「总结一下」不触发', async () => {
  const fire1 = countingServices()
  const t1 = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only' }, fire1.services)
  const s = { id: 'session-remember', header: {}, deriveMessages: () => [] }
  // 不传 signalCorrectionWords → 用 DEFAULTS（含记住/记忆）
  t1.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '帮我记住：web 跑在 19080' }], source: { kind: 'user' } } })
  t1.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire1.counter.reviews, 1, '记住 in default word list accelerates the review')
  t1.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '总结一下这段代码' }], source: { kind: 'user' } } })
  t1.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire1.counter.reviews, 1, '总结 stays out of the default list; cooldown would gate anyway')

  const fire2 = countingServices()
  const t2 = setupPlugin({ turnInterval: 999, toolCallInterval: 999, cooldownMinutes: 0, mode: 'log-only', signalCorrectionWords: '不对,错了' }, fire2.services)
  t2.fire(s, { type: 'user/message', data: { content: [{ type: 'text', text: '记住这个' }], source: { kind: 'user' } } })
  t2.fire(s, completedTurn)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fire2.counter.reviews, 0, 'user-overridden word list replaces the defaults entirely')
})

test('v0.5 追加：status 的 memory.items 带只读条目原文', async () => {
  const conclusion = JSON.stringify({ action: 'nothing', memory: { action: 'add', store: 'memory', text: 'fact for items' } })
  const { home, oldHome, t } = await runE2E({ turnInterval: 1, cooldownMinutes: 0, mode: 'auto' }, conclusion)
  try {
    const route = t.routes[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/hermes-loop/api/status' }, res)
    const body = JSON.parse(res.body)
    assert.deepEqual(body.memory.stores.memory.items, ['fact for items'])
    assert.deepEqual(body.memory.stores.user.items, [])
    assert.equal(body.memory.stores.memory.entries, 1) // entries 仍是计数
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
