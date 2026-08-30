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
// settings 服务要求 schemastery schema（需要可调用校验 + toJSON，zod 不兼容）。
// 不能依赖打包依赖：宿主沙箱 require 解析 .pnpm 软链邻居时抛 ERR_INTERNAL_ASSERTION。
// ① 先试宿主 dsh 全局安装里的 vendored 副本（settings 服务自己用的就是它）；
// ② 再退回标准 require（本地开发/测试环境）。都失败则无 settings 注册（功能仍可用）。
function loadSchemastery() {
  const errors = []
  const { createRequire } = require('node:module')
  // 宿主 dsh 全局安装：跟随 dsh bin 的真实位置（bin 是 <install>/lib/bin.js 的 symlink，
  // process.execPath 可能指向捆绑的 node 运行时而非全局前缀，不能从它推导）。
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, homedir() + '/.local'].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs')
    try { return createRequire(hostCopy)(hostCopy) } catch (e) { errors.push(`host: ${String(e && e.message || e).slice(0, 100)}`) }
  }
  try { return require('@deepseek-ai/schemastery') } catch (e) { errors.push(`pkg: ${String(e && e.code || e)}`) }
  schemaRequireError = errors.join(' | ')
  return null
}
let schemaRequireError = null
let Schema = loadSchemastery()

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
  // ── Curator（design §10，v0.3）：纳管集只含本插件 created 的技能 ──
  curatorEnabled: true,
  curatorStaleDays: 30,
  curatorArchiveDays: 90,
  curatorIntervalHours: 24,
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
    curatorEnabled: Schema.boolean().default(true),
    curatorStaleDays: Schema.number().min(1).default(30),
    curatorArchiveDays: Schema.number().min(2).default(90),
    curatorIntervalHours: Schema.number().min(1).default(24),
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
 * Patch 版 frontmatter：更新 name/description 与 body，其余键原样保留。
 * `disable-model-invocation` / `user-invocable`（dsh 原生键，docs/subsystems/skills.md）
 * 是用户/平台的治理标记——复盘重写绝不能抹掉它们。
 */
function mergeFrontmatter(existingContent, name, description, newBody) {
  const raw = String(existingContent || '')
  const lines = raw.split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') return buildSkillMd(name, description, newBody)
  let closer = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { closer = i; break }
  }
  if (closer === -1) return buildSkillMd(name, description, newBody)
  const kept = lines.slice(1, closer).filter((l) => !/^(name|description)\s*:/.test(l.trim()))
  const yaml = [`name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description.replace(/\r?\n/g, ' '))}`, ...kept].join('\n')
  return `---\n${yaml}\n---\n\n${newBody.replace(/\s+$/, '')}\n`
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
  const content = mergeFrontmatter(current, conclusion.skill, description, conclusion.body)
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

/**
 * 切换 dsh 原生治理键 `disable-model-invocation`（Curator 归档/恢复的动作面，
 * design §10.3）。语义与 skills-management 已验证的 setModelInvocable 一致：
 * modelInvocable=false 写入 `disable-model-invocation: true`；true 移除该键；
 * 其余 frontmatter 键与正文原样保留。宿主 Chokidar 盯着技能根目录，外部进程
 * 改写会自动触发 skills/change 失效——无需任何 invalidate 调用。
 */
function setModelInvocation(content, modelInvocable) {
  const lines = String(content || '').split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') {
    return modelInvocable ? content : `---\ndisable-model-invocation: true\n---\n\n${content}`
  }
  let closer = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { closer = i; break }
  }
  if (closer === -1) return content
  let kept = lines.slice(1, closer).filter((l) => !/^disable-model-invocation\s*:/.test(l.trim()))
  if (!modelInvocable) kept = [...kept, 'disable-model-invocation: true']
  return [...lines.slice(0, 1), ...kept, ...lines.slice(closer)].join('\n')
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Curator 纯代码状态机（design §10.3，对齐 hermes curator.apply_automatic_transitions）。
 * 输入纳管记录与使用统计，返回需要变更的转移计划——不做任何 I/O，便于单测。
 * 规则（staleCutoff/archiveCutoff 为墙钟差值：时间流逝不依赖进程存活）：
 *   anchor = max(usage.lastUsedAt, lastRestoredAt, createdAt)  // 恢复也算一次活动
 *   1 零调用且 anchor 新于 stale 线 → 不动（"没用过"是证据缺失，不是过时证据）；
 *     若已标 stale 则回 active
 *   2 anchor ≤ archive 线 → archived（唯一会动文件的转移）
 *   3 anchor ≤ stale 线 且 active → stale（仅标记，文件不动）
 *   4 anchor 新于 stale 线 且 stale → active（用到即复活）
 *   5 archived 无自动出口——恢复只能走 restore 路由（面板）
 * 坏时间戳（NaN）fail-safe：不做任何转移。
 */
function curatorTransitions(records, usage, { now, staleDays, archiveDays }) {
  const nowMs = Date.parse(now)
  const staleCutoff = nowMs - staleDays * DAY_MS
  const archiveCutoff = nowMs - archiveDays * DAY_MS
  const transitions = []
  for (const [name, rec] of records) {
    const u = usage.get(name)
    const useCount = u && typeof u.count === 'number' ? u.count : 0
    // anchor = 三个锚点时间里的最新者：最后使用 / 面板恢复 / 创建。
    // 恢复也算一次"活动"——否则归档时残留的旧 lastUsedAt 会让下轮立即再归档。
    const anchors = [u && u.lastUsedAt, rec.lastRestoredAt, rec.createdAt]
      .map((ts) => (typeof ts === 'string' ? Date.parse(ts) : NaN))
      .filter((ms) => !Number.isNaN(ms))
    if (anchors.length === 0) continue
    const anchor = Math.max(...anchors)
    const state = rec.state === 'stale' || rec.state === 'archived' ? rec.state : 'active'
    if (useCount === 0 && anchor > staleCutoff) {
      if (state === 'stale') transitions.push({ skill: name, from: state, to: 'active', reason: 'grace' })
      continue
    }
    if (anchor <= archiveCutoff) {
      if (state !== 'archived') transitions.push({ skill: name, from: state, to: 'archived', reason: 'archive' })
      continue
    }
    if (anchor <= staleCutoff) {
      if (state === 'active') transitions.push({ skill: name, from: state, to: 'stale', reason: 'stale' })
      continue
    }
    if (state === 'stale') transitions.push({ skill: name, from: state, to: 'active', reason: 'revive' })
  }
  return transitions
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
  inject: ['skills', 'settings', 'agents', 'agentDefaultModel', 'systemPrompt', 'sessions'],
  __internals: {
    reasonKind, contentToText, renderTranscript, tokenize, rankSuspects,
    extractFencedJson, parseConclusion, sha256, buildSkillMd, mergeFrontmatter, applyConclusion,
    descriptionOf, atomicWrite, DEFAULTS, dshHome, globalSkillsDir, pendingDir,
    setModelInvocation, curatorTransitions,
  },

  apply(ctx, config = {}) {
    const trace = makeTracer()
    trace('armed', { pid: process.pid, config: { ...DEFAULTS, ...config } })
    let settingsScope = null
    const schema = settingsSchema()
    if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
      try {
        settingsScope = ctx.settings.register('hermes-loop', schema, { base: { ...DEFAULTS, ...config } })
        trace('settings-registered', {})
      }
      catch (e) {
        trace('settings-register-failed', { message: String(e && e.message || e) })
        ctx.logger.warn(`hermes-loop: settings register: ${e && e.message}`)
      }
    } else {
      trace('settings-register-skipped', { schema: Boolean(schema), schemaRequireError, settingsType: typeof ctx.settings })
    }

    const effective = () => {
      if (settingsScope && typeof settingsScope.get === 'function') {
        const v = settingsScope.get()
        if (v && typeof v === 'object') return { ...DEFAULTS, ...config, ...v }
      }
      return { ...DEFAULTS, ...config }
    }

    // ── In-session patch 纪律 section（design §5，辅助非依赖）──
    // hermes-prompt 已装（ctx.provide 标记）则跳过——其纪律宣言已覆盖同款要求，
    // 两套同时注册会让主 agent 收到重复的沉淀指令。
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      let hermesPromptPresent = false
      try {
        const marker = ctx.get && ctx.get('hermesPrompt', false)
        hermesPromptPresent = marker !== undefined && marker !== null
      } catch {}
      if (!hermesPromptPresent) {
        ctx.effect(() => ctx.systemPrompt.section({
          name: 'hermes:loop-aware', // 与 hermes-prompt 的 hermes:discipline 不同名——同层同名抛错
          order: 51,
          text: [
            '# 收尾沉淀（后台学习循环在运行）',
            '',
            '- 收尾时若发现**本会话已加载的 skill** 有错、缺步骤或过时：直接用你的工具**当场修正它**，不要留到后台复盘（后台也会复盘，但当场修的上下文最全）。',
            '- 其余沉淀（新 skill、经验教训）交给后台学习循环处理，**不要**主动写新 skill 文件——避免两套纪律打架。',
          ].join('\n'),
        }), 'hermes-loop: loop-aware section')
        ctx.logger.info && ctx.logger.info('hermes-loop: loop-aware section registered (hermes-prompt absent)')
      } else {
        ctx.logger.info && ctx.logger.info('hermes-loop: skipping loop-aware section (hermes-prompt provides discipline)')
      }
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

    // ── 技能使用统计 + Curator 状态（同一持久化文件）──
    // usage: 模型经 skill 工具的真实调用；catalogSeen: 出现在目录消息里的曝光。
    // "曝光多次但调用为零" 即僵尸候选。curator: 纳管集（本插件 created 的技能）
    // 与巡检元数据（design §10.3/§10.4）。防抖 5s + dispose 冲洗。
    const usageFile = () => join(dshHome(), 'hermes-loop', 'usage.json')
    const usage = new Map()
    const catalogSeen = new Map()
    const curatorSkills = new Map() // name → { createdAt, state: active|stale|archived, lastRestoredAt? }
    const curatorMeta = { lastRunAt: undefined, runCount: 0, lastSummary: undefined }
    let usageFlushTimer = null
    const usageLoaded = fsP.readFile(usageFile(), 'utf8').then((raw) => {
      const parsed = JSON.parse(raw)
      for (const [name, u] of Object.entries(parsed.usage || {})) usage.set(name, u)
      for (const [name, c] of Object.entries(parsed.catalog || {})) catalogSeen.set(name, c)
      for (const [name, rec] of Object.entries((parsed.curator && parsed.curator.skills) || {})) curatorSkills.set(name, rec)
      Object.assign(curatorMeta, parsed.curator || {})
      delete curatorMeta.skills
    }).catch(() => {})
    const flushUsage = () => {
      const write = atomicWrite(usageFile(), JSON.stringify({
        savedAt: new Date().toISOString(),
        usage: Object.fromEntries(usage),
        catalog: Object.fromEntries(catalogSeen),
        curator: { ...curatorMeta, skills: Object.fromEntries(curatorSkills) },
      }, null, 2))
      write.catch(() => {}) // fire-and-forget 调用点不产生 unhandled rejection；await 方仍能看到失败
      return write
    }
    const scheduleUsageFlush = () => {
      if (usageFlushTimer !== null) return
      usageFlushTimer = setTimeout(() => { usageFlushTimer = null; flushUsage() }, 5000)
      if (typeof usageFlushTimer.unref === 'function') usageFlushTimer.unref()
    }

    // ── Curator（design §10）：纳管登记 → 巡检 pass → 归档恢复 ──
    // 纳管集只含本插件 created 的技能（patch 的目标归属不明，不纳管）。
    const registerManaged = (name) => {
      if (curatorSkills.has(name)) return
      curatorSkills.set(name, { createdAt: new Date().toISOString(), state: 'active' })
      scheduleUsageFlush()
      trace('curator-managed', { skill: name })
    }

    const curatorCounts = () => {
      const counts = { active: 0, stale: 0, archived: 0 }
      for (const rec of curatorSkills.values()) {
        const state = rec.state === 'stale' || rec.state === 'archived' ? rec.state : 'active'
        counts[state] += 1
      }
      return counts
    }

    /**
     * 巡检 pass：纯代码状态机，唯一的文件动作是归档时翻 disable-model-invocation。
     * 崩溃安全（§10.4）：动任何文件之前先落盘 lastRunAt——崩在半路不会重启后反复重跑。
     */
    const runCuratorPass = async (manual = false) => {
      await usageLoaded
      const eff = effective()
      if (!eff.curatorEnabled) return { skipped: 'disabled' }
      if (!manual) {
        if (curatorMeta.lastRunAt === undefined) {
          // 首次运行：播种 lastRunAt，等满一个 interval（curator.py should_run_now 同款纪律）
          curatorMeta.lastRunAt = new Date().toISOString()
          try { await flushUsage() } catch {}
          return { skipped: 'seeded' }
        }
        if (Date.now() - Date.parse(curatorMeta.lastRunAt) < eff.curatorIntervalHours * 3600 * 1000) return { skipped: 'interval' }
      }
      curatorMeta.lastRunAt = new Date().toISOString()
      curatorMeta.runCount += 1
      try { await flushUsage() } catch {}
      const transitions = curatorTransitions(curatorSkills, usage, {
        now: curatorMeta.lastRunAt,
        staleDays: eff.curatorStaleDays,
        archiveDays: eff.curatorArchiveDays,
      })
      const applied = []
      for (const t of transitions) {
        try {
          if (t.to === 'archived') {
            const file = join(globalSkillsDir(), t.skill, 'SKILL.md')
            let content
            try { content = await fsP.readFile(file, 'utf8') }
            catch { curatorSkills.delete(t.skill); applied.push({ ...t, note: 'file-missing-dropped' }); continue }
            await atomicWrite(file, setModelInvocation(content, false))
          }
          curatorSkills.get(t.skill).state = t.to
          applied.push(t)
        } catch (e) { applied.push({ ...t, error: String(e && e.message || e) }) }
      }
      const counts = curatorCounts()
      const byTo = (to) => applied.filter((t) => t.to === to).length
      curatorMeta.lastSummary = `checked ${curatorSkills.size}: +${byTo('stale')} stale, +${byTo('archived')} archived, ${byTo('active')} back to active`
      try { await flushUsage() } catch {}
      trace('curator-run', { manual, summary: curatorMeta.lastSummary, applied })
      ctx.logger.info && ctx.logger.info(`hermes-loop: curator pass — ${curatorMeta.lastSummary}`)
      return { at: curatorMeta.lastRunAt, checked: curatorSkills.size, transitions: applied, counts, summary: curatorMeta.lastSummary }
    }

    /** 归档恢复：移除治理键 + state 回 active；lastRestoredAt 把 anchor 提到恢复时刻（防下轮立即再归档）。 */
    const restoreManaged = async (name) => {
      const rec = curatorSkills.get(name)
      if (rec === undefined) return { status: 404, message: `'${name}' is not managed by hermes-loop` }
      if (rec.state !== 'archived') return { status: 400, message: `'${name}' is not archived (state=${rec.state})` }
      let note
      try {
        const file = join(globalSkillsDir(), name, 'SKILL.md')
        await atomicWrite(file, setModelInvocation(await fsP.readFile(file, 'utf8'), true))
      } catch { note = 'file missing; record restored only' }
      rec.state = 'active'
      rec.lastRestoredAt = new Date().toISOString()
      try { await flushUsage() } catch {}
      trace('curator-restore', { skill: name, note })
      return { ok: true, note }
    }

    // 惰性触发主路径（§10.2）：状态加载完成后补一轮停机期间到期的转移；
    // 12h 定时器只是进程存活期间的加速器——正确性不依赖它（差值是墙钟算的）。
    // 之前先做存量回填：v0.3 上线前创建的技能不在纳管集里（沉淀卡与巡检卡对不上），
    // activity.jsonl 的 write-outcome:created 记录是"我们建的"的权威证据——补登记。
    const backfillManaged = async () => {
      await usageLoaded
      try {
        const raw = await fsP.readFile(activityFile(), 'utf8')
        let added = 0
        for (const line of raw.trimEnd().split('\n')) {
          let e
          try { e = JSON.parse(line) } catch { continue }
          if (e.event !== 'write-outcome' || e.result !== 'created' || typeof e.skill !== 'string') continue
          if (curatorSkills.has(e.skill)) continue
          // 文件已不在（用户手删）的跳过——别纳管幽灵
          try { await fsP.stat(join(globalSkillsDir(), e.skill, 'SKILL.md')) } catch { continue }
          curatorSkills.set(e.skill, {
            createdAt: typeof e.at === 'string' ? e.at : new Date().toISOString(),
            state: 'active',
          })
          added += 1
        }
        if (added > 0) {
          try { await flushUsage() } catch {}
          trace('curator-backfill', { added })
          ctx.logger.info && ctx.logger.info(`hermes-loop: curator backfilled ${added} pre-existing skill(s) from the audit ledger`)
        }
      } catch { /* 无 activity 文件：新装，无可回填 */ }
    }
    backfillManaged()
      .then(() => runCuratorPass(false).catch(() => {}))
    ctx.effect(() => {
      const timer = setInterval(() => { runCuratorPass(false).catch(() => {}) }, 12 * 60 * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'hermes-loop: curator interval')

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

    const runReview = async ({ session, eff, manual = false }) => {
      const sessionId = session.id
      const controller = new AbortController()
      const st = stateFor(sessionId)
      // 计数器在进入 runner 时重置（abort 也算消耗窗口，防重触发循环）
      st.turns = 0
      st.toolCalls = 0
      st.lastReviewAt = Date.now()
      running = { sessionId, controller }
      runningSince = new Date().toISOString()
      trace('review-start', { sessionId, manual })

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
        let liveText = ''
        const pump = () => {
          for (const ev of agent.session.events) {
            if (ev.seq < firstSeq) continue
            if (ev.type === 'assistant/message' && ev.data && ev.data.message) {
              const text = contentToText(ev.data.message.content)
              if (text.trim() !== '') finalText = text
            } else if (ev.type === 'assistant/chunk' && ev.data && ev.data.chunk) {
              // reasoning-delta 占了 reasoning 模型输出的绝大部分时长——预览里带标记展示，
              // 否则运行期间卡片几乎总是空白
              const chunk = ev.data.chunk
              if (chunk.type === 'text-delta' && chunk.text) {
                liveText += chunk.text
                if (running !== null && running.sessionId === sessionId) running.preview = liveText.slice(-1200)
              } else if (chunk.type === 'reasoning-delta' && chunk.text && (running !== null && running.sessionId === sessionId)) {
                running.preview = '（推理中）' + chunk.text.slice(-1000)
              }
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
          trace('conclusion', { sessionId, action: 'unparseable', head: finalText.slice(0, 160).replace(/\s+/g, ' ') })
          ctx.logger.warn(`hermes-loop: unparseable review conclusion for session ${sessionId}; dropped (fail-closed). head=${finalText.slice(0, 120).replace(/\s+/g, ' ')}`)
          return
        }
        trace('conclusion', { sessionId, action: conclusion.action, skill: conclusion.skill, rationale: String(conclusion.rationale || '').slice(0, 300) })
        if (conclusion.action === 'nothing') {
          ctx.logger.info(`hermes-loop: review of session ${sessionId} → nothing. ${conclusion.rationale}`)
          return
        }
        await dispatchConclusion(conclusion, { eff, sessionId, session })
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

    // ── 结论回显到来源会话（design §9 v0.2）──
    // session.append('user/message') + plugin source + form:'notice' —— 与
    // "上下文已压缩"同款的单行折叠通知：模型下一 turn 可见，界面显示为一行摘要。
    // 回显失败绝不影响写入结果（best-effort）。
    const notifySourceSession = (session, summary) => {
      if (!session || typeof session.append !== 'function') return
      try {
        session.append('user/message', {
          content: [{ type: 'text', text: summary }],
          source: { kind: 'plugin', plugin: 'hermes-loop', form: 'notice', summary },
        })
      } catch (e) { ctx.logger.warn(`hermes-loop: source-session notice: ${e && e.message}`) }
    }

    const dispatchConclusion = async (conclusion, { eff, sessionId, session }) => {
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
        trace('staged', { id, dir, sessionId })
        notifySourceSession(session, `后台复盘产出「${conclusion.skill}」已暂存待确认（mode=approval）：${conclusion.rationale || conclusion.action}`)
        ctx.logger.info(`${logHead} — staged to ${dir} for approval`)
        return
      }
      const outcome = await applyConclusion(conclusion, { globalDir: globalSkillsDir() })
      trace('write-outcome', { sessionId, skill: conclusion.skill, ...outcome })
      if (outcome.result === 'created' || outcome.result === 'patched') {
        ctx.logger.info(`${logHead} — ${outcome.result} → ${outcome.path}`)
        if (outcome.result === 'created') registerManaged(conclusion.skill) // 进入 Curator 纳管集（§10.3）
        notifySourceSession(session, `后台复盘已${outcome.result === 'created' ? '新建' : '修补'}技能「${conclusion.skill}」，下一个会话即可使用${conclusion.rationale ? `：${conclusion.rationale}` : ''}`)
      } else {
        ctx.logger.warn(`${logHead} — ${outcome.result}. ${outcome.detail || ''}`)
        if (outcome.result === 'cas-conflict' || outcome.result === 'create-conflict') {
          notifySourceSession(session, `后台复盘想${conclusion.action === 'patch' ? '修补' : '新建'}技能「${conclusion.skill}」但被守卫拒绝（${outcome.detail || outcome.result}），本次未写入`)
        }
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
        if (event.type === 'tool/call') {
          stateFor(sessionId).toolCalls += 1 // 随时累计，结算点在 turn 尾（与 Hermes turn_finalizer 同构）
          // 技能调用统计：tool/call 的 arguments 里带技能名（apiproxy 同款解析）
          if (event.data && event.data.name === 'skill') {
            try {
              const args = JSON.parse(event.data.arguments || '{}')
              if (typeof args.name === 'string' && args.name !== '') {
                const u = usage.get(args.name) || { count: 0, lastUsedAt: undefined, lastSessionId: undefined }
                u.count += 1
                u.lastUsedAt = new Date().toISOString()
                u.lastSessionId = sessionId
                usage.set(args.name, u)
                // 用到即复活（§10.2 规则 4 的事件时实现）：stale 纳管技能当场回 active
                const managed = curatorSkills.get(args.name)
                if (managed !== undefined && managed.state === 'stale') {
                  managed.state = 'active'
                  trace('curator-revive', { skill: args.name })
                }
                scheduleUsageFlush()
              }
            } catch { /* arguments 非 JSON：跳过计数 */ }
          }
          return
        }
        // 目录曝光统计：skill-catalog 注入消息带本次发布的全部条目
        if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'skill-catalog' && Array.isArray(event.data.source.entries)) {
          for (const entry of event.data.source.entries) {
            if (!entry || typeof entry.name !== 'string') continue
            const c = catalogSeen.get(entry.name) || { count: 0, lastAt: undefined }
            c.count += 1
            c.lastAt = new Date().toISOString()
            catalogSeen.set(entry.name, c)
          }
          scheduleUsageFlush()
          return
        }
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
        if (usageFlushTimer !== null) { clearTimeout(usageFlushTimer); usageFlushTimer = null }
        if (usage.size > 0 || catalogSeen.size > 0) flushUsage() // 统计不丢
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
      // 回填 sessionId：write-outcome 本身不带，从同 skill 最近的 dispatch 事件取
      const dispatchSessionBySkill = new Map()
      for (const e of activity) {
        if (e.event === 'dispatch' && e.skill && e.sessionId) dispatchSessionBySkill.set(e.skill, e.sessionId)
      }
      const written = activity
        .filter((e) => (e.event === 'write-outcome' && e.result) || e.event === 'staged')
        .map((e) => ({
          at: e.at,
          action: e.event === 'staged' ? 'staged' : (e.action === 'patched' ? 'patch' : 'create'),
          skill: e.skill,
          result: e.event === 'staged' ? 'staged' : e.result,
          path: e.path,
          sessionId: e.sessionId || dispatchSessionBySkill.get(e.skill),
        }))
        .reverse()
      // 把碎片事件聚成"每次复盘一行"：review-start 开一个聚类，后续事件补全它的结果
      const reviews = []
      let currentReview = null
      for (const e of activity) {
        if (e.event === 'review-start') {
          currentReview = { at: e.at, sessionId: e.sessionId, outcome: 'running', action: undefined, skill: undefined, rationale: undefined, suspects: undefined, catalogSize: undefined, messages: undefined, detail: undefined }
          reviews.push(currentReview)
          continue
        }
        if (currentReview === null) continue
        if (e.sessionId !== undefined && e.sessionId !== currentReview.sessionId && e.event !== 'conclusion') continue
        if (e.event === 'review-inputs') {
          currentReview.messages = e.messages
          currentReview.catalogSize = e.catalogSize
          currentReview.suspects = e.suspects
        } else if (e.event === 'conclusion') {
          currentReview.action = e.action
          currentReview.skill = e.skill || undefined
          currentReview.rationale = e.rationale || undefined
          if (e.action === 'unparseable') { currentReview.outcome = 'unparseable'; currentReview.detail = e.head }
          else if (e.action === 'nothing') currentReview.outcome = 'nothing'
        } else if (e.event === 'dispatch') {
          currentReview.action = e.action
          currentReview.skill = e.skill
        } else if (e.event === 'staged') {
          currentReview.outcome = 'staged'
          currentReview.skill = e.skill || currentReview.skill
        } else if (e.event === 'write-outcome') {
          currentReview.skill = e.skill || currentReview.skill
          if (e.result === 'created' || e.result === 'patched') currentReview.outcome = e.result
          else { currentReview.outcome = 'write-failed'; currentReview.detail = e.detail || e.result }
        } else if (e.event === 'review-error') {
          currentReview.outcome = 'error'
          currentReview.detail = e.message
        }
      }
      const current = sessionId !== undefined && sessionId !== '' ? sessions[sessionId] : undefined
      // 目录快照提供每个技能当前的 modelInvocable（frontmatter 治理键的实时状态）
      let invocableByName = null
      try {
        const snapshot = await ctx.skills.snapshot({})
        invocableByName = new Map((snapshot.skills || []).map((s) => [s.name, !(s.invocation && s.invocation.modelInvocable === false)]))
      } catch { /* snapshot 失败：状态列留空 */ }
      const usageRows = [...usage.entries()]
        .map(([skill, u]) => ({ skill, count: u.count, lastUsedAt: u.lastUsedAt, lastSessionId: u.lastSessionId }))
        .sort((a, b) => b.count - a.count)
      for (const [name] of catalogSeen) {
        if (!usage.has(name)) usageRows.push({ skill: name, count: 0, lastUsedAt: undefined, lastSessionId: undefined })
      }
      if (invocableByName !== null) {
        for (const row of usageRows) row.modelInvocable = invocableByName.get(row.skill)
      }
      const usageStats = {
        totalCalls: usageRows.reduce((sum, r) => sum + r.count, 0),
        catalogEntries: catalogSeen.size,
        neverCalled: usageRows.filter((r) => r.count === 0).length,
        rows: usageRows.slice(0, 50),
      }
      // Curator 面板数据（§10.5）：纳管技能行 = 状态机记录 × 使用统计 × 目录实时可见性
      const stateRank = { archived: 0, stale: 1, active: 2 }
      const curatorRows = [...curatorSkills.entries()]
        .map(([name, rec]) => ({
          skill: name,
          state: rec.state === 'stale' || rec.state === 'archived' ? rec.state : 'active',
          createdAt: rec.createdAt,
          lastRestoredAt: rec.lastRestoredAt,
          useCount: (usage.get(name) || {}).count || 0,
          lastUsedAt: (usage.get(name) || {}).lastUsedAt,
          modelInvocable: invocableByName !== null && invocableByName.has(name) ? invocableByName.get(name) : undefined,
        }))
        .sort((a, b) => (a.state === b.state ? String(a.skill).localeCompare(b.skill) : stateRank[a.state] - stateRank[b.state]))
      const curator = {
        enabled: eff.curatorEnabled,
        staleDays: eff.curatorStaleDays,
        archiveDays: eff.curatorArchiveDays,
        intervalHours: eff.curatorIntervalHours,
        lastRunAt: curatorMeta.lastRunAt,
        runCount: curatorMeta.runCount,
        lastSummary: curatorMeta.lastSummary,
        counts: curatorCounts(),
        skills: curatorRows,
      }
      return {
        settings: eff,
        running: running !== null ? { sessionId: running.sessionId, startedAt: runningSince, preview: running.preview } : null,
        queuedCount: queued.size,
        sessions,
        current: current || { turns: 0, toolCalls: 0, lastReviewAt: undefined },
        activity,
        reviews: reviews.reverse(),
        written,
        usage: usageStats,
        curator,
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
              // 手动"立即复盘"：绕过阈值/冷却，但仍走全局串行队列与前台取消
              if (req.method === 'POST' && apiPath.endsWith('/hermes-loop/api/review-now')) {
                const body = await readJsonBody(req)
                const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
                if (sessionId === '') { sendJson(res, 400, { error: 'body must provide sessionId' }); return }
                if (typeof ctx.sessions.get !== 'function') { sendJson(res, 503, { error: 'sessions service unavailable' }); return }
                const session = ctx.sessions.get(sessionId)
                if (session === undefined) { sendJson(res, 404, { error: `session '${sessionId}' is not live in this process` }); return }
                if (sessionId.startsWith('hermes-loop-review-')) { sendJson(res, 400, { error: 'cannot review a review session' }); return }
                if (running !== null && running.sessionId === sessionId) {
                  sendJson(res, 200, { ok: true, state: 'already-running' })
                  return
                }
                const task = () => runReview({ session, eff: effective(), manual: true })
                if (running === null) {
                  Promise.resolve().then(task).catch((e) => ctx.logger.warn(`hermes-loop: manual review: ${e && e.message}`))
                } else {
                  queued.set(sessionId, task) // 排队（顶替同 session 旧任务），running 结束后 drainNext
                }
                trace('manual-review-requested', { sessionId, queued: running !== null })
                sendJson(res, 202, { ok: true, state: running !== null ? 'queued' : 'started' })
                return
              }
              // Curator（§10.5）：立即巡检，绕过 interval 限制
              if (req.method === 'POST' && apiPath.endsWith('/hermes-loop/api/curator/run')) {
                const report = await runCuratorPass(true)
                sendJson(res, 200, { ok: true, report })
                return
              }
              // Curator：归档恢复（移除 disable-model-invocation + anchor 提到恢复时刻）
              if (req.method === 'POST' && apiPath.endsWith('/hermes-loop/api/curator/restore')) {
                const body = await readJsonBody(req)
                if (typeof body.name !== 'string' || !KEbab_NAME_RE.test(body.name)) { sendJson(res, 400, { error: 'body must provide a kebab-case skill name' }); return }
                const out = await restoreManaged(body.name)
                if (out.status !== undefined) { sendJson(res, out.status, { error: out.message }); return }
                sendJson(res, 200, out)
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
