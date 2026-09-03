'use strict'

/**
 * dsh-plugin-hermes-loop — Hermes-style learning loop, host half.
 *
 * Subscribes to every session's `session/event` stream, counts completed
 * turns / tool calls per session, and when a threshold fires runs a
 * zero-tool background review agent over the transcript tail. The review
 * returns a fenced-JSON conclusion {action: nothing|create|patch, ...} with
 * an optional on-demand `memory` sub-conclusion, and this plugin (never the
 * agent) writes the skill / memory entries to disk. Memory is injected back
 * through `systemPrompt.context()` — the delta-projected runtime snapshot.
 *
 * Design doc: hermes-loop/docs/design-dsh.md (v2.1, memory §12). v0.1 scope:
 * auto/log-only modes end-to-end, global skill dir only, approval stages a
 * pending JSON (UI arrives with v0.2 in skills-management).
 */

const { createHash, randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const fs = require('node:fs')
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
// ── Memory 通道（design §12，v0.5）──
const MEMORY_ENTRY_MAX_CHARS = 500
const MEMORY_STORES = ['memory', 'user']
// 不可见 Unicode 与控制字符（\n\t 除外）：prompt 注入的常见载体，代码只拦便宜的
const MEMORY_INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/
const MEMORY_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
// 凭据样式：条目里出现即拒绝（语义级判断仍交给 review prompt 的负面清单）
const MEMORY_CREDENTIAL_RE = /(sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_-]?key|apikey|secret|token)\b\s*[=:]\s*\S+)/i

// 纠正词默认表（v0.5 起含持久化意图词「记住,记忆」：命中即提前复盘，复盘读转写后
// 通常把用户要求记住的内容写入记忆库。「总结」刻意不收——太常用，会显著抬升复盘频率）。
// DEFAULTS 与 settingsSchema 共用同一份，防止两处漂移。
const DEFAULT_CORRECTION_WORDS = '不对,错了,重来,别这样,应该是,你弄错了,记住,记忆,wrong,try again,not what i,stop doing'

/**
 * Audit/activity trail: append one JSON line per loop event to
 * `$DSH_HOME/hermes-loop/activity.jsonl`. Plugin `ctx.logger` output is
 * filtered by the host's log exporters, so the loop keeps its own record —
 * also the audit ledger for review-triggered writes (design §7).
 * 滚动截断：账本只增不减会让启动回填（全量扫）和面板轮询（读尾部）随年龄变慢，
 * 超过 512KB 时保留尾部 2000 行（≈200+ 次复盘的完整记录）。
 */
function makeTracer() {
  const file = join(dshHome(), 'hermes-loop', 'activity.jsonl')
  const MAX_BYTES = 512 * 1024
  const KEEP_LINES = 2000
  let approxSize = -1 // -1 = 未测量，首次 append 后 stat 校准
  return (event, data = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
    fsP.mkdir(join(file, '..'), { recursive: true })
      .then(() => fsP.appendFile(file, line, 'utf8'))
      .then(() => {
        if (approxSize < 0) { approxSize = 0; fsP.stat(file).then((s) => { approxSize = s.size }).catch(() => {}); return }
        approxSize += line.length
        if (approxSize <= MAX_BYTES) return
        approxSize = 0
        return fsP.readFile(file, 'utf8')
          .then((raw) => atomicWrite(file, raw.trimEnd().split('\n').slice(-KEEP_LINES).join('\n') + '\n'))
      })
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
  // ── 信号加速触发（v0.4）：触发器求便宜+高召回，精确性交给复盘 agent 的负面清单 ──
  signalTriggerEnabled: true,
  signalToolFailureMin: 3,   // 窗口内 tool/result 失败 ≥N 次 → 加速（0=关）
  // 内置中英默认词表；用户可在面板/settings.yaml 整体改写（逗号分隔，全量替换）
  signalCorrectionWords: DEFAULT_CORRECTION_WORDS,
  // ── Memory 通道（design §12，v0.5）──
  memoryEnabled: true,        // MEMORY.md：环境/项目事实、约定、教训
  userProfileEnabled: true,   // USER.md：画像/偏好；两开关全关 → 协议退回 skill 单结论
  memoryCharLimit: 2200,      // 对齐 Hermes 原版（≈800 tok）
  userCharLimit: 1375,        // ≈500 tok
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
    signalTriggerEnabled: Schema.boolean().default(true),
    signalToolFailureMin: Schema.number().min(0).default(3),
    signalCorrectionWords: Schema.string().default(DEFAULT_CORRECTION_WORDS),
    memoryEnabled: Schema.boolean().default(true),
    userProfileEnabled: Schema.boolean().default(true),
    memoryCharLimit: Schema.number().min(200).default(2200),
    userCharLimit: Schema.number().min(200).default(1375),
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
function memoryDir() {
  return join(dshHome(), 'memory')
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
 * memory 子结论解析（design §12.3，向后兼容）：字段缺席/畸形一律返回 undefined，
 * 只丢 memory 通道、绝不连坐 skill 结论（fail-closed 按通道隔离）。
 */
function parseMemoryConclusion(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (!['nothing', 'add', 'replace', 'remove'].includes(raw.action)) return undefined
  if (raw.action === 'nothing') return { action: 'nothing', rationale: typeof raw.rationale === 'string' ? raw.rationale : '' }
  if (raw.store !== 'memory' && raw.store !== 'user') return undefined
  // oldText 只约束 replace/remove（add 不需要定位既有条目）
  if (raw.action === 'replace' || raw.action === 'remove') {
    if (typeof raw.oldText !== 'string' || raw.oldText.trim() === '') return undefined
  }
  // add/replace 带正文：非空校验 + 截断（description 截断同款——模型对字符数估计
  // 有系统性偏差，一条其余全合法的结论不该因略长蒸发）
  let text
  if (raw.action === 'add' || raw.action === 'replace') {
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return undefined
    text = raw.text.trim().slice(0, MEMORY_ENTRY_MAX_CHARS)
  }
  const out = { action: raw.action, store: raw.store, oldText: raw.oldText, rationale: typeof raw.rationale === 'string' ? raw.rationale : '' }
  if (text !== undefined) out.text = text
  return out
}

/**
 * Parse a review conclusion. Anything malformed → undefined (fail-closed:
 * the caller logs and drops, per design §4). The optional `memory` field is
 * validated independently: a malformed memory sub-conclusion is dropped while
 * the skill conclusion survives (per-channel fail-closed, design §12.3).
 */
function parseConclusion(text) {
  const jsonText = extractFencedJson(text)
  if (jsonText === undefined) return undefined
  let parsed
  try { parsed = JSON.parse(jsonText) } catch { return undefined }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (!['nothing', 'create', 'patch'].includes(parsed.action)) return undefined
  const memory = parseMemoryConclusion(parsed.memory)
  if (parsed.action === 'nothing') {
    const out = { action: 'nothing', rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '' }
    if (memory !== undefined) out.memory = memory
    return out
  }
  if (typeof parsed.skill !== 'string' || !KEbab_NAME_RE.test(parsed.skill)) return undefined
  if (typeof parsed.body !== 'string' || parsed.body.trim() === '' || parsed.body.length > BODY_MAX_CHARS) return undefined
  const conclusion = { action: parsed.action, skill: parsed.skill, body: parsed.body, rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '' }
  if (parsed.action === 'create') {
    if (typeof parsed.description !== 'string' || parsed.description.trim() === '') return undefined
    // 超长截断而非整体丢弃：模型对字符数的估计与 UTF-16 .length（emoji 算 2）
    // 有系统性偏差，一条其余全合法的结论不该因 description 略长而蒸发
    conclusion.description = parsed.description.trim().slice(0, DESCRIPTION_MAX)
  }
  if (parsed.action === 'patch') {
    // CAS inputs — writer re-reads the file and compares (design §6 step ①)
    if (typeof parsed.baseHash !== 'string' || parsed.baseHash === '') return undefined
    conclusion.baseHash = parsed.baseHash
    if (typeof parsed.baseDescription === 'string') conclusion.baseDescription = parsed.baseDescription
  }
  if (memory !== undefined) conclusion.memory = memory
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

/** 纠正词表解析：逗号/顿号/分号/换行分隔，小写化，去空。 */
function parseCorrectionWords(raw) {
  return String(raw || '')
    .split(/[,，、;；\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0)
}

/** 在文本里找第一个命中的纠正词（小写比较；返回原词供审计）。 */
function matchCorrectionWord(text, words) {
  const hay = String(text || '').toLowerCase()
  return words.find((w) => hay.includes(w))
}

// ── Memory 通道（design §12，v0.5）──────────────────────────────────────
// 载体 ~/.dsh/memory/{MEMORY,USER}.md，条目一行一条、`§ ` 前缀（Hermes 同款，
// 人可直接读改——每步重读文件，手改下一个模型步即见）。四个守卫全部纯函数化。

const memoryStoreFile = (store) => join(memoryDir(), store === 'user' ? 'USER.md' : 'MEMORY.md')
const memoryStoreEnabled = (store, eff) => (store === 'user' ? eff.userProfileEnabled : eff.memoryEnabled) !== false
const memoryStoreLimit = (store, eff) => (store === 'user' ? eff.userCharLimit : eff.memoryCharLimit)

/** 去重/比较用的规范化：连续空白折叠成单空格。 */
function normalizeEntry(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/** 解析记忆文件：`§` 前缀行是条目，其余（标题/空行/手写注释）忽略。 */
function parseMemoryEntries(raw) {
  const out = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(/^§\s?(.*)$/)
    if (m === null) continue
    const text = m[1].trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** 序列化：标准标题 + `§ ` 行。条目内换行折叠成空格，保持一行一条。 */
function serializeMemoryEntries(store, entries) {
  const title = store === 'user' ? 'USER' : 'MEMORY'
  const body = entries.map((e) => '§ ' + normalizeEntry(e)).join('\n')
  return `# ${title}\n\n${body}${body === '' ? '' : '\n'}`
}

const memoryCharsOf = (entries) => entries.reduce((n, e) => n + e.length, 0)

/**
 * 条目内容扫描：返回拒绝理由，null=放行。只拦代码层便宜的：
 * 不可见 Unicode / 控制字符（prompt 注入载体）、凭据样式（防复盘把密钥记进永久记忆）。
 */
function scanMemoryEntry(text) {
  if (MEMORY_INVISIBLE_RE.test(text)) return 'invisible-unicode'
  if (MEMORY_CONTROL_RE.test(text)) return 'control-char'
  if (MEMORY_CREDENTIAL_RE.test(text)) return 'credential-pattern'
  return null
}

/**
 * 纯函数四条守卫（design §12.4 ①去重 ②扫描 ③限额 ④oldText 唯一定位）：
 * 输入当前条目与 memory 子结论，返回应用后的条目数组——不做任何 I/O。
 * @returns {ok: true, result: 'added'|'replaced'|'removed', entries, chars}
 *        | {ok: false, result: 'rejected', reason, detail}
 */
function planMemoryChange(entries, mem, { limit }) {
  const current = Array.isArray(entries) ? entries : []
  const used = memoryCharsOf(current)
  if (mem.action === 'add') {
    const text = normalizeEntry(mem.text)
    if (text === '') return { ok: false, result: 'rejected', reason: 'empty-text' }
    if (current.some((e) => normalizeEntry(e) === text)) {
      return { ok: false, result: 'rejected', reason: 'duplicate', detail: 'identical entry already exists' }
    }
    const scan = scanMemoryEntry(text)
    if (scan !== null) return { ok: false, result: 'rejected', reason: scan, detail: 'entry content rejected by scanner' }
    const chars = used + text.length
    if (chars > limit) {
      return { ok: false, result: 'rejected', reason: 'over-limit', detail: `${chars}/${limit} chars — merge or remove via replace/remove instead of add` }
    }
    return { ok: true, result: 'added', entries: [...current, text], chars }
  }
  // replace/remove 共用 oldText 唯一定位：0 命中=missing，≥2 命中=ambiguous
  const needle = String(mem.oldText || '')
  const hits = []
  current.forEach((e, i) => { if (needle !== '' && e.includes(needle)) hits.push(i) })
  if (hits.length === 0) return { ok: false, result: 'rejected', reason: 'old-text-missing', detail: 'oldText matches no entry' }
  if (hits.length > 1) return { ok: false, result: 'rejected', reason: 'old-text-ambiguous', detail: `oldText matches ${hits.length} entries — include more context` }
  if (mem.action === 'remove') {
    const entries = current.filter((_, i) => i !== hits[0])
    return { ok: true, result: 'removed', entries, chars: memoryCharsOf(entries) }
  }
  if (mem.action === 'replace') {
    const text = normalizeEntry(mem.text)
    if (text === '') return { ok: false, result: 'rejected', reason: 'empty-text' }
    const scan = scanMemoryEntry(text)
    if (scan !== null) return { ok: false, result: 'rejected', reason: scan, detail: 'entry content rejected by scanner' }
    const entries = current.map((e, i) => (i === hits[0] ? text : e))
    const chars = memoryCharsOf(entries)
    if (chars > limit) {
      return { ok: false, result: 'rejected', reason: 'over-limit', detail: `${chars}/${limit} chars after replace` }
    }
    return { ok: true, result: 'replaced', entries, chars }
  }
  return { ok: false, result: 'rejected', reason: 'unknown-action', detail: mem.action }
}

/**
 * memory writer：读库 → 纯守卫 → 整文件重排 → 原子写。skill 结论与 memory 结论
 * 同在全局串行队列内顺序执行（§3.6），插件内无并发，整文件重写免 CAS；
 * 用户手改由"写入前重读"自愈。
 * @returns {result, store, chars?, entries?, limit?, reason?, detail?}
 */
async function applyMemoryConclusion(mem, { dir = memoryDir(), limits = {}, enabled = {} } = {}) {
  const store = mem.store
  if (enabled[store] === false) return { result: 'store-disabled', store }
  const file = join(dir, store === 'user' ? 'USER.md' : 'MEMORY.md')
  const limit = limits[store]
  let raw = ''
  try { raw = await fsP.readFile(file, 'utf8') } catch { /* 新库：空文件起步 */ }
  const plan = planMemoryChange(parseMemoryEntries(raw), mem, { limit })
  if (!plan.ok) return { ...plan, store, limit }
  await atomicWrite(file, serializeMemoryEntries(store, plan.entries))
  return { result: plan.result, store, chars: plan.chars, entries: plan.entries.length, limit }
}

/**
 * 渲染注入文本（design §12.2）。readRaw(store) 由调用方提供（同步读、缺文件返回 ''），
 * 本函数只做渲染：两库全空/全关返回 ''（renderContextSections 会过滤空文本，快照整体
 * 不出现）。库里容错：单库读取失败按空库渲染，不让一次 IO 故障扩散。
 */
function renderMemoryContext(eff, readRaw) {
  const sections = []
  for (const store of MEMORY_STORES) {
    if (!memoryStoreEnabled(store, eff)) continue
    let entries = []
    try { entries = parseMemoryEntries(readRaw(store)) } catch { entries = [] }
    if (entries.length === 0) continue
    const chars = memoryCharsOf(entries)
    const title = store === 'user' ? 'USER（用户画像/偏好）' : 'MEMORY（环境/项目事实/约定/教训）'
    sections.push(`## ${title} — ${chars}/${memoryStoreLimit(store, eff)} 字符 · ${entries.length} 条\n${entries.map((e) => '§ ' + e).join('\n')}`)
  }
  if (sections.length === 0) return ''
  return [
    '# 长期记忆（跨会话持久，后台复盘按需维护；以下为最新全量快照）',
    '',
    sections.join('\n\n'),
  ].join('\n')
}

/**
 * settings 服务缺席时 POST /settings 的回退校验：有 scope 走 schemastery 完整校验，
 * 没 scope 至少挡住非法枚举与越界数字——裸 Object.assign 会让 mode:'typo' 静默落入
 * auto 直写分支（与 fail-closed 直觉相反）。
 */
function sanitizeSettingsPatch(patch) {
  if (patch === null || typeof patch !== 'object') return {}
  const out = {}
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled
  if (typeof patch.mode === 'string' && ['auto', 'approval', 'log-only'].includes(patch.mode)) out.mode = patch.mode
  if (typeof patch.provider === 'string') out.provider = patch.provider
  if (typeof patch.model === 'string') out.model = patch.model
  const num = (key, min, max) => {
    const v = patch[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && (max === undefined || v <= max)) out[key] = v
  }
  num('turnInterval', 1)
  num('toolCallInterval', 0)
  num('cooldownMinutes', 0)
  num('maxTranscriptChars', 1000)
  num('reviewTimeoutSec', 30)
  num('catalogDescriptionMax', 50)
  num('suspectsTopN', 0, 10)
  num('maxTranscriptMessages', 5, 400)
  if (typeof patch.curatorEnabled === 'boolean') out.curatorEnabled = patch.curatorEnabled
  num('curatorStaleDays', 1)
  num('curatorArchiveDays', 2)
  num('curatorIntervalHours', 1)
  if (typeof patch.signalTriggerEnabled === 'boolean') out.signalTriggerEnabled = patch.signalTriggerEnabled
  num('signalToolFailureMin', 0)
  if (typeof patch.signalCorrectionWords === 'string') out.signalCorrectionWords = patch.signalCorrectionWords
  if (typeof patch.memoryEnabled === 'boolean') out.memoryEnabled = patch.memoryEnabled
  if (typeof patch.userProfileEnabled === 'boolean') out.userProfileEnabled = patch.userProfileEnabled
  num('memoryCharLimit', 200)
  num('userCharLimit', 200)
  return out
}

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
// memory 增补段只在任一记忆库启用时出现（§12.3：两开关全关 = 协议退回 skill 单结论）。

function reviewPrompt(eff = {}) {
  const memoryOn = MEMORY_STORES.some((s) => {
    const enabled = s === 'user' ? eff.userProfileEnabled : eff.memoryEnabled
    return enabled !== false
  })
  const memorySection = memoryOn ? [
    '',
    '## 记忆（可选结论——多数复盘应该没有记忆）',
    '除 skill 外，只有对话**明确暴露**了以下内容才考虑写记忆：',
    '- 用户画像、偏好、对你行为方式的期望 → store="user"；',
    '- 环境/项目事实、约定、教训（如"发布必须 OTP""服务跑在 19080 端口"）→ store="memory"；',
    '- 流程、步骤、坑 → 仍归 skill，绝不写进记忆。',
    '按需产出：没有明确值得记的就省略 memory 字段，不为写而写——记忆库是小限额精编清单，平庸条目会挤掉真条目，而漏记几乎零成本。',
    '库接近上限时优先 replace（合并改写既有条目）或 remove（删过时条目），而不是 add。',
    '',
  ] : []
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
    ...memorySection,
    '## 分工',
    memoryOn
      ? '流程、步骤、坑 → skill；环境事实/约定/教训与用户画像 → 记忆（规则见上）。'
      : '流程、步骤、坑 → skill。用户画像/偏好类信息本轮不沉淀。',
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
    '  "rationale": "一句话：为什么值得存/不值得存",',
    ...(memoryOn ? [
      '  "memory": {                            // 可选；多数复盘应省略整个字段',
      '    "action": "nothing" | "add" | "replace" | "remove",',
      '    "store": "memory" | "user",           // add/replace/remove 必填',
      '    "text": "新条目，一句话（add/replace 必填）",',
      '    "oldText": "下方记忆条目里唯一命中一条的原文子串（replace/remove 必填）",',
      '    "rationale": "为什么记/改/删" }',
    ] : []),
    '}',
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
    extractFencedJson, parseConclusion, parseMemoryConclusion, sha256, buildSkillMd, mergeFrontmatter, applyConclusion,
    descriptionOf, atomicWrite, DEFAULTS, dshHome, globalSkillsDir, pendingDir,
    setModelInvocation, curatorTransitions, parseCorrectionWords, matchCorrectionWord, sanitizeSettingsPatch,
    memoryDir, memoryStoreFile, memoryStoreEnabled, memoryStoreLimit, normalizeEntry,
    parseMemoryEntries, serializeMemoryEntries, scanMemoryEntry, planMemoryChange,
    applyMemoryConclusion, renderMemoryContext,
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

    // ── Memory 注入通道（design §12.2，v0.5；会话首冻结，2026-09-01 用户拍板）──
    // 通道仍选 context()（动态运行时上下文）而非 section()，缓存理由变得更硬：
    // section 的 text 在 system prompt 里——那是请求前缀，任何变更都打爆整个会话的
    // prefix cache；context 快照是追加式消息，位置一旦落定不再移动，追加不伤已缓存前缀。
    // 语义对齐 Hermes：**会话首冻结**——scope 即 agent 对象，第一次 assemble 读盘渲染后
    // 冻结进 WeakMap（随 agent 回收自动清理），会话内恒定、恰一条会话首快照消息；
    // 复盘写入/手改文件对当前会话不可见，下个会话生效。
    if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
      const memoryFreeze = new WeakMap() // scope(agent) → 会话首快照文本（可为 ''）
      const memoryWarn = { at: 0 }
      const renderMemorySafe = () => {
        try {
          return renderMemoryContext(effective(), (store) => {
            try { return fs.readFileSync(memoryStoreFile(store), 'utf8') } catch { return '' }
          })
        } catch (e) {
          // 读盘/渲染故障：本会话以空快照起步（宁可空不可错），限频告警防刷日志
          const nowMs = Date.now()
          if (nowMs - memoryWarn.at > 60_000) {
            memoryWarn.at = nowMs
            ctx.logger.warn(`hermes-loop: memory context render failed, serving empty snapshot: ${e && e.message}`)
          }
          return ''
        }
      }
      ctx.effect(() => ctx.systemPrompt.context({
        name: 'hermes:memory', // 同层同名抛错——本插件唯一的 context 名
        order: 40,
        text: (asmCtx) => {
          const scope = asmCtx && typeof asmCtx === 'object' ? asmCtx.scope : undefined
          if (scope && typeof scope === 'object') {
            if (memoryFreeze.has(scope)) return memoryFreeze.get(scope)
            const text = renderMemorySafe()
            memoryFreeze.set(scope, text)
            return text
          }
          return renderMemorySafe() // 无 scope（非常规调用/测试）：现算，不冻结
        },
      }), 'hermes-loop: memory context')
      ctx.logger.info && ctx.logger.info('hermes-loop: memory context registered (~/.dsh/memory/{MEMORY,USER}.md, frozen per session)')
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
    let usageReady = false
    const usageLoaded = fsP.readFile(usageFile(), 'utf8').then((raw) => {
      const parsed = JSON.parse(raw)
      // 合并而非覆盖：加载窗口内事件可能已经改写过内存（计数/复活/纳管登记）。
      // 此刻内存里的条目只含本次启动后的增量——计数与磁盘相加，时间戳取新；
      // curator 记录则是内存态更新（可能刚被复活/登记），磁盘旧值不得盖回
      for (const [name, u] of Object.entries(parsed.usage || {})) {
        const mem = usage.get(name)
        if (mem === undefined) { usage.set(name, u); continue }
        mem.count = (mem.count || 0) + (u.count || 0)
        if (typeof u.lastUsedAt === 'string' && (typeof mem.lastUsedAt !== 'string' || Date.parse(u.lastUsedAt) > Date.parse(mem.lastUsedAt))) mem.lastUsedAt = u.lastUsedAt
      }
      for (const [name, c] of Object.entries(parsed.catalog || {})) {
        const mem = catalogSeen.get(name)
        if (mem === undefined) { catalogSeen.set(name, c); continue }
        mem.count = (mem.count || 0) + (c.count || 0)
        if (typeof c.lastAt === 'string' && (typeof mem.lastAt !== 'string' || Date.parse(c.lastAt) > Date.parse(mem.lastAt))) mem.lastAt = c.lastAt
      }
      for (const [name, rec] of Object.entries((parsed.curator && parsed.curator.skills) || {})) { if (!curatorSkills.has(name)) curatorSkills.set(name, rec) }
      Object.assign(curatorMeta, parsed.curator || {})
      delete curatorMeta.skills
    }).catch(() => {}).then(() => { usageReady = true })
    const flushUsage = () => {
      // 加载完成前绝不写盘——近乎空的内存态会盖掉磁盘上完好的 usage.json
      if (!usageReady) return Promise.resolve()
      const write = atomicWrite(usageFile(), JSON.stringify({
        savedAt: new Date().toISOString(),
        usage: Object.fromEntries(usage),
        catalog: Object.fromEntries(catalogSeen),
        curator: { ...curatorMeta, skills: Object.fromEntries(curatorSkills) },
      }, null, 2))
      write.catch((e) => trace('usage-flush-failed', { message: String(e && e.message || e) }))
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
        // archive 必须晚于 stale：schema 两个 min 各自独立，配置可能倒挂
        archiveDays: Math.max(eff.curatorArchiveDays, eff.curatorStaleDays + 1),
      })
      const applied = []
      for (const t of transitions) {
        try {
          const rec = curatorSkills.get(t.skill)
          if (rec === undefined) continue
          // 计划与执行之间隔着文件 IO——期间的手动 restore 优先：状态已变就放弃本条
          const curState = rec.state === 'stale' || rec.state === 'archived' ? rec.state : 'active'
          if (curState !== t.from) { applied.push({ ...t, note: 'state-changed-skipped' }); continue }
          if (t.to === 'archived') {
            const file = join(globalSkillsDir(), t.skill, 'SKILL.md')
            let content
            try { content = await fsP.readFile(file, 'utf8') }
            catch { curatorSkills.delete(t.skill); applied.push({ ...t, note: 'file-missing-dropped' }); continue }
            await atomicWrite(file, setModelInvocation(content, false))
          }
          rec.state = t.to
          applied.push(t)
        } catch (e) { applied.push({ ...t, error: String(e && e.message || e) }) }
      }
      const counts = curatorCounts()
      const byTo = (to) => applied.filter((t) => t.to === to).length
      curatorMeta.lastSummary = `checked ${curatorSkills.size}: +${byTo('stale')} stale, +${byTo('archived')} archived, ${byTo('active')} back to active`
      try { await flushUsage() } catch {}
      // 归档会翻 frontmatter 治理键——后台刷一次 modelInvocable 缓存，让面板状态列尽快对上
      if (applied.some((t) => t.to === 'archived')) refreshInvocable()
      trace('curator-run', { manual, summary: curatorMeta.lastSummary, applied })
      ctx.logger.info && ctx.logger.info(`hermes-loop: curator pass — ${curatorMeta.lastSummary}`)
      return { at: curatorMeta.lastRunAt, checked: curatorSkills.size, transitions: applied, counts, summary: curatorMeta.lastSummary }
    }

    /** 归档恢复：移除治理键 + state 回 active；lastRestoredAt 把 anchor 提到恢复时刻（防下轮立即再归档）。 */
    const restoreManaged = async (name) => {
      await usageLoaded // 加载窗口内的恢复会被迟到的磁盘旧值盖回——等加载完成
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
      refreshInvocable() // 恢复会移除治理键——后台刷 modelInvocable 缓存，状态列尽快对上
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
      // 每小时醒一次（巡检间隔由 eff.curatorIntervalHours 门控，不再是硬编码 12h）；
      // 顺手淘汰 7 天未活动的会话窗口——windows Map 只增不减是长存活宿主上的慢漏
      const timer = setInterval(() => {
        runCuratorPass(false).catch(() => {})
        const cutoff = Date.now() - 7 * DAY_MS
        for (const [sid, st] of windows) {
          if ((st.lastSeenAt || 0) < cutoff) windows.delete(sid)
        }
      }, 60 * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'hermes-loop: curator interval')

    const stateFor = (sessionId) => {
      let st = windows.get(sessionId)
      if (st === undefined) windows.set(sessionId, st = { turns: 0, toolCalls: 0, lastReviewAt: 0, failures: 0, signal: undefined, lastSeenAt: 0 })
      st.lastSeenAt = Date.now()
      return st
    }

    // 信号加速（v0.4）：硬信号（abort/工具失败）与软信号（纠正词）只做"标记窗口"，
    // 复盘的精确性由 review agent 的负面清单兜底——误触发的代价是一次便宜模型的 nothing。
    const markSignal = (sessionId, st, kind, detail) => {
      if (st.signal !== undefined) return // 一窗口一记，先到为准
      st.signal = { kind, at: new Date().toISOString(), detail }
      trace('signal', { sessionId, kind, detail })
    }

    const drainNext = () => {
      if (running !== null || queued.size === 0) return
      const [nextSessionId, task] = queued.entries().next().value
      queued.delete(nextSessionId)
      // 直接同步调用：running 必须在同一调用栈内置位。隔一个微任务会让并发的
      // 下一个事件也看到 running===null，串行不变量被击穿
      task().catch((e) => ctx.logger.warn(`hermes-loop: review task: ${e && e.message}`))
    }

    const runReview = async ({ session, eff, manual = false }) => {
      const sessionId = session.id
      const controller = new AbortController()
      const st = stateFor(sessionId)
      // 计数器在进入 runner 时重置（abort 也算消耗窗口，防重触发循环）；
      // 信号同样消费掉——一次复盘消化掉本窗口的加速标记
      const firedSignal = st.signal
      st.turns = 0
      st.toolCalls = 0
      st.failures = 0
      st.signal = undefined
      st.lastReviewAt = Date.now()
      running = { sessionId, controller }
      runningSince = new Date().toISOString()
      trace('review-start', { sessionId, manual, signal: firedSignal && firedSignal.kind, signalDetail: firedSignal && firedSignal.detail })

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
        const globalRoot = globalSkillsDir() + sep
        for (const suspect of suspects) {
          if (!suspect.resourceBase || suspect.resourceBase.kind !== 'directory' || typeof suspect.resourceBase.path !== 'string') continue
          // writer 只认全局库（applyConclusion 的 globalDir）——项目级技能注入 baseHash
          // 也必然 patch-missing，白白误导复盘；不注入
          if (!resolve(suspect.resourceBase.path).startsWith(globalRoot)) continue
          const file = join(suspect.resourceBase.path, 'SKILL.md')
          let content
          try { content = await fsP.readFile(file, 'utf8') } catch { continue }
          const hash = sha256(content)
          if (content.length > SUSPECT_BODY_MAX_CHARS) content = content.slice(0, SUSPECT_BODY_MAX_CHARS) + '\n…（截断）'
          // baseDescription 必须取文件全文里的完整值：目录构造时 description 被截断到
          // catalogDescriptionMax，用截断值做 CAS 基准会让长描述技能永远 cas-conflict
          suspectBlocks.push(`### suspect: ${suspect.name}\nbaseHash: ${hash}\nbaseDescription: ${JSON.stringify(descriptionOf(content) || '')}\n\n${content}`)
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

        // 3.5 当前记忆条目注入（§12.3）：replace/remove 的 oldText 定位与 add 去重都以它为基准
        const memoryOn = MEMORY_STORES.some((s) => memoryStoreEnabled(s, eff))
        let memoryBlock = ''
        if (memoryOn) {
          const storeParts = []
          for (const store of MEMORY_STORES) {
            if (!memoryStoreEnabled(store, eff)) continue
            let raw = ''
            try { raw = await fsP.readFile(memoryStoreFile(store), 'utf8') } catch { /* 新库 */ }
            const entries = parseMemoryEntries(raw)
            storeParts.push(`### ${store === 'user' ? 'USER' : 'MEMORY'}（${entries.length} 条）\n${entries.length > 0 ? entries.map((e) => '§ ' + e).join('\n') : '（空）'}`)
          }
          memoryBlock = '\n## 当前记忆条目（oldText 必须唯一命中某条原文；没有值得记的就省略 memory 字段）\n' + storeParts.join('\n\n')
        }

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
            reviewPrompt(eff),
            '\n## 既有 skill 清单（name: description）\n' + catalogText,
            suspectBlocks.length > 0 ? '\n## 疑似相关 skill 全文\n' + suspectBlocks.join('\n\n---\n\n') : '',
            memoryBlock,
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
        trace('conclusion', {
          sessionId,
          action: conclusion.action,
          skill: conclusion.skill,
          rationale: String(conclusion.rationale || '').slice(0, 300),
          memory: conclusion.memory !== undefined && conclusion.memory.action !== 'nothing'
            ? `${conclusion.memory.store}:${conclusion.memory.action}`
            : undefined,
        })
        // skill=nothing 但 memory 有动作 → 照样进 dispatch（通道独立，§12.4 不连坐）
        const hasMemoryAction = conclusion.memory !== undefined && conclusion.memory.action !== 'nothing'
        if (conclusion.action === 'nothing' && !hasMemoryAction) {
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
      const hasSkill = conclusion.action !== 'nothing'
      const hasMemory = conclusion.memory !== undefined && conclusion.memory.action !== 'nothing'
      const logHead = hasSkill
        ? `hermes-loop: ${conclusion.action} '${conclusion.skill}' (from session ${sessionId})`
        : `hermes-loop: memory ${conclusion.memory.action}@${conclusion.memory.store} (from session ${sessionId})`
      trace('dispatch', {
        sessionId, mode: eff.mode, action: conclusion.action, skill: conclusion.skill,
        memory: hasMemory ? `${conclusion.memory.store}:${conclusion.memory.action}` : undefined,
      })
      if (eff.mode === 'log-only') {
        ctx.logger.info(`${logHead} — log-only mode, not written. ${JSON.stringify(hasSkill ? conclusion : conclusion.memory)}`)
        return
      }
      if (eff.mode === 'approval') {
        const dir = pendingDir()
        // 纯记忆结论也有稳定的 pending 标识（skill 结论缺席时不留 undefined）
        const label = hasSkill ? conclusion.skill : `memory-${conclusion.memory.store}`
        const id = `${Date.now().toString(36)}-${label}`
        const payload = { id, at: new Date().toISOString(), sourceSession: sessionId, mode: eff.mode, globalDir: globalSkillsDir(), memoryDir: memoryDir(), conclusion }
        await fsP.mkdir(dir, { recursive: true })
        await atomicWrite(join(dir, `${id}.json`), JSON.stringify(payload, null, 2))
        trace('staged', { id, dir, sessionId })
        notifySourceSession(session, `后台复盘产出「${label}」已暂存待确认（mode=approval）：${(hasSkill ? conclusion.rationale : conclusion.memory.rationale) || conclusion.action}`)
        ctx.logger.info(`${logHead} — staged to ${dir} for approval`)
        return
      }
      // ── auto：skill 通道（memory 结论失败不连坐 skill，两通道独立守卫独立落盘）──
      if (hasSkill) {
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
      // ── auto：memory 通道（§12.4）──
      if (hasMemory) {
        const mem = conclusion.memory
        const outcome = await applyMemoryConclusion(mem, {
          dir: memoryDir(),
          limits: { memory: eff.memoryCharLimit, user: eff.userCharLimit },
          enabled: { memory: eff.memoryEnabled !== false, user: eff.userProfileEnabled !== false },
        })
        trace('memory-outcome', { sessionId, store: mem.store, action: mem.action, result: outcome.result, reason: outcome.reason, chars: outcome.chars, entries: outcome.entries })
        const memHead = `hermes-loop: memory ${mem.action}@${mem.store} (from session ${sessionId})`
        const verb = { added: '写入', replaced: '改写', removed: '移除' }[outcome.result]
        if (verb !== undefined) {
          ctx.logger.info(`${memHead} — ${outcome.result} (${outcome.chars}/${outcome.limit} chars, ${outcome.entries} entries)`)
          // 注入是会话首冻结（§12.2）：明示"下个会话生效"，不让用户以为当前会话立即可见
          notifySourceSession(session, `后台复盘已${verb}记忆（${mem.store.toUpperCase()}，${outcome.chars}/${outcome.limit} 字符，下个会话生效）${mem.rationale ? `：${mem.rationale}` : ''}`)
        } else if (outcome.result === 'rejected') {
          ctx.logger.warn(`${memHead} — rejected: ${outcome.reason}. ${outcome.detail || ''}`)
        } else {
          ctx.logger.warn(`${memHead} — ${outcome.result}`)
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
        // 工具失败突发（硬信号）：tool/result 失败在窗口内累计，超阈值即加速
        if (event.type === 'tool/result') {
          const failed = event.data && ((event.data.message && event.data.message.isError === true) || event.data.error !== undefined)
          if (failed) {
            const st = stateFor(sessionId)
            st.failures += 1
            if (eff.signalTriggerEnabled && eff.signalToolFailureMin > 0 && st.failures >= eff.signalToolFailureMin) {
              markSignal(sessionId, st, 'tool-failure', `${st.failures} tool failures in window`)
            }
          }
          return
        }
        // 纠正词（软信号）：只匹配真实用户输入（kind=user），我们自己的 plugin notice
        // 和 skill-catalog 注入天然不会命中
        if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
          if (eff.signalTriggerEnabled) {
            const hit = matchCorrectionWord(contentToText(event.data.content), parseCorrectionWords(eff.signalCorrectionWords))
            if (hit !== undefined) markSignal(sessionId, stateFor(sessionId), 'correction', hit)
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
        const endedAs = reasonKind(event.data && event.data.reason)
        // 用户中断（硬信号）：aborted turn 此前只被排除计数——现在反向用作触发理由
        if (endedAs === 'aborted') {
          if (eff.signalTriggerEnabled) markSignal(sessionId, stateFor(sessionId), 'abort', 'user stopped the turn')
          return
        }
        if (endedAs !== 'completed') return

        const st = stateFor(sessionId)
        st.turns += 1
        const cooledDown = Date.now() - st.lastReviewAt >= eff.cooldownMinutes * 60 * 1000
        const hitTurn = eff.turnInterval > 0 && st.turns >= eff.turnInterval
        const hitTools = eff.toolCallInterval > 0 && st.toolCalls >= eff.toolCallInterval
        const accelerated = st.signal !== undefined
        trace('threshold', { sessionId, turns: st.turns, toolCalls: st.toolCalls, cooledDown, hitTurn, hitTools, accelerated })
        // 信号命中 → 跳过 turn/工具阈值提前结算；冷却仍然生效（防刷屏），
        // 冷却期内的标记保留到冷却结束后的下一个 turn 尾再消费
        if (!cooledDown || (!hitTurn && !hitTools && !accelerated)) return

        const task = () => runReview({ session, eff })
        if (running === null) {
          // 同步直调（running 立即置位），不隔微任务
          task().catch((e) => ctx.logger.warn(`hermes-loop: review task: ${e && e.message}`))
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
        flushUsage() // 无条件冲洗（内部有 usageReady 门）：curator-only 脏态也不能丢
        if (running !== null) running.controller.abort() // runner finally 里 dispose agent
      }
    }, 'hermes-loop: session/event subscription')

    // ── Client API（web 面板的唯一数据源；宿主面动态注入 webServer 是可用路径）──
    // modelInvocable 快照缓存（stale-while-revalidate）：ctx.skills.snapshot() 在宿主
    // 技能目录缓存失效后（任何技能文件变动都会触发）做全量重扫，本机实测 ~3.7s。/status
    // 若 await 它，每次打开面板 tab、以及轮询撞上冷缓存时都会卡数秒（界面只剩「…」）。
    // 策略：请求路径永远只读插件内缓存；过期才后台单飞刷新，刷新完成前回上次已知值
    // （首启首刷完成前状态列为「—」，面板图例已覆盖该语义）。
    let invocableCache = null // { at: ms, map: Map<name, boolean> } | null
    let invocableInflight = null
    const INVOCABLE_TTL_MS = 60_000
    const refreshInvocable = () => {
      if (invocableInflight !== null) return invocableInflight
      invocableInflight = (async () => {
        try {
          const snapshot = await ctx.skills.snapshot({})
          invocableCache = {
            at: Date.now(),
            map: new Map((snapshot.skills || []).map((s) => [s.name, !(s.invocation && s.invocation.modelInvocable === false)])),
          }
        } catch { /* 刷新失败：保留旧缓存，下轮再试 */ }
        finally { invocableInflight = null }
      })()
      return invocableInflight
    }
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
        sessions[sid] = { turns: st.turns, toolCalls: st.toolCalls, lastReviewAt: st.lastReviewAt || undefined, failures: st.failures, signal: st.signal && st.signal.kind }
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
          currentReview = { at: e.at, sessionId: e.sessionId, outcome: 'running', action: undefined, skill: undefined, rationale: undefined, suspects: undefined, catalogSize: undefined, messages: undefined, detail: undefined, signal: e.signal }
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
      // 目录快照提供每个技能当前的 modelInvocable（frontmatter 治理键的实时状态）。
      // 绝不在此 await 冷重扫（见 refreshInvocable 注释）：立即回上次已知值，过期才后台刷新
      if (invocableCache === null || Date.now() - invocableCache.at > INVOCABLE_TTL_MS) refreshInvocable()
      const invocableByName = invocableCache !== null ? invocableCache.map : null
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
      // 信号加速的"命中率"面板数据（§信号加速设计：智能不在词表，在度量）：
      // 近期信号次数按类型分布 + 信号触发的复盘数 + 其中产出沉淀的复盘数
      const signalEvents = activity.filter((e) => e.event === 'signal')
      const signalStats = {
        total: signalEvents.length,
        abort: signalEvents.filter((e) => e.kind === 'abort').length,
        toolFailure: signalEvents.filter((e) => e.kind === 'tool-failure').length,
        correction: signalEvents.filter((e) => e.kind === 'correction').length,
        triggeredReviews: reviews.filter((r) => r.signal).length,
        yieldedReviews: reviews.filter((r) => r.signal && (r.outcome === 'created' || r.outcome === 'patched' || r.outcome === 'staged')).length,
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
      // Memory 通道面板数据（§12.5）：双库用量走注入函数的同一读取路径；
      // lastWriteAt/lastOutcome 从 activity 尾部取，不新增持久化状态
      const memory = { stores: {} }
      let lastMemoryOutcome
      for (const e of activity) {
        if (e.event === 'memory-outcome') lastMemoryOutcome = e
      }
      for (const store of MEMORY_STORES) {
        let raw = ''
        try { raw = await fsP.readFile(memoryStoreFile(store), 'utf8') } catch { /* 新库 */ }
        const entries = parseMemoryEntries(raw)
        memory.stores[store] = {
          enabled: memoryStoreEnabled(store, eff),
          chars: memoryCharsOf(entries),
          limit: memoryStoreLimit(store, eff),
          entries: entries.length,
          // 只读条目原文（面板"查看条目"用）；entries 仍是计数。库上限 ~2K 字符，
          // 条目数天然有限，40 的截断只是防御手写超小条目刷屏
          items: entries.slice(0, 40),
          lastWriteAt: lastMemoryOutcome && lastMemoryOutcome.store === store ? lastMemoryOutcome.at : undefined,
        }
      }
      memory.lastOutcome = lastMemoryOutcome
        ? { at: lastMemoryOutcome.at, store: lastMemoryOutcome.store, action: lastMemoryOutcome.action, result: lastMemoryOutcome.result, reason: lastMemoryOutcome.reason }
        : undefined
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
        signals: signalStats,
        memory,
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
                else Object.assign(config, sanitizeSettingsPatch(body.patch)) // 无 settings 服务时的降级路径也要校验
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
                const wasRunning = running !== null
                const task = () => runReview({ session, eff: effective(), manual: true })
                if (!wasRunning) {
                  task().catch((e) => ctx.logger.warn(`hermes-loop: manual review: ${e && e.message}`)) // 同步直调置 running
                } else {
                  queued.set(sessionId, task) // 排队（顶替同 session 旧任务），running 结束后 drainNext
                }
                trace('manual-review-requested', { sessionId, queued: wasRunning })
                sendJson(res, 202, { ok: true, state: wasRunning ? 'queued' : 'started' })
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
