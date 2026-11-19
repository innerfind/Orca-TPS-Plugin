const escape = value => String(value ?? '').replace(/[&<>"']/g, part =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[part]);
const standardMB = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const preciseMB = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const formatMB = tokens => (tokens > 0 && tokens < 1_000_000 ? preciseMB : standardMB).format(tokens / 1_000_000);
const date = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
const timeElement = value => `<time datetime="${new Date(value).toISOString()}">${date.format(value)} 北京时间</time>`;
export const localTimes = `
  const clock = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const time of document.querySelectorAll('time[datetime]')) time.textContent = clock.format(new Date(time.dateTime));
`;

function layout(content, title = '天梯榜管理') {
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light;--ink:#182832;--paper:#f1f5f8;--line:#c9d6df;--accent:#184e70;--danger:#992d39}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 system-ui,sans-serif}
main{max-width:1040px;margin:auto;padding:clamp(1rem,4vw,3.5rem)}h1{font-size:clamp(2rem,6vw,3.25rem);margin:0;line-height:1.15;letter-spacing:-.045em}
h2{font-size:1.25rem;margin:0}p{margin:.5rem 0}header{display:flex;justify-content:space-between;gap:1rem;align-items:start;border-top:5px solid var(--accent);padding:1.3rem 0}
section{padding:1.2rem 0;border-top:1px solid var(--line)}form.inline{display:inline}form.filters{display:flex;align-items:end;gap:.65rem;flex-wrap:wrap;margin:.85rem 0}
label{display:grid;gap:.25rem}input,button,a.button{font:inherit;border-radius:4px;padding:.4rem .65rem}
button,a.button{background:white;border:1px solid var(--accent);color:var(--accent);cursor:pointer;text-decoration:none}
.primary{color:white!important;background:var(--accent)!important}.danger{color:var(--danger);border-color:var(--danger)}
input{border:1px solid var(--line);background:white;color:var(--ink);min-width:0}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #1782bf;outline-offset:3px}
.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:330px}th,td{text-align:left;padding:.55rem .35rem;border-bottom:1px solid var(--line)}
.number{text-align:right;font-variant-numeric:tabular-nums}.action{text-align:right}.muted{color:#4b6474}.notice{padding:.6rem .8rem;background:#e0eef6;border-left:4px solid var(--accent)}
details{margin-top:.9rem}summary{color:var(--danger);cursor:pointer}.empty{padding:.8rem 0}
</style><main>${content}</main><script src="/admin/local-time.js" defer></script></html>`;
}

export function pluginLoginResult(message) {
  return layout(`<header><h1>TPS Plugin</h1></header><section><p role="status">${escape(message)}</p></section>`, 'TPS Plugin GitHub 登录');
}

export function adminLogin(message = '', available = true) {
  return layout(`<header><h1>天梯榜管理</h1></header><section>
    ${message ? `<p class="notice" role="status">${escape(message)}</p>` : ''}
    ${available ? '<p>使用管理员 GitHub 账号登录。</p><p><a class="button primary" href="/auth/github/start">用 GitHub 登录</a></p>' : '<p>GitHub 登录正在配置。</p>'}
  </section>`);
}

export function adminPage({ day, search, username, scores, accounts, audit, feedback }) {
  const fields = `<input type="hidden" name="day" value="${escape(day)}"><input type="hidden" name="q" value="${escape(search)}">`;
  const scoreRows = scores.map(row => `<tr><td>${escape(row.username)}</td><td class="number">${formatMB(row.tokens)}</td>
    <td>${timeElement(row.submittedAt)}</td><td class="action"><form method="post" action="/admin/delete">${fields}
    <input type="hidden" name="account" value="${row.account}"><button class="danger" type="submit">删除</button></form></td></tr>`).join('');
  const accountRows = accounts.map(row => `<tr><td>${escape(row.username)}</td><td>${row.banned ? '已封禁' : '正常'}</td>
    <td class="action"><form method="post" action="/admin/ban">${fields}<input type="hidden" name="account" value="${row.id}">
    <button ${row.banned ? '' : 'class="danger"'} type="submit" name="ban" value="${row.banned ? '0' : '1'}">${row.banned ? '解封' : '封禁'}</button></form></td></tr>`).join('');
  const auditRows = audit.map(row => `<tr><td>${timeElement(row.at)}</td><td>${escape(row.username)}</td>
    <td>${({ ban: '封禁', unban: '解封', delete: '删除成绩', clear: '清空榜单' })[row.action] ?? '操作'}</td>
    <td>${escape(row.target)}</td></tr>`).join('');
  return layout(`<header><div><h1>天梯榜管理</h1><p class="muted">${escape(username)}</p></div>
    <form method="post" action="/admin/logout"><button type="submit">退出</button></form></header>
    ${feedback ? `<p class="notice" role="status">${escape(feedback)}</p>` : ''}
    <section><h2>榜单成绩</h2>
    <form class="filters" action="/admin"><label>榜单日（北京时间）<input type="date" name="day" value="${escape(day)}" required></label>
    <label>GitHub 用户名<input name="q" value="${escape(search)}" maxlength="39"></label><button class="primary">查询</button></form>
    ${scoreRows ? `<div class="scroll"><table><thead><tr><th>账号</th><th class="number">用量（MB）</th><th>提交时间</th><th class="action">操作</th></tr></thead><tbody>${scoreRows}</tbody></table></div>` : '<p class="empty muted">没有符合条件的成绩。</p>'}
    <details><summary>清空榜单</summary><form class="filters" method="post" action="/admin/clear">${fields}
    <label>输入「清空」确认<input name="confirm" required pattern="清空" autocomplete="off"></label>
    <button class="danger" type="submit" name="scope" value="day">清空这一天</button>
    <button class="danger" type="submit" name="scope" value="all">清空全部</button></form></details></section>
    <section><h2>GitHub 账号</h2>
    ${accountRows ? `<div class="scroll"><table><thead><tr><th>账号</th><th>状态</th><th class="action">操作</th></tr></thead><tbody>${accountRows}</tbody></table></div>` : '<p class="empty muted">没有符合条件的账号。</p>'}</section>
    <section><h2>最近管理操作</h2>${auditRows ? `<div class="scroll"><table><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>范围</th></tr></thead><tbody>${auditRows}</tbody></table></div>` : '<p class="empty muted">暂无操作记录。</p>'}</section>`);
}
