/**
 * Refactoring UI §2.1 / §3.6 / §4.1：先按内容重要性设计四种布局。
 * 主：仓库与动态标题；次：类型、编号、统计；辅：作者、时间与来源。静态卡片无主按钮。
 * 间距 4/8/12/16/24/32/48/64，字号 12/16/20/24/30/36/48，字重 400/600。
 * 浅色沿用现有深蓝/青绿；深色补全冷灰尺度，纸感使用算法生成暖灰尺度。
 * §5.3.3 / §5.4：Python 不可用，以下 JS 按技能算法二分亮度、补偿饱和度与限幅旋转色相。
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const directory = fileURLToPath(new URL('.', import.meta.url))
const source = { ink: '#182b43', surface: '#ffffff', canvas: '#e9eef5', muted: '#68788d', accent: '#237562', mint: '#8de1ce' }
const hslHex = (h, s, l) => {
  s /= 100; l /= 100
  const a = s * Math.min(l, 1 - l)
  const channel = n => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}
const ramp = (h0, s0, l0 = 50) => {
  const L = { 100: 98, 500: l0, 900: 17 }
  L[700] = (L[900] + L[500]) / 2; L[300] = (L[500] + L[100]) / 2
  for (const [n, a, b] of [[800, 900, 700], [600, 700, 500], [400, 500, 300], [200, 300, 100]]) L[n] = (L[a] + L[b]) / 2
  L[50] = L[100] + (100 - L[100]) * .55; L[950] = L[900] * .55
  return Object.fromEntries(Object.entries(L).map(([n, l]) => {
    const delta = target => (target - h0 + 540) % 360 - 180
    const target = (l > l0 ? [60, 180, 300] : [0, 120, 240]).sort((a, b) => Math.abs(delta(a)) - Math.abs(delta(b)))[0]
    const h = h0 + Math.max(-20, Math.min(20, delta(target) * Math.abs(l - l0) / (l > l0 ? 100 - l0 : l0)))
    const s = Math.min(100, s0 * (Math.max(.000001, 1 - Math.abs(2 * l0 / 100 - 1)) / Math.max(.000001, 1 - Math.abs(2 * l / 100 - 1))) ** .55)
    return [n, hslHex(h, s, l)]
  }))
}
const cool = ramp(220, 12), warm = ramp(35, 12)
const palettes = {
  a: { canvas: source.canvas, surface: source.surface, ink: source.ink, muted: source.muted, accent: source.accent, tint: source.canvas, line: source.canvas },
  b: { canvas: source.canvas, surface: source.surface, ink: source.ink, muted: source.muted, accent: source.accent, tint: source.canvas, line: source.canvas },
  c: { canvas: cool[950], surface: source.ink, ink: source.surface, muted: cool[300], accent: source.mint, tint: cool[950], line: cool[700] },
  d: { canvas: warm[200], surface: warm[50], ink: warm[900], muted: warm[700], accent: warm[900], tint: warm[100], line: warm[300] }
}
const luminance = hex => {
  const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
}
const pairs = Object.entries(palettes).flatMap(([name, palette]) => ['ink', 'muted', 'accent'].map(role => ({ name: `${name}-${role}`, fg: palette[role], bg: palette.surface })))
pairs.push({ name: 'b-header', fg: source.surface, bg: source.ink }, { name: 'b-header-muted', fg: source.mint, bg: source.ink },
  { name: 'a-label', fg: source.accent, bg: source.canvas }, { name: 'b-stats', fg: source.ink, bg: source.canvas },
  { name: 'c-code', fg: source.mint, bg: cool[950] }, { name: 'd-note', fg: warm[700], bg: warm[100] })
for (const pair of pairs) {
  const a = luminance(pair.fg), b = luminance(pair.bg)
  pair.ratio = Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2))
  if (pair.ratio < 4.5) throw new Error(`${pair.name} contrast ${pair.ratio}`)
}
await writeFile(join(directory, 'design-tokens.json'), JSON.stringify({ primitive: { source, cool, warm }, semantic: palettes,
  spacing: [4, 8, 12, 16, 24, 32, 48, 64], type: [12, 16, 20, 24, 30, 36, 48], weights: [400, 600], pairs }, null, 2))
const tokens = Object.entries(palettes).map(([name, palette]) => `.variant-${name}{${Object.entries(palette).map(([key, value]) => `--${key}:${value}`).join(';')}}`).join('\n')
await writeFile(join(directory, 'tokens.css'), tokens)

const events = [
  { type: 'Commit', kind: 'commit', id: 'fa120c34', title: '支持 GitHub、Gitee、GitCode 多平台动态订阅', author: 'Developer', time: '16:00', prefix: 'feat' },
  { type: 'Issue', kind: 'issue', id: '#123', title: '在面板配置 Token 与订阅，首次订阅不推送历史', author: '测试用户', time: '17:00', prefix: '' },
  { type: 'PR', kind: 'pr', id: '#124', title: '修复机器人离线重连后的动态重试与队列恢复', author: 'Contributor', time: '17:10', prefix: 'fix' },
  { type: 'Release', kind: 'release', id: 'v0.1.0', title: 'Git-Plugin v0.1.0 首个发布版本', author: 'Maintainer', time: '17:30', prefix: '' }
]
const icons = {
  commit: '<circle cx="12" cy="12" r="4"/><path d="M3 12h5m8 0h5"/>',
  issue: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10m12 0v-6a6 6 0 0 0-6-6m0 0 3-3m-3 3 3 3"/>',
  release: '<path d="M3 3h8l10 10-8 8L3 11Z"/><circle cx="7.5" cy="7.5" r="1"/>'
}
const icon = kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]}</svg>`
const title = event => `${event.prefix ? `${event.prefix}: ` : ''}${event.title}`
const footer = '<footer><span>Git-Plugin</span><span>UTC+8 · 详情链接见随附文字</span></footer>'
const common = `
${tokens}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font-family:"Segoe UI","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;font-weight:400;font-size:16px;line-height:1.5;color-scheme:light}
h1,h2,h3,p{margin:0}h1,h2,h3,strong{font-weight:600}h1{line-height:1.15;font-size:36px}h2{font-size:20px;line-height:1.5;overflow-wrap:anywhere}ul,ol{list-style:none;margin:0;padding:0}
#container{width:100%;max-width:800px;margin-inline:auto;padding:32px}.sheet{background:var(--surface)}.muted{color:var(--muted)}.accent{color:var(--accent)}
.mono{font-family:Consolas,"Liberation Mono",monospace;font-variant-numeric:tabular-nums}.eyebrow{font-size:12px;letter-spacing:.1em;font-weight:600}.micro{font-size:12px}.meta{color:var(--muted);font-size:12px;display:flex;align-items:baseline;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:12px}
svg{width:24px;height:24px;display:block;flex:none}.tag{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--accent)}.tag svg{width:16px;height:16px}.id{color:var(--muted);font-size:12px;font-family:Consolas,monospace;font-weight:400}
footer{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px 16px;font-size:12px;color:var(--muted);padding:24px 32px}
@media(max-width:640px){#container{padding:16px}h1{font-size:30px}h2{font-size:16px}.meta{font-size:12px}footer{padding:24px}}
`

const designs = [
  {
    key: 'a', name: '青绿时间线', subtitle: '按时间阅读，层次舒展',
    css: `.sheet{border-radius:24px}header{padding:32px}.brandline{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}.brand{display:flex;gap:8px;align-items:center}.brand svg{color:var(--accent)}.owner{font-size:16px;color:var(--muted);margin-bottom:4px}.repo-line{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}.branch{color:var(--accent);font-size:12px;background:var(--tint);padding:4px 8px;border-radius:8px}.lead{font-size:16px;margin-top:16px;color:var(--muted)}.lead strong{color:var(--ink)}.day{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding:24px 32px 16px;color:var(--muted);font-size:12px}.day strong{color:var(--ink)}.timeline{padding:0 32px}.event{position:relative;display:grid;grid-template-columns:48px 24px minmax(0,1fr);gap:16px;padding:16px 0 32px}.time{font-size:12px;color:var(--muted);padding-top:4px}.node{position:relative;color:var(--accent)}.node svg{position:relative;background:var(--surface)}.event:not(:last-child) .node:before{content:"";position:absolute;top:24px;bottom:-48px;left:12px;width:1px;background:var(--line)}.event-body h2{margin-top:8px;max-width:28em}.event-body .meta{justify-content:flex-start}.type{color:var(--accent);font-size:12px;font-weight:600}.event:last-child{padding-bottom:16px}footer{border-top:1px solid var(--line);margin-top:16px}@media(max-width:640px){header{padding:24px}.brandline{margin-bottom:24px}.day{padding:24px 24px 12px}.timeline{padding:0 24px}.event{grid-template-columns:16px minmax(0,1fr);gap:12px;padding-block:16px 24px}.time{grid-column:2;grid-row:1;padding:0}.node{grid-row:1 / span 2}.node svg{width:16px;height:16px}.event:not(:last-child) .node:before{left:8px;top:16px;bottom:-32px}.event-body{grid-column:2}.lead{font-size:12px}}`,
    html: `<div class="sheet"><header><div class="brandline"><div class="brand">${icon('commit')}<span class="eyebrow accent">REPOSITORY FEED</span></div><span class="micro muted">GitHub</span></div><p class="owner">Yunzai-NG /</p><div class="repo-line"><h1>yunzai-ng</h1><span class="branch mono">main</span></div><p class="lead">今天，仓库有 <strong>4 条</strong>新动态。</p></header><div class="day"><strong>11 月 5 日 · 星期四</strong><span>2026</span></div><ol class="timeline">${events.map(event => `<li class="event"><time class="time mono">${event.time}</time><span class="node">${icon(event.kind)}</span><article class="event-body"><div class="type">新 ${event.type} <span class="id">${event.id}</span></div><h2>${title(event)}</h2><div class="meta"><span>${event.author}</span></div></article></li>`).join('')}</ol>${footer}</div>`
  },
  {
    key: 'b', name: '紧凑简报', subtitle: '信息密度高，适合日常群推送',
    css: `.sheet{border-radius:16px;overflow:hidden}header{background:${source.ink};color:${source.surface};padding:32px}.topline{display:flex;justify-content:space-between;gap:16px;margin-bottom:24px;color:${source.mint}}.repo-line{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.owner{color:${source.mint};font-size:12px;margin-bottom:4px}.issue-date{font-size:12px;text-align:right;color:${source.mint}}.branch{font-size:12px;margin-top:12px;color:${source.mint}}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--surface)}.stat{background:var(--tint);padding:16px 24px;display:flex;align-items:baseline;gap:8px}.stat strong{font-size:24px;line-height:1.25}.stat span{font-size:12px}.list-heading{display:flex;justify-content:space-between;align-items:baseline;padding:24px 32px 8px;font-size:12px}.list-heading strong{font-size:16px}.compact-list{padding:0 32px}.event{display:grid;grid-template-columns:96px minmax(0,1fr);gap:16px;padding-block:24px}.event+.event{border-top:1px solid var(--line)}.event-label{padding-top:4px}.event-label .id{display:block;margin-top:8px}.event h2{font-size:16px;line-height:1.5}.meta{margin-top:8px}footer{background:var(--surface);border-top:1px solid var(--line)}@media(max-width:640px){header{padding:24px}.repo-line{flex-wrap:wrap;gap:12px}.issue-date{text-align:left}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:12px 24px}.list-heading{padding:24px 24px 8px}.compact-list{padding:0 24px}.event{grid-template-columns:minmax(0,1fr);gap:8px;padding-block:16px}.event-label{display:flex;gap:12px;align-items:baseline;padding:0}.event-label .id{margin:0}}`,
    html: `<div class="sheet"><header><div class="topline"><span class="eyebrow">GIT DIGEST</span><span class="micro">GitHub</span></div><div class="repo-line"><div><p class="owner">Yunzai-NG /</p><h1>yunzai-ng</h1><p class="branch mono">branch / main</p></div><p class="issue-date mono">2026.11.05<br>16:00 — 17:30</p></div></header><div class="stats" aria-label="动态统计">${events.map(event => `<div class="stat"><strong>1</strong><span>${event.type}</span></div>`).join('')}</div><div class="list-heading"><strong>新增动态</strong><span class="muted">共 4 条</span></div><ol class="compact-list">${events.map(event => `<li class="event"><div class="event-label"><span class="tag">${icon(event.kind)}${event.type}</span><span class="id">${event.id}</span></div><article><h2>${title(event)}</h2><div class="meta"><span>${event.author}</span><time class="mono">${event.time}</time></div></article></li>`).join('')}</ol>${footer}</div>`
  },
  {
    key: 'c', name: '深色开发者', subtitle: '深蓝工作台，等宽标识与青绿重点',
    css: `body{color-scheme:dark}.sheet{border-radius:16px;overflow:hidden}.toolbar{padding:16px 32px;background:var(--tint);display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px}.toolbar-brand{display:flex;align-items:center;gap:8px}.toolbar-brand svg{width:16px;height:16px;color:var(--accent)}header{padding:32px 32px 24px}.path{font-size:12px;color:var(--muted);margin-bottom:8px}.path span{color:var(--accent)}.repo-line{display:flex;justify-content:space-between;align-items:center;gap:16px}.count{font-size:12px;color:var(--accent);background:var(--tint);padding:8px 12px;border-radius:8px;white-space:nowrap}.context{display:flex;flex-wrap:wrap;gap:8px 24px;margin-top:16px;font-size:12px;color:var(--muted)}.context strong{color:var(--accent);font-weight:400}.event-list{padding:0 32px}.event{display:grid;grid-template-columns:24px minmax(0,1fr);gap:16px;padding-block:24px;border-top:1px solid var(--line)}.event-number{font-size:12px;color:var(--muted);padding-top:4px}.event-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;font-size:12px}.event-head time{color:var(--muted)}.event h2{margin-top:12px;max-width:30em}.event .meta{justify-content:flex-start;gap:8px}.prefix{color:var(--accent);font-weight:400}.id{color:var(--accent)}footer{border-top:1px solid var(--line);margin-top:8px}@media(max-width:640px){.toolbar{padding:16px 24px}header{padding:24px}.repo-line{align-items:baseline;flex-wrap:wrap}.event-list{padding-inline:24px}.event{grid-template-columns:minmax(0,1fr);gap:8px}.event-number{display:none}.event-head{flex-wrap:wrap;gap:4px 12px}.count{padding:4px 8px}}`,
    html: `<div class="sheet"><div class="toolbar"><span class="toolbar-brand">${icon('commit')}<span class="mono">repository / activity</span></span><span>GitHub</span></div><header><p class="path mono"><span>~/</span> Yunzai-NG</p><div class="repo-line"><h1 class="mono">yunzai-ng</h1><span class="count mono">+4 new events</span></div><div class="context"><span class="mono">branch <strong>main</strong></span><span class="mono">2026-11-05 · UTC+8</span></div></header><ol class="event-list">${events.map((event, index) => `<li class="event"><span class="event-number mono">0${index + 1}</span><article><div class="event-head"><span class="tag">${icon(event.kind)}新 ${event.type} <span class="id">${event.id}</span></span><time class="mono">${event.time}</time></div><h2>${event.prefix ? `<span class="prefix mono">${event.prefix}:</span> ` : ''}${event.title}</h2><div class="meta"><span class="mono">@</span><span>${event.author}</span></div></article></li>`).join('')}</ol>${footer}</div>`
  },
  {
    key: 'd', name: '纸感手记', subtitle: '暖色留白与报刊排版，适合版本汇总',
    css: `.sheet{padding:32px}.edition{display:flex;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:2px solid var(--ink);font-size:12px;color:var(--muted)}.edition strong{color:var(--ink)}header{padding-top:24px}.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.publication{font-family:Georgia,"Noto Serif CJK SC","SimSun",serif;font-size:48px;line-height:1.15;font-weight:600}.publication small{display:block;font-family:"Segoe UI",sans-serif;font-size:12px;letter-spacing:.1em;margin-bottom:12px}.date-block{text-align:right;color:var(--muted);font-size:12px}.date-block strong{display:block;font-size:36px;line-height:1.15;color:var(--ink);font-family:Georgia,serif;font-weight:400}.repo{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 24px}.repo h1{font-size:24px;font-family:Georgia,serif;line-height:1.25}.repo span{font-size:12px;color:var(--muted)}.intro{margin-top:16px;font-size:16px;color:var(--muted);max-width:32em}.stories{margin-top:32px}.event{display:grid;grid-template-columns:32px minmax(0,1fr);gap:16px;padding:24px 0;border-top:1px solid var(--line)}.serial{font-family:Georgia,serif;font-size:24px;line-height:1.25;color:var(--muted)}.kicker{display:flex;align-items:baseline;gap:12px;font-size:12px;color:var(--muted)}.kicker strong{color:var(--ink)}.event h2{font-family:Georgia,"Noto Serif CJK SC","SimSun",serif;font-size:24px;line-height:1.5;max-width:25em;margin-top:8px}.meta{margin-top:12px}.end-note{margin-top:16px;padding:16px 24px;background:var(--tint);font-size:12px;color:var(--muted)}footer{border-top:2px solid var(--ink);padding:24px 0 0;margin-top:24px}@media(max-width:640px){.sheet{padding:24px}.publication{font-size:36px}.date-block strong{font-size:30px}.masthead{gap:16px}.repo h1{font-size:20px;overflow-wrap:anywhere}.intro{font-size:12px}.stories{margin-top:24px}.event{grid-template-columns:minmax(0,1fr);gap:8px;padding:16px 0}.serial{font-size:20px}.event h2{font-size:20px}.end-note{padding:16px}footer{padding:24px 0 0}}`,
    html: `<div class="sheet"><div class="edition"><strong>GitHub · 仓库动态</strong><span class="mono">2026 / 11 / 05</span></div><header><div class="masthead"><p class="publication"><small>THE REPOSITORY JOURNAL</small>仓库手记</p><div class="date-block"><strong>04</strong>条新动态</div></div><div class="repo"><h1>Yunzai-NG / yunzai-ng</h1><span class="mono">main 分支</span></div><p class="intro">一次提交，一个议题，一份合并请求，<br>以及一个新版本。这里是仓库今天的进展。</p></header><ol class="stories">${events.map((event, index) => `<li class="event"><span class="serial">0${index + 1}</span><article><div class="kicker"><strong>新 ${event.type}</strong><span class="id">${event.id}</span></div><h2>${title(event)}</h2><div class="meta"><span>${event.author}</span><time class="mono">${event.time}</time></div></article></li>`).join('')}</ol><p class="end-note">本次收录 4 条新增动态 · 16:00 — 17:30</p>${footer}</div>`
  }
]

for (const design of designs) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${design.key.toUpperCase()} · ${design.name}</title><style>${common}\n${design.css}</style></head><body class="variant-${design.key}"><main id="container">${design.html}</main></body></html>`
  await writeFile(join(directory, `${design.key}.html`), html)
}
const gallery = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Git-Plugin · 四组卡片方案</title><style>
*{box-sizing:border-box}body{margin:0;background:${source.canvas};color:${source.ink};font-family:"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.5;font-weight:400}h1,h2,p{margin:0}h1,h2{font-weight:600}main{max-width:1600px;margin:auto;padding:48px}header{margin-bottom:32px}header p{margin-top:12px}h1{font-size:36px;line-height:1.25}.eyebrow{font-size:12px;letter-spacing:.1em;margin-bottom:8px;color:${source.accent};font-weight:600}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}.option{min-width:0}.caption{display:flex;gap:16px;align-items:baseline;margin-bottom:16px}.letter{font-size:30px;font-weight:600;color:${source.accent}}h2{font-size:20px}.caption p{font-size:12px}a{color:inherit;text-decoration:none}a:focus-visible{outline:2px solid ${source.accent};outline-offset:4px}a:hover h2{text-decoration:underline}img{display:block;width:100%;height:auto}.footnote{margin-top:32px;font-size:12px}@media(max-width:640px){main{padding:24px}h1{font-size:24px}.grid{grid-template-columns:minmax(0,1fr);gap:32px}}
</style></head><body><main><header><p class="eyebrow">GIT-PLUGIN / DESIGN EXPLORATIONS</p><h1>同样的动态，四种阅读方式。</h1><p>同一组仓库内容 · 4 个独立方向 · 点击查看单张 HTML 预览</p></header><div class="grid">${designs.map(design => `<section class="option"><a href="${design.key}.html"><div class="caption"><span class="letter">${design.key.toUpperCase()}</span><div><h2>${design.name}</h2><p>${design.subtitle}</p></div></div><img src="${design.key}-card.png" alt="${design.key.toUpperCase()} ${design.name} 卡片方案"></a></section>`).join('')}</div><p class="footnote">预览方案 · 尚未切换插件当前样式</p></main></body></html>`
await writeFile(join(directory, 'preview.html'), gallery)
await writeFile(join(directory, 'manifest.json'), JSON.stringify(designs.map(({ key, name, subtitle }) => ({ key, name, subtitle })), null, 2))
console.log(JSON.stringify({ generated: designs.map(design => `${design.key}.html`), contrast: pairs }))
