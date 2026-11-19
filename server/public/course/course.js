'use strict';
/* 课程站公共脚本：SQL 沙盒运行器 + 代码复制 + 学习进度打卡 */

// ---------- 进度存取 ----------
const PKEY = 'wgcourse.done.v1';
const getProgress = () => { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch { return {}; } };
const setDone = (id, on) => {
  const p = getProgress();
  if (on) p[id] = true; else delete p[id];
  localStorage.setItem(PKEY, JSON.stringify(p));
};

// ---------- 顶栏打卡 ----------
function bindDoneToggle() {
  const box = document.querySelector('.done-toggle');
  if (!box) return;
  const id = document.body.dataset.lesson;
  if (!id) { box.remove(); return; }
  const cb = box.querySelector('input');
  const sync = () => box.classList.toggle('on', cb.checked);
  cb.checked = !!getProgress()[id];
  sync();
  cb.addEventListener('change', () => { setDone(id, cb.checked); sync(); });
}

// ---------- 首页进度刷新 ----------
function paintIndex() {
  document.querySelectorAll('.lcard[data-lesson]').forEach((card) => {
    const st = card.querySelector('.st');
    if (!st) return;
    if (getProgress()[card.dataset.lesson]) { st.textContent = '✓ 已完成'; st.className = 'st done'; }
  });
}

// ---------- 代码块复制按钮 ----------
function addCopyButtons() {
  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.type = 'button'; btn.textContent = '复制';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.innerText.replace(/^复制\n?/, ''))
        .then(() => { btn.textContent = '已复制'; setTimeout(() => (btn.textContent = '复制'), 1200); });
    });
    pre.appendChild(btn);
  });
}

// ---------- SQL 沙盒 ----------
function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function short(v) {
  if (v == null) return '<span style="color:#94a3b8">NULL</span>';
  let s = String(v);
  if (s.length > 64) s = s.slice(0, 64) + `…<span style="color:#94a3b8">（${s.length}字符，已截断显示）</span>`;
  return esc(s);
}

async function runPlayground(pg) {
  const btn = pg.querySelector('.pg-run');
  const sql = pg.querySelector('textarea').value.trim();
  const out = pg.querySelector('.pg-out');
  btn.disabled = true; btn.textContent = '运行中…';
  out.innerHTML = '<span style="color:#8494a5">正在查询真实数据库…</span>';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: sql }),
    });
    const data = await res.json();
    if (!res.ok) {
      out.innerHTML = `<div class="err">✗ ${esc(data.error || '查询失败')}${data.detail ? '\n' + esc(data.detail) : ''}</div>`;
      return;
    }
    const head = data.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = data.rows.map((r) => `<tr>${r.map((v) => `<td>${short(v)}</td>`).join('')}</tr>`).join('');
    const note = data.truncated ? `<div class="meta">⚠ 结果超过 200 行，只显示前 200 行。</div>` : '';
    out.innerHTML =
      `<div class="meta">✓ ${data.rowCount} 行 · 耗时 ${data.ms} ms</div>${note}` +
      `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td style="color:#94a3b8">（0 行）</td></tr>'}</tbody></table></div>`;
  } catch (e) {
    out.innerHTML = `<div class="err">✗ 无法连接配套系统（${esc(e.message)}）。\n你看到的可能是「离线阅读版」——实时查询需要先启动项目里的数据库和后端：\n双击 scripts\\start-all.bat 后刷新本页即可。</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '▶ 运行';
  }
}

function bindPlaygrounds() {
  document.querySelectorAll('.pg').forEach((pg) => {
    pg.querySelector('.pg-run').addEventListener('click', () => runPlayground(pg));
    const ta = pg.querySelector('textarea');
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runPlayground(pg);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindDoneToggle();
  addCopyButtons();
  bindPlaygrounds();
  paintIndex();
});
