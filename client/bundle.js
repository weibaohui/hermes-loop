/* dsh-plugin-hermes-loop — browser half (hand-rolled loader bundle, no build step).
 *
 * One tab in the conversation view ring ("Hermes Loop"), next to 对话/轨迹/上下文.
 * Data comes exclusively from the host half's /hermes-loop/api/* routes — the
 * client holds no loop state of its own. Function components only (class
 * components silently never render in the plugin loader) and no createRoot
 * (render through the slot tree). Colors ride the --dsw-* theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-hermes-loop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var DICT = {
      zh: {
        tab: 'Hermes Loop',
        disabled: '学习循环未启用',
        enabled: '运行中',
        mode: '模式',
        'mode.auto': '自动写入',
        'mode.approval': '待审批',
        'mode.log-only': '仅记录',
        thresholds: '触发阈值',
        turns: '轮次',
        toolCalls: '工具调用',
        progress: '本会话进度',
        cooldown: '冷却',
        cooldownReady: '已就绪',
        cooldownWait: '{s}s 后可用',
        running: 'review 正在运行…',
        queued: '{n} 个 review 排队中',
        idle: '当前无 review',
        written: '沉淀的技能',
        usage: '技能使用统计',
        'usage.calls': '调用',
        'usage.last': '最近使用',
        'usage.status': '状态',
        'usage.modelVisible': '模型可见',
        'usage.modelDisabled': '已隐藏',
        'usage.statusHelp': '状态说明——模型可见：技能会注入到每个对话的技能目录，模型可用 skill 工具加载它；已隐藏：技能标记了 disable-model-invocation，保留在库里但不再注入目录；横杠（—）：调用列的横杠表示从未被模型调用过，状态列的横杠表示该技能当前不在模型目录里（可能已被隐藏或卸载）。',
        'usage.summary': '总调用 {n} 次 · 目录曝光 {c} 条 · 其中 {z} 条从未被调用',
        'usage.empty': '还没有技能调用记录 —— 模型通过 skill 工具加载技能时会在这里计数',
        'written.tab.session': '本对话',
        'written.tab.plugin': '本插件',
        'written.sessionEmpty': '本对话还没有沉淀 —— 攒够触发阈值后，后台复盘的产物会出现在这里',
        'written.pluginEmpty': '还没有任何沉淀记录',
        activity: '活动时间线',
        activityEmpty: '暂无活动',
        refresh: '刷新',
        manual: '立即复盘',
        manualQueued: '已加入复盘队列',
        preview: 'review 实时输出',
        elapsed: '已运行 {s}s',
        saved: '已保存',
        saveFailed: '保存失败',
        'action.create': '新建',
        'action.patch': '修补',
        'action.staged': '待审',
      },
      en: {
        tab: 'Hermes Loop',
        disabled: 'Learning loop disabled',
        enabled: 'Active',
        mode: 'Mode',
        'mode.auto': 'Auto write',
        'mode.approval': 'Approval',
        'mode.log-only': 'Log only',
        thresholds: 'Trigger thresholds',
        turns: 'turns',
        toolCalls: 'tool calls',
        progress: 'This session',
        cooldown: 'Cooldown',
        cooldownReady: 'ready',
        cooldownWait: 'in {s}s',
        running: 'review running…',
        queued: '{n} review(s) queued',
        idle: 'no review in flight',
        written: 'Distilled skills',
        usage: 'Skill usage stats',
        'usage.calls': 'calls',
        'usage.last': 'last used',
        'usage.status': 'status',
        'usage.modelVisible': 'model-visible',
        'usage.modelDisabled': 'hidden',
        'usage.statusHelp': 'Status legend — model-visible: injected into every conversation catalog, loadable via the skill tool; hidden: marked disable-model-invocation, kept in the library but not injected; dash (—): in the calls column it means never invoked by the model, in the status column it means the skill is not in the current model catalog.',
        'usage.summary': '{n} calls total · {c} catalog entries · {z} never invoked',
        'usage.empty': 'No usage yet — counts land here when the model loads a skill',
        'written.tab.session': 'This session',
        'written.tab.plugin': 'This plugin',
        'written.sessionEmpty': 'Nothing from this conversation yet — reviews appear here once the threshold fires',
        'written.pluginEmpty': 'No distilled skills yet',
        activity: 'Activity timeline',
        activityEmpty: 'No activity',
        refresh: 'Refresh now',
        manual: 'Review now',
        manualQueued: 'Queued for review',
        preview: 'Live review output',
        elapsed: 'running {s}s',
        saved: 'Saved',
        saveFailed: 'Save failed',
        'action.create': 'create',
        'action.patch': 'patch',
        'action.staged': 'staged',
      },
    }

    var STYLES = [
      '.hl-wrap{display:flex;flex-direction:column;gap:14px;padding:16px 20px;overflow:auto;height:100%;',
      '  font-size:13px;color:var(--dsw-alias-label-1,inherit);box-sizing:border-box}',
      '.hl-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.hl-title{font-weight:600;font-size:15px}',
      '.hl-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-positive,#3aa76d);display:inline-block}',
      '.hl-dot.off{background:var(--dsw-alias-state-negative,#c75050)}',
      '.hl-dot.busy{background:var(--dsw-alias-state-warning,#d99a2b);animation:hl-pulse 1.2s infinite}',
      '@keyframes hl-pulse{50%{opacity:.35}}',
      '.hl-card{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;padding:12px 14px}',
      '.hl-card h3{margin:0 0 8px;font-size:12px;font-weight:600;opacity:.7;text-transform:uppercase;letter-spacing:.04em}',
      '.hl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0}',
      '.hl-bar{flex:1;min-width:120px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));overflow:hidden}',
      '.hl-bar>i{display:block;height:100%;background:var(--dsw-alias-state-positive,#3aa76d);border-radius:3px}',
      '.hl-bar.warn>i{background:var(--dsw-alias-state-warning,#d99a2b)}',
      '.hl-num{font-variant-numeric:tabular-nums;opacity:.75;white-space:nowrap}',
      '.hl-chip{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer;background:transparent;color:inherit}',
      '.hl-chip.on{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2));font-weight:600}',
      '.hl-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.hl-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.hl-skill{font-weight:600;font-family:ui-monospace,monospace;font-size:12px}',
      '.hl-path{opacity:.55;font-size:11px;font-family:ui-monospace,monospace;word-break:break-all}',
      '.hl-tag{font-size:11px;border-radius:4px;padding:1px 6px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.2))}',
      '.hl-err{color:var(--dsw-alias-state-negative,#c75050)}',
      '.hl-mut{opacity:.55}',
      '.hl-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.hl-table th{text-align:left;font-weight:500;padding:2px 8px 4px 0;color:var(--dsw-alias-label-secondary,inherit)}',
      '.hl-table td{padding:3px 8px 3px 0;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.15));font-variant-numeric:tabular-nums}',
      '.hl-scroll{max-height:260px;overflow:auto}',
      '.hl-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:50%;font-size:10px;color:var(--dsw-alias-label-secondary,inherit);cursor:help;vertical-align:middle}',
      '.hl-help::after{content:attr(data-tip);position:absolute;top:calc(100% + 8px);right:-6px;z-index:60;width:min(360px,72vw);white-space:normal;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-1,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:10px 12px;font-size:12px;font-weight:400;line-height:1.7;text-align:left;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .12s}',
      '.hl-help:hover::after{opacity:1}',
    ].join('')

    var fmtTime = function (iso) {
      if (!iso) return ''
      var d = new Date(iso)
      return isNaN(d.getTime()) ? '' : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2)
    }
    var pct = function (v, max) { return max > 0 ? Math.min(100, Math.round(v / max * 100)) : 0 }

    var Bar = function (props) {
      return h('div', { className: 'hl-row' },
        h('span', null, props.label),
        h('div', { className: 'hl-bar' + (props.pct >= 100 ? ' warn' : '') },
          h('i', { style: { width: props.pct + '%' } })),
        h('span', { className: 'hl-num' }, props.value + ' / ' + props.max))
    }

    var makeView = function (t) {
      return function HermesLoopView(props) {
        var sessionId = props.sessionId
        var _s = React.useState(null)
        var data = _s[0]
        var setData = _s[1]
        var _e = React.useState(null)
        var error = _e[0]
        var setError = _e[1]
        var _n = React.useState(0)
        var nonce = _n[0]
        var setNonce = _n[1]
        var _f = React.useState(false)
        var flash = _f[0]
        var setFlash = _f[1]
        var _w = React.useState('session')
        var writtenTab = _w[0]
        var setWrittenTab = _w[1]

        React.useEffect(function () {
          var alive = true
          var load = function () {
            fetch('/hermes-loop/api/status?sessionId=' + encodeURIComponent(sessionId || ''))
              .then(function (r) { return r.json() })
              .then(function (d) { if (alive) { setData(d); setError(null) } })
              .catch(function (e) { if (alive) setError(String(e && e.message || e)) })
          }
          load()
          var timer = setInterval(load, 4000)
          return function () { alive = false; clearInterval(timer) }
        }, [sessionId, nonce])

        var saveMode = function (mode) {
          fetch('/hermes-loop/api/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: { mode: mode } }),
          }).then(function () { setNonce(function (n) { return n + 1 }); setFlash(true); setTimeout(function () { setFlash(false) }, 1500) })
            .catch(function () {})
        }

        var manualState = React.useState(null) // null | 'queued' | 'started' | 'already-running'
        var manualFlash = manualState[0]
        var setManualFlash = manualState[1]
        var reviewNow = function () {
          fetch('/hermes-loop/api/review-now', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId || '' }),
          }).then(function (r) { return r.json() })
            .then(function (d) { setManualFlash(d.state || 'started'); setTimeout(function () { setManualFlash(null) }, 2500); setNonce(function (n) { return n + 1 }) })
            .catch(function () {})
        }

        if (error !== null && data === null) {
          return h('div', { className: 'hl-wrap' }, h('div', { className: 'hl-err' }, error))
        }
        if (data === null) return h('div', { className: 'hl-wrap hl-mut' }, '…')

        var eff = data.settings || {}
        var cur = data.current || {}
        var runningReview = data.running !== null && data.running !== undefined
        var cooldownLeft = 0
        if (eff.cooldownMinutes > 0 && cur.lastReviewAt) {
          var remainMs = eff.cooldownMinutes * 60000 - (Date.now() - cur.lastReviewAt)
          if (remainMs > 0) cooldownLeft = Math.ceil(remainMs / 1000)
        }
        var turnsMax = eff.turnInterval > 0 ? eff.turnInterval : 0
        var toolsMax = eff.toolCallInterval > 0 ? eff.toolCallInterval : 0

        return h('div', { className: 'hl-wrap' },
          // 状态头
          h('div', { className: 'hl-head' },
            h('span', { className: 'hl-dot' + (eff.enabled === false ? ' off' : runningReview ? ' busy' : '') }),
            h('span', { className: 'hl-title' }, t('tab')),
            h('span', { className: 'hl-mut' },
              eff.enabled === false ? t('disabled')
                : runningReview ? t('running')
                : (data.queuedCount > 0 ? t('queued', { n: data.queuedCount }) : t('idle'))),
            h('span', { style: { flex: 1 } }),
            h('button', {
              className: 'hl-chip' + (runningReview ? ' on' : ''),
              disabled: runningReview === true,
              title: runningReview ? t('running') : undefined,
              onClick: reviewNow,
            }, t('manual')),
            h('button', { className: 'hl-chip', onClick: function () { setNonce(function (n) { return n + 1 }) } }, t('refresh')),
            flash ? h('span', { className: 'hl-mut' }, t('saved')) : null),
          runningReview && data.running.preview
            ? h('div', { className: 'hl-card' },
              h('h3', null, t('preview')),
              h('div', { style: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace,monospace', fontSize: '11px', opacity: .75, maxHeight: '160px', overflow: 'auto' } },
                String(data.running.preview).slice(-800)))
            : null,
          manualFlash === 'queued' || manualFlash === 'already-running' ? h('div', { className: 'hl-mut' }, t('manualQueued')) : null,

          // 设置卡：模式 + 阈值
          h('div', { className: 'hl-card' },
            h('h3', null, t('thresholds')),
            h('div', { className: 'hl-row' },
              h('span', { className: 'hl-mut' }, t('mode')),
              ['auto', 'approval', 'log-only'].map(function (m) {
                return h('button', {
                  key: m,
                  className: 'hl-chip' + (eff.mode === m ? ' on' : ''),
                  onClick: function () { saveMode(m) },
                }, t('mode.' + m))
              }),
              flash ? h('span', { className: 'hl-mut' }, t('saved')) : null),
            h('div', { className: 'hl-row hl-mut' },
              t('turns') + ' ≥ ' + eff.turnInterval,
              ' · ',
              t('toolCalls') + ' ≥ ' + eff.toolCallInterval,
              ' · ',
              t('cooldown') + ' ' + eff.cooldownMinutes + 'min')),

          // 本会话进度
          h('div', { className: 'hl-card' },
            h('h3', null, t('progress')),
            turnsMax > 0 ? h(Bar, { label: t('turns'), value: cur.turns || 0, max: turnsMax, pct: pct(cur.turns || 0, turnsMax) }) : null,
            toolsMax > 0 ? h(Bar, { label: t('toolCalls'), value: cur.toolCalls || 0, max: toolsMax, pct: pct(cur.toolCalls || 0, toolsMax) }) : null,
            h('div', { className: 'hl-row hl-mut' },
              t('cooldown') + ': ' + (cooldownLeft > 0 ? t('cooldownWait', { s: cooldownLeft }) : t('cooldownReady')))),

          // 沉淀产物：本对话（默认）/ 本插件 两个子 tab
          (function () {
            var all = data.written || []
            var rows = writtenTab === 'session'
              ? all.filter(function (w) { return w.sessionId && w.sessionId === sessionId })
              : all
            var emptyText = writtenTab === 'session' ? t('written.sessionEmpty') : t('written.pluginEmpty')
            return h('div', { className: 'hl-card' },
              h('h3', null, t('written')),
              h('div', { className: 'hl-row', style: { marginBottom: '6px' } },
                ['session', 'plugin'].map(function (tabKey) {
                  return h('button', {
                    key: tabKey,
                    className: 'hl-chip' + (writtenTab === tabKey ? ' on' : ''),
                    onClick: function () { setWrittenTab(tabKey) },
                  }, t('written.tab.' + tabKey))
                }),
              h('span', { className: 'hl-mut hl-num' }, rows.length)),
              rows.length > 0
                ? h('ul', { className: 'hl-list' }, rows.map(function (w, i) {
                  return h('li', { key: i },
                    h('span', { className: 'hl-tag' }, t('action.' + (w.action || 'create'))),
                    h('span', { className: 'hl-skill' }, w.skill),
                    h('span', { className: 'hl-mut' }, fmtTime(w.at)),
                    w.result && w.result !== 'created' && w.result !== 'patched'
                      ? h('span', { className: 'hl-err hl-mut' }, w.result) : null,
                    w.path ? h('span', { className: 'hl-path' }, w.path) : null)
                }))
                : h('div', { className: 'hl-mut' }, emptyText))
          })(),

          // 技能使用统计（模型经 skill 工具的真实调用 + 目录曝光）
          (function () {
            var u = data.usage || { rows: [], totalCalls: 0, catalogEntries: 0, neverCalled: 0 }
            return h('div', { className: 'hl-card' },
              h('h3', null, t('usage')),
              u.rows.length > 0
                ? h('div', null,
                  h('div', { className: 'hl-row hl-mut' }, t('usage.summary', { n: u.totalCalls, c: u.catalogEntries, z: u.neverCalled })),
                  h('div', { className: 'hl-scroll' },
                    h('table', { className: 'hl-table' },
                      h('thead', null, h('tr', null,
                        h('th', null, t('tab')),
                        h('th', null, t('usage.calls')),
                        h('th', null, t('usage.last')),
                        h('th', null, t('usage.status'), ' ',
                          h('span', { className: 'hl-help', 'data-tip': t('usage.statusHelp') }, '?')))),
                      h('tbody', null, u.rows.map(function (row, i) {
                        var zombie = row.count === 0
                        var statusText = row.modelInvocable === undefined ? '—' : (row.modelInvocable ? t('usage.modelVisible') : t('usage.modelDisabled'))
                        return h('tr', { key: i, style: zombie ? { opacity: .6 } : null },
                          h('td', { className: 'hl-skill' }, row.skill),
                          h('td', null, zombie ? h('span', { className: 'hl-help hl-mut', 'data-tip': t('usage.statusHelp') }, '—') : row.count),
                          h('td', { className: 'hl-mut' }, row.lastUsedAt ? fmtTime(row.lastUsedAt) : h('span', { className: 'hl-help', 'data-tip': t('usage.statusHelp') }, '—')),
                          h('td', null, h('span', { className: 'hl-tag' + (row.modelInvocable === false ? ' hl-err' : '') }, statusText)))
                      })))))
                : h('div', { className: 'hl-mut' }, t('usage.empty')))
          })(),
        )
      }
    }

    module.exports = {
      name: 'dsh-plugin-hermes-loop',
      inject: ['slots', 'locale'],
      apply: function (ctx) {
        var NS = 'hermes-loop'
        try { ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }) } catch (e) { /* locale service contract drift: fall back to zh */ }
        var t = function (key, params) {
          var dict = DICT.zh
          var text = dict[key]
          if (text === undefined) return key
          if (params !== undefined && params !== null) {
            for (var k in params) text = text.split('{' + k + '}').join(String(params[k]))
          }
          return text
        }
        try {
          var bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') t = function (key, params) {
            var text = bound(key, params)
            return text === undefined || text === null || text === key ? (function () {
              var zh = DICT.zh[key]
              if (zh === undefined) return key
              if (params !== undefined && params !== null) {
                for (var k in params) zh = zh.split('{' + k + '}').join(String(params[k]))
              }
              return zh
            })() : text
          }
        } catch (e) { /* keep zh fallback */ }

        ctx.effect(function () {
          var tag = document.createElement('style')
          tag.setAttribute('data-plugin', 'dsh-plugin-hermes-loop')
          tag.textContent = STYLES
          document.head.appendChild(tag)
          return function () { if (tag.parentNode !== null) tag.parentNode.removeChild(tag) }
        }, 'hermes-loop: client styles')

        var View = makeView(t)
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register(
            // order 25：排在 Chat(0)/Trajectory(10)/Context(20) 之后
            { name: 'conversation.view', id: 'hermes-loop', order: 25, locale: NS, label: function () { return t('tab') } },
            function (props) { return h(View, props) }
          )
        })
      },
    }

    return module.exports
  },
})
