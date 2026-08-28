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
        written: '本插件沉淀的技能',
        writtenEmpty: '还没有沉淀记录 —— 正常对话积累到阈值后会出现',
        activity: '活动时间线',
        activityEmpty: '暂无活动',
        refresh: '刷新',
        saved: '已保存',
        saveFailed: '保存失败',
        'ev.threshold': '计数达到阈值',
        'ev.review-start': 'review 开始',
        'ev.review-inputs': 'review 输入就绪',
        'ev.review-agent-created': 'review agent 已创建',
        'ev.review-output': 'review 输出结论',
        'ev.dispatch': '分发结论',
        'ev.write-outcome': '写入结果',
        'ev.staged': '进入待审批',
        'ev.review-error': 'review 出错',
        'ev.armed': '循环启动',
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
        written: 'Skills distilled by this loop',
        writtenEmpty: 'Nothing yet — accumulate turns to reach the threshold',
        activity: 'Activity timeline',
        activityEmpty: 'No activity',
        refresh: 'Refresh',
        saved: 'Saved',
        saveFailed: 'Save failed',
        'ev.threshold': 'Threshold reached',
        'ev.review-start': 'Review started',
        'ev.review-inputs': 'Review inputs ready',
        'ev.review-agent-created': 'Review agent created',
        'ev.review-output': 'Review conclusion',
        'ev.dispatch': 'Conclusion dispatched',
        'ev.write-outcome': 'Write outcome',
        'ev.staged': 'Staged for approval',
        'ev.review-error': 'Review error',
        'ev.armed': 'Loop armed',
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
      '.hl-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12px}',
      '.hl-timeline li{display:flex;gap:8px;opacity:.85}',
      '.hl-timeline time{opacity:.55;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.hl-err{color:var(--dsw-alias-state-negative,#c75050)}',
      '.hl-mut{opacity:.55}',
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
            h('button', { className: 'hl-chip', onClick: function () { setNonce(function (n) { return n + 1 }) } }, t('refresh')),
            flash ? h('span', { className: 'hl-mut' }, t('saved')) : null),

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

          // 沉淀产物
          h('div', { className: 'hl-card' },
            h('h3', null, t('written')),
            data.written && data.written.length > 0
              ? h('ul', { className: 'hl-list' }, data.written.map(function (w, i) {
                return h('li', { key: i },
                  h('span', { className: 'hl-tag' }, t('action.' + (w.action || 'create'))),
                  h('span', { className: 'hl-skill' }, w.skill),
                  h('span', { className: 'hl-mut' }, fmtTime(w.at)),
                  w.result && w.result !== 'created' && w.result !== 'patched'
                    ? h('span', { className: 'hl-err hl-mut' }, w.result) : null,
                  w.path ? h('span', { className: 'hl-path' }, w.path) : null)
              }))
              : h('div', { className: 'hl-mut' }, t('writtenEmpty'))),

          // 活动时间线
          h('div', { className: 'hl-card' },
            h('h3', null, t('activity')),
            data.activity && data.activity.length > 0
              ? h('ul', { className: 'hl-timeline' }, data.activity.slice().reverse().slice(0, 30).map(function (e, i) {
                return h('li', { key: i },
                  h('time', null, fmtTime(e.at)),
                  h('span', { className: e.event === 'review-error' ? 'hl-err' : null }, t('ev.' + e.event)),
                  e.skill ? h('span', { className: 'hl-skill' }, e.skill) : null,
                  e.message ? h('span', { className: 'hl-mut' }, String(e.message).slice(0, 120)) : null)
              }))
              : h('div', { className: 'hl-mut' }, t('activityEmpty'))))
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
  },
})
