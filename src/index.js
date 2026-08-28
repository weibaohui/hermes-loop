'use strict'

/**
 * dsh-plugin-hermes-loop — Hermes-style learning loop, host half.
 *
 * Subscribes to every session's `session/event` stream, counts completed
 * turns / tool calls per session, and when a threshold fires runs a
 * zero-tool background review agent over the transcript tail. The review
 * returns a fenced-JSON conclusion {action: nothing|create|patch, ...} and
 * this plugin (never the agent) writes the skill into the user library.
 *
 * Design doc: hermes-loop/docs/design-dsh.md (v2.1). v0.1 scope:
 * auto/log-only modes end-to-end, global skill dir only, approval stages a
 * pending JSON (UI arrives with v0.2 in skills-management).
 */

const { createHash, randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')
const { homedir } = require('node:os')
// settings 服务要求 schemastery schema（需要可调用校验 + toJSON，zod 不兼容）
let Schema = null
try { Schema = require('@deepseek-ai/schemastery') } catch { Schema = null }

const KEbab_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DESCRIPTION_MAX = 500
const BODY_MAX_CHARS = 128 * 1024
const SUSPECT_BODY_MAX_CHARS = 8 * 1024
const TRANSCRIPT_MESSAGE_CAP = 40
const TRANSCRIPT_MESSAGE_CHARS = 4000

/**
 * Audit/activity trail: append one JSON line per loop event to
 * `$DSH_HOME/hermes-loop/activity.jsonl`. Plugin `ctx.logger` output is
 * filtered by the host's log exporters, so the loop keeps its own record —
 * also the audit ledger for review-triggered writes (design §7).
 */
function makeTracer() {
  const file = join(dshHome(), 'hermes-loop', 'activity.jsonl')
  return (event, data = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
    fsP.mkdir(join(file, '..'), { recursive: true })
      .then(() => fsP.appendFile(file, line, 'utf8'))
      .catch(() => {})
  }
}

const DEFAULTS = {
  enabled: true,
  mode: 'auto',           // auto | approval | log-only
  provider: '',           // '' → follow the deployment default selection
  model: '',
  turnInterval: 10,
  toolCallInterval: 10,
  cooldownMinutes: 30,
  maxTranscriptChars: 12000,
  reviewTimeoutSec: 300,
  catalogDescriptionMax: 500,
  suspectsTopN: 3,
  maxTranscriptMessages: TRANSCRIPT_MESSAGE_CAP,
}

function settingsSchema() {
  if (!Schema) return null
  return Schema.object({
    enabled: Schema.boolean().default(true),
    mode: Schema.union(['auto', 'approval', 'log-only']).default('auto'),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    turnInterval: Schema.number().min(1).default(10),
    toolCallInterval: Schema.number().min(0).default(10),
    cooldownMinutes: Schema.number().min(0).default(30),
    maxTranscriptChars: Schema.number().min(1000).default(12000),
    reviewTimeoutSec: Schema.number().min(30).default(300),
    catalogDescriptionMax: Schema.number().min(50).default(500),
    suspectsTopN: Schema.number().min(0).max(10).default(3),
    maxTranscriptMessages: Schema.number().min(5).max(400).default(40),
  })
}

/** `$DSH_HOME`-aware roots, mirroring skills-management's installedDir logic. */
function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}
function globalSkillsDir() {
  return join(dshHome(), 'skills')
}
function pendingDir() {
  return join(dshHome(), 'hermes-loop', 'pending')
}

// ── Pure helpers (unit-tested via __internals) ──────────────────────────

/** `turn/end` reason arrives as `{kind: 'completed'}`; tolerate a bare string. */
function reasonKind(reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/** Best-effort text extraction from an LLM message content field. */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if ((block.type === 'tool_call' || block.type === 'tool_use') && block.name) parts.push(`[tool ${block.name}]`)
    // thinking/tool_result blocks: omitted — review reads decisions, not internals
  }
  return parts.join('\n')
}

/** Tail-keeping transcript render: last `maxMessages` entries, `maxChars` budget. */
function renderTranscript(messages, { maxChars = DEFAULTS.maxTranscriptChars, maxMessages = DEFAULTS.maxTranscriptMessages } = {}) {
  const lines = []
  for (const message of messages.slice(-maxMessages)) {
    const role = message && typeof message.role === 'string' ? message.role : 'unknown'
    let text = contentToText(message && message.content).trim()
    if (text === '') continue
    if (text.length > TRANSCRIPT_MESSAGE_CHARS) text = text.slice(0, TRANSCRIPT_MESSAGE_CHARS) + '…'
    lines.push(`### ${role}\n${text}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = '…（早段已按保尾策略截断）\n' + out.slice(out.length - maxChars)
  return out
}

/** Keyword tokens for suspect matching: latin words ≥3 chars + CJK runs ≥2 chars. */
function tokenize(text) {
  const tokens = new Set()
  for (const raw of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3 && !/[\u4e00-\u9fff]/.test(raw)) tokens.add(raw)
    else if (/^[\u4e00-\u9fff]{2,}$/.test(raw)) tokens.add(raw)
  }
  return tokens
}

/**
 * Rank catalog entries against the transcript for full-text injection.
 * Score: full-name substring hit ≫ name-token hits ≫ description hits.
 * Returns entries with score > 0, best first.
 */
function rankSuspects(catalog, transcriptText) {
  const haystack = String(transcriptText || '').toLowerCase()
  const scored = []
  for (const entry of catalog) {
    const name = String(entry.name || '')
    const lowered = name.toLowerCase()
    let score = 0
    if (lowered.length >= 4 && haystack.includes(lowered)) score += 10
    for (const token of tokenize(name)) {
      if (haystack.includes(token)) score += 3
    }
    for (const token of tokenize(entry.description)) {
      if (haystack.includes(token)) score += 1
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.entry)
}

/** Pull the first fenced ```json block, else the outermost braces span. */
function extractFencedJson(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1]
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return undefined
}

/**
 * Parse a review conclusion. Anything malformed → undefined (fail-closed:
 * the caller logs and drops, per design §4).
 */
function parseConclusion(text) {
  const jsonText = extractFencedJson(text)
  if (jsonText === undefined) return undefined
  let parsed
  try { parsed = JSON.parse(jsonText) } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (!['nothing', 'create', 'patch'].includes(parsed.action)) return undefined
  if (parsed.action === 'nothing') return { action: 'nothing', rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '' }
  if (typeof parsed.skill !== 'string' || !KEbab_NAME_RE.test(parsed.skill)) return undefined
  if (typeof parsed.body !== 'string' || parsed.body.trim() === '' || parsed.body.length > BODY_MAX_CHARS) return undefined
  const conclusion = { action: parsed.action, skill: parsed.skill, body: parsed.body, rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '' }
  if (parsed.action === 'create') {
    if (typeof parsed.description !== 'string' || parsed.description.trim() === '' || parsed.description.length > DESCRIPTION_MAX) return undefined
    conclusion.description = parsed.description.trim()
  }
  if (parsed.action === 'patch') {
    // CAS inputs — writer re-reads the file and compares (design §6 step ①)
    if (typeof parsed.baseHash !== 'string' || parsed.baseHash === '') return undefined
    conclusion.baseHash = parsed.baseHash
    if (typeof parsed.baseDescription === 'string') conclusion.baseDescription = parsed.baseDescription
  }
  return conclusion
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Render final SKILL.md content: frontmatter (name/description) + body. */
function buildSkillMd(name, description, body) {
  const yaml = `name: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description.replace(/\r?\n/g, ' '))}`
  return `---\n${yaml}\n---\n\n${body.replace(/\s+$/, '')}\n`
}

/**
 * Validate and apply a conclusion to the filesystem.
 * Guards, in order: create-onto-existing downgrade; patch CAS re-read;
 * atomic temp-file rename. Never writes outside `globalDir`.
 * @returns a short result descriptor (for logs and the caller's bookkeeping).
 */
async function applyConclusion(conclusion, { globalDir, now = new Date().toISOString() } = {}) {
  if (conclusion.action === 'nothing') return { result: 'nothing' }
  const targetDir = join(globalDir, conclusion.skill)
  const targetFile = join(targetDir, 'SKILL.md')

  if (conclusion.action === 'create') {
    let existing
    try { existing = await fsP.stat(targetFile) } catch { existing = undefined }
    if (existing !== undefined && existing.isFile()) {
      return { result: 'create-conflict', detail: `skill '${conclusion.skill}' already exists; refusing to overwrite (merge is v3 Curator work)` }
    }
    const content = buildSkillMd(conclusion.skill, conclusion.description, conclusion.body)
    await atomicWrite(targetFile, content)
    return { result: 'created', path: targetFile }
  }

  // patch — CAS: re-read right before writing; a mismatch means the skill
  // changed while the review ran (design §8.3: rename alone cannot fix ABA).
  let current
  try { current = await fsP.readFile(targetFile, 'utf8') } catch {
    return { result: 'patch-missing', detail: `skill '${conclusion.skill}' not found under ${globalDir}; v0.1 only patches the global library` }
  }
  if (sha256(current) !== conclusion.baseHash) {
    return { result: 'cas-conflict', detail: `skill '${conclusion.skill}' changed since the review read it` }
  }
  if (conclusion.baseDescription !== undefined) {
    const currentDescription = descriptionOf(current)
    if (currentDescription !== undefined && currentDescription !== conclusion.baseDescription) {
      return { result: 'cas-conflict', detail: `description of '${conclusion.skill}' changed since the review read it` }
    }
  }
  const description = conclusion.baseDescription !== undefined && conclusion.baseDescription !== ''
    ? conclusion.baseDescription
    : descriptionOf(current) || ''
  const content = buildSkillMd(conclusion.skill, description, conclusion.body)
  await atomicWrite(targetFile, content)
  return { result: 'patched', path: targetFile, at: now }
}

function descriptionOf(skillMdContent) {
  const match = String(skillMdContent || '').match(/^description:\s*(.+)$/m)
  if (match === undefined || match === null) return undefined
  let value = match[1].trim()
  try { value = String(JSON.parse(value)) } catch { /* keep raw YAML scalar */ }
  return value
}

/** temp file + rename in the same directory → readers never see a half file. */
async function atomicWrite(targetFile, content) {
  await fsP.mkdir(join(targetFile, '..'), { recursive: true })
  const temp = join(join(targetFile, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content, 'utf8')
  await fsP.rename(temp, targetFile)
}

// ── Review prompt (ported from Hermes _SKILL_REVIEW_PROMPT, design §4) ──

function reviewPrompt() {
  return [
    '你是后台复盘 agent：分析一段刚结束的对话转写，判断其中有没有值得沉淀为 skill 的经验。',
    '',
    '## 主动倾向',
    'Be ACTIVE — 多数对话至少值得一次小更新。什么都不做不是中性结果，而是错过了一次学习机会。',
    '',
    '## 正向信号（任一成立即行动）',
    '1. 用户纠正了风格/语气/格式/冗长度（"stop doing X" / "too verbose" / "直接给答案"）——这是 FIRST-CLASS 信号；',
    '2. 用户纠正了工作流或步骤顺序；',
    '3. 出现非平凡的技巧、修复、绕过、调试路径、工具用法；',
    '4. 注入的既有 skill 被发现有错/缺步/过时 → 立即 PATCH 它。',
    '',
    '## 负面清单（禁止沉淀）',
    '- 环境依赖故障（缺二进制、凭据未配置——用户自己能修的）；',
    '- 对工具的负面断言（"X 工具坏了"会硬化成永久拒绝）；',
    '- 会话内已自行解决的暂时错误（值得存的是重试模式，不是故障本身）；',
    '- 一次性任务叙事（不构成一类工作）；',
    '- 未解决的失败——不能把没验证成功的死胡同包装成可靠流程。',
    '',
    '## 优先序',
    '1. PATCH 转写中出现过的、注入了全文的 skill；',
    '2. PATCH 既有 class-level umbrella skill（见下方清单）；',
    '3. 都不覆盖才 CREATE 新 skill。',
    '',
    '## 命名纪律',
    'kebab-case class-level 名字。禁止 PR 号、错误串、一次性代号（fix-X / debug-Y 之类）。',
    '如果名字只对今天的任务有意义，那就是错的——回到优先序 1/2 去扩写既有 skill。',
    '',
    '## 分工',
    '流程、步骤、坑 → skill。用户画像/偏好类信息本轮不沉淀。',
    '',
    '## 输出协议（严格遵守）',
    '只输出一个 fenced JSON 代码块，不要输出其他任何文字：',
    '```json',
    '{ "action": "nothing" | "create" | "patch",',
    '  "skill": "kebab-case-name",            // create/patch 必填',
    '  "description": "≤500 字符",             // create 必填',
    '  "body": "完整 SKILL.md 正文，不含 frontmatter",  // create/patch 必填',
    '  "baseHash": "<注入的 suspect baseHash 原样带回>",  // patch 必填',
    '  "baseDescription": "<注入的 suspect description 原样带回>",  // patch 必填',
    '  "rationale": "一句话：为什么值得存/不值得存" }',
    '```',
    'patch 时 body 必须基于注入的目标全文修改（保留正确内容，只改需要改的），不得凭空重写。',
    'body 章节规范：When to Use / Prerequisites / Procedure / Pitfalls / Verification。',
  ].join('\n')
}

// ── Plugin ──────────────────────────────────────────────────────────────

module.exports = {
  name: 'hermes-loop',
  // 静态注入：apply 在这些服务就绪后才运行（at-file 同款模式）。
  // 动态 ctx.inject(['settings'], cb) 在 apply 内不会触发——skills-management 的
  // settings 注册就是这么静默失效的（平台 gotcha）。
  inject: ['skills', 'settings', 'agents', 'agentDefaultModel'],
  __internals: {
    reasonKind, contentToText, renderTranscript, tokenize, rankSuspects,
    extractFencedJson, parseConclusion, sha256, buildSkillMd, applyConclusion,
    descriptionOf, atomicWrite, DEFAULTS, dshHome, globalSkillsDir, pendingDir,
  },

  apply(ctx, config = {}) {
    const trace = makeTracer()
    trace('armed', { pid: process.pid, config: { ...DEFAULTS, ...config } })
    let settingsScope = null
    const schema = settingsSchema()
    if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
      try { settingsScope = ctx.settings.register('hermes-loop', schema, { base: { ...DEFAULTS, ...config } }) }
      catch (e) { ctx.logger.warn(`hermes-loop: settings register: ${e && e.message}`) }
    }

    const effective = () => {
      if (settingsScope && typeof settingsScope.get === 'function') {
        const v = settingsScope.get()
        if (v && typeof v === 'object') return { ...DEFAULTS, ...config, ...v }
      }
      return { ...DEFAULTS, ...config }
    }

    // ── Trigger state ──
    // windows: per-session counters since the last review entered the runner.
    // queued:  at most one waiting review per session (a newer one replaces it).
    // running: the single in-flight review, or null (global serial).
    const windows = new Map()
    const queued = new Map()
    let running = null
    let runningSince = null

    const activityFile = () => join(dshHome(), 'hermes-loop', 'activity.jsonl')

    const stateFor = (sessionId) => {
      let st = windows.get(sessionId)
      if (st === undefined) windows.set(sessionId, st = { turns: 0, toolCalls: 0, lastReviewAt: 0 })
      return st
    }

    const drainNext = () => {
      if (running !== null || queued.size === 0) return
      const [nextSessionId, task] = queued.entries().next().value
      queued.delete(nextSessionId)
      Promise.resolve().then(task).catch((e) => ctx.logger.warn(`hermes-loop: review task: ${e && e.message}`))
    }

    const runReview = async ({ session, eff }) => {
      const sessionId = session.id
      const controller = new AbortController()
      const st = stateFor(sessionId)
      // 计数器在进入 runner 时重置（abort 也算消耗窗口，防重触发循环）
      st.turns = 0
      st.toolCalls = 0
      st.lastReviewAt = Date.now()
      running = { sessionId, controller }
      runningSince = new Date().toISOString()
      trace('review-start', { sessionId })

      let handle
      try {
        // 1. transcript tail
        const messages = session.deriveMessages()
        const transcriptText = renderTranscript(messages, eff)

        // 2. catalog + suspects full text（patch 可行性的前提，§4 输入 3）
        const cwd = session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined
        const snapshot = await ctx.skills.snapshot({ cwd, signal: controller.signal })
        const catalog = (snapshot.skills || [])
          .filter((s) => s.invocation === undefined || s.invocation.modelInvocable !== false)
          .map((s) => ({
            name: s.name,
            description: typeof s.description === 'string' ? s.description.slice(0, eff.catalogDescriptionMax) : '',
            resourceBase: s.resourceBase,
          }))
        const catalogText = catalog.length > 0
          ? catalog.map((s) => `- ${s.name}: ${s.description}`).join('\n')
          : '（当前无可用 skill）'
        const suspects = rankSuspects(catalog, transcriptText).slice(0, eff.suspectsTopN)
        trace('review-inputs', { sessionId, messages: messages.length, catalogSize: catalog.length, suspects: suspects.map((s) => s.name) })
        const suspectBlocks = []
        for (const suspect of suspects) {
          if (!suspect.resourceBase || suspect.resourceBase.kind !== 'directory' || typeof suspect.resourceBase.path !== 'string') continue
          const file = join(suspect.resourceBase.path, 'SKILL.md')
          let content
          try { content = await fsP.readFile(file, 'utf8') } catch { continue }
          const hash = sha256(content)
          if (content.length > SUSPECT_BODY_MAX_CHARS) content = content.slice(0, SUSPECT_BODY_MAX_CHARS) + '\n…（截断）'
          suspectBlocks.push(`### suspect: ${suspect.name}\nbaseHash: ${hash}\nbaseDescription: ${JSON.stringify(suspect.description)}\n\n${content}`)
        }

        // 3. zero-tool review agent（进程内、独立会话、不污染会话库）
        const selection = ctx.agentDefaultModel.currentSelection()
        handle = await ctx.agents.create({
          sessionId: 'hermes-loop-review-' + randomUUID(),
          meta: { cwd, agentPreset: 'standard', origin: 'subagent' },
          agentOptions: { provider: eff.provider || selection.provider, model: eff.model || selection.model },
          signal: controller.signal,
          setup: (agentCtx) => { agentCtx.tools.restrict({ allow: [] }) },
        })
        const agent = handle.agent
        trace('review-agent-created', { reviewSession: agent.id })

        // 4. pump the final assistant message out of the session log
        const firstSeq = agent.session.seq
        let finalText = ''
        const pump = () => {
          for (const ev of agent.session.events) {
            if (ev.seq < firstSeq) continue
            if (ev.type === 'assistant/message' && ev.data && ev.data.message) {
              const text = contentToText(ev.data.message.content)
              if (text.trim() !== '') finalText = text
            }
          }
        }
        const timer = setInterval(pump, 300)
        if (typeof timer.unref === 'function') timer.unref()
        const timeout = setTimeout(() => controller.abort(), Math.max(30, eff.reviewTimeoutSec) * 1000)
        if (typeof timeout.unref === 'function') timeout.unref()
        const onAbort = () => { try { agent.cancel({ kind: 'parent' }) } catch {} }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        try {
          const prompt = [
            reviewPrompt(),
            '\n## 既有 skill 清单（name: description）\n' + catalogText,
            suspectBlocks.length > 0 ? '\n## 疑似相关 skill 全文\n' + suspectBlocks.join('\n\n---\n\n') : '',
            '\n## 会话转写（保尾截断）\n' + transcriptText,
          ].filter(Boolean).join('\n\n')
          agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
          await agent.whenIdle()
        } finally {
          clearInterval(timer)
          clearTimeout(timeout)
          controller.signal.removeEventListener('abort', onAbort)
          pump()
        }

        trace('review-output', { sessionId, chars: finalText.length, head: finalText.slice(0, 200) })
        if (controller.signal.aborted) {
          ctx.logger.warn(`hermes-loop: review for session ${sessionId} aborted (timeout=${eff.reviewTimeoutSec}s / foreground priority)`)
          return
        }

        // 5. conclusion → writer
        const conclusion = parseConclusion(finalText)
        if (conclusion === undefined) {
          ctx.logger.warn(`hermes-loop: unparseable review conclusion for session ${sessionId}; dropped (fail-closed). head=${finalText.slice(0, 120).replace(/\s+/g, ' ')}`)
          return
        }
        if (conclusion.action === 'nothing') {
          ctx.logger.info(`hermes-loop: review of session ${sessionId} → nothing. ${conclusion.rationale}`)
          return
        }
        await dispatchConclusion(conclusion, { eff, sessionId })
      } catch (e) {
        trace('review-error', { sessionId, message: String(e && e.message || e) })
        throw e
      } finally {
        running = null
        runningSince = null
        if (handle) { try { await handle.dispose() } catch {} }
        drainNext()
      }
    }

    const dispatchConclusion = async (conclusion, { eff, sessionId }) => {
      const logHead = `hermes-loop: ${conclusion.action} '${conclusion.skill}' (from session ${sessionId})`
      trace('dispatch', { sessionId, mode: eff.mode, action: conclusion.action, skill: conclusion.skill })
      if (eff.mode === 'log-only') {
        ctx.logger.info(`${logHead} — log-only mode, not written. ${JSON.stringify(conclusion)}`)
        return
      }
      if (eff.mode === 'approval') {
        const dir = pendingDir()
        const id = `${Date.now().toString(36)}-${conclusion.skill}`
        const payload = { id, at: new Date().toISOString(), sourceSession: sessionId, mode: eff.mode, globalDir: globalSkillsDir(), conclusion }
        await fsP.mkdir(dir, { recursive: true })
        await atomicWrite(join(dir, `${id}.json`), JSON.stringify(payload, null, 2))
        trace('staged', { id, dir })
        ctx.logger.info(`${logHead} — staged to ${dir} for approval`)
        return
      }
      const outcome = await applyConclusion(conclusion, { globalDir: globalSkillsDir() })
      trace('write-outcome', { skill: conclusion.skill, ...outcome })
      if (outcome.result === 'created' || outcome.result === 'patched') {
        ctx.logger.info(`${logHead} — ${outcome.result} → ${outcome.path}`)
      } else {
        ctx.logger.warn(`${logHead} — ${outcome.result}. ${outcome.detail || ''}`)
      }
    }

    // ── Event handler: exclusions → counting → thresholds ──
    const onSessionEvent = (session, event) => {
      try {
        const eff = effective()
        if (!eff.enabled) return
        if (!ctx.agents || !ctx.agentDefaultModel) return
        const sessionId = session && session.id
        if (typeof sessionId !== 'string') return
        // 防自反馈：自己的 review 会话 + 一切 subagent 会话都不触发
        if (sessionId.startsWith('hermes-loop-review-')) return
        if (session.header && session.header.origin === 'subagent') return

        if (event.type === 'turn/start') {
          // 前台优先：本 session 的排队任务直接丢弃；运行中的靠 cancel
          const queuedTask = queued.get(sessionId)
          if (queuedTask !== undefined) { queued.delete(sessionId); ctx.logger.info(`hermes-loop: dropped queued review for session ${sessionId} (new turn started)`) }
          if (running !== null && running.sessionId === sessionId) running.controller.abort()
          return
        }
        if (event.type === 'tool/call') { stateFor(sessionId).toolCalls += 1; return } // 随时累计，结算点在 turn 尾（与 Hermes turn_finalizer 同构）
        if (event.type !== 'turn/end') return
        if (reasonKind(event.data && event.data.reason) !== 'completed') return

        const st = stateFor(sessionId)
        st.turns += 1
        const cooledDown = Date.now() - st.lastReviewAt >= eff.cooldownMinutes * 60 * 1000
        const hitTurn = eff.turnInterval > 0 && st.turns >= eff.turnInterval
        const hitTools = eff.toolCallInterval > 0 && st.toolCalls >= eff.toolCallInterval
        trace('threshold', { sessionId, turns: st.turns, toolCalls: st.toolCalls, cooledDown, hitTurn, hitTools })
        if (!cooledDown || (!hitTurn && !hitTools)) return

        const task = () => runReview({ session, eff })
        if (running === null) {
          Promise.resolve().then(task).catch((e) => ctx.logger.warn(`hermes-loop: review task: ${e && e.message}`))
        } else if (!queued.has(sessionId)) {
          queued.set(sessionId, task)
        } else {
          queued.set(sessionId, task) // 同 session 重触发 → 新任务顶替旧排队
        }
      } catch (e) { ctx.logger.warn(`hermes-loop: session/event handler: ${e && e.message}`) }
    }

    ctx.effect(() => {
      const dispose = ctx.on('session/event', onSessionEvent)
      return () => {
        try { dispose() } catch {}
        queued.clear()
        windows.clear()
        if (running !== null) running.controller.abort() // runner finally 里 dispose agent
      }
    }, 'hermes-loop: session/event subscription')

    // ── Client API（web 面板的唯一数据源；宿主面动态注入 webServer 是可用路径）──
    const sendJson = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const readJsonBody = (req) => new Promise((fulfil, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) { reject(new Error('request body too large')); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
      })
      req.on('error', reject)
    })
    const readActivityTail = async (limit = 60) => {
      let raw
      try { raw = await fsP.readFile(activityFile(), 'utf8') } catch { return [] }
      const out = []
      for (const line of raw.trimEnd().split('\n').slice(-limit)) {
        try { out.push(JSON.parse(line)) } catch { /* skip damaged line */ }
      }
      return out
    }
    const loopSnapshot = async (sessionId) => {
      const eff = effective()
      const sessions = {}
      for (const [sid, st] of windows) {
        sessions[sid] = { turns: st.turns, toolCalls: st.toolCalls, lastReviewAt: st.lastReviewAt || undefined }
      }
      const activity = await readActivityTail()
      const written = activity
        .filter((e) => (e.event === 'write-outcome' && e.result) || e.event === 'staged')
        .map((e) => ({
          at: e.at,
          action: e.event === 'staged' ? 'staged' : (e.action === 'patched' ? 'patch' : 'create'),
          skill: e.skill,
          result: e.event === 'staged' ? 'staged' : e.result,
          path: e.path,
        }))
        .reverse()
      const current = sessionId !== undefined && sessionId !== '' ? sessions[sessionId] : undefined
      return {
        settings: eff,
        running: running !== null ? { sessionId: running.sessionId, startedAt: runningSince } : null,
        queuedCount: queued.size,
        sessions,
        current: current || { turns: 0, toolCalls: 0, lastReviewAt: undefined },
        activity,
        written,
      }
    }

    try {
      ctx.inject(['webServer'], (webServerCtx) => {
        ctx.effect(() => webServerCtx.webServer.register({
          kind: 'prefix',
          path: '/hermes-loop/api',
          handler: async (req, res) => {
            try {
              const url = new URL(req.url || '/', 'http://dsh.local')
              const apiPath = url.pathname.replace(/\/+$/, '')
              if (req.method === 'GET' && apiPath.endsWith('/hermes-loop/api/status')) {
                sendJson(res, 200, await loopSnapshot(url.searchParams.get('sessionId') || ''))
                return
              }
              if (req.method === 'POST' && apiPath.endsWith('/hermes-loop/api/settings')) {
                const body = await readJsonBody(req)
                if (body === null || typeof body !== 'object' || body.patch === undefined || typeof body.patch !== 'object') {
                  sendJson(res, 400, { error: 'body must provide patch object' })
                  return
                }
                if (settingsScope && typeof settingsScope.update === 'function') await settingsScope.update(body.patch)
                else Object.assign(config, body.patch) // 无 settings 服务时退化为运行时覆盖
                sendJson(res, 200, { ok: true, settings: effective() })
                return
              }
              sendJson(res, 404, { error: 'not found' })
            } catch (error) { sendJson(res, 400, { error: String(error && error.message || error) }) }
          },
        }), 'hermes-loop: client api route')
      })
    } catch {}

    ctx.logger.info && ctx.logger.info('hermes-loop: learning loop armed (session/event subscription active)')
  },
}
