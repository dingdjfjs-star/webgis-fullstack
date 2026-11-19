import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, pool } from './db.js';
import { pois } from './routes/pois.js';
import { basin } from './routes/basin.js';
import { tiles } from './routes/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 健康检查（顺带探测 PostGIS 可用性）
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await query(`SELECT postgis_full_version() AS v`);
    res.json({ ok: true, postgis: rows[0].v, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- 教学 SQL 沙盒（课程站专用，严格只读）----
const DENY_FUNCS = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend|pg_sleep|pg_sleep_for)\b/i;
app.post('/api/sql', express.json(), async (req, res) => {
  try {
    const raw = String(req.body?.q ?? '').trim();
    const stripped = raw.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!stripped) return res.status(400).json({ error: '请输入 SQL' });
    // 允许末尾恰好一个分号；内部还有分号即视为多语句
    const one = stripped.replace(/;+\s*$/, '');
    if (one.includes(';')) return res.status(400).json({ error: '一次只允许一条语句（多语句请分开运行）' });
    if (!/^(SELECT|WITH|EXPLAIN|SHOW|TABLE)\b/i.test(stripped))
      return res.status(400).json({ error: '教学沙盒只允许查询语句（SELECT / WITH / EXPLAIN / SHOW / TABLE）' });
    if (/\b(INTO|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|COPY|CALL|DO|LISTEN|NOTIFY|SET|RESET|BEGIN|COMMIT|ROLLBACK)\b/i.test(stripped))
      return res.status(400).json({ error: '沙盒只读：检测到修改/控制类关键字' });
    if (DENY_FUNCS.test(stripped))
      return res.status(400).json({ error: '该函数不在教学白名单内' });
    const client = await pool.connect();
    const t0 = Date.now();
    try {
      await client.query('SET statement_timeout = 8000');
      const r = await client.query(one);
      res.json({
        columns: r.fields.map((f) => f.name),
        rows: r.rows.slice(0, 200).map((row) => r.fields.map((f) => row[f.name])),
        rowCount: r.rowCount ?? r.rows.length,
        truncated: r.rows.length > 200,
        ms: Date.now() - t0,
      });
    } finally { client.release(); }
  } catch (e) {
    res.status(400).json({ error: e.message, detail: e.detail });
  }
});

app.use('/api/pois', pois);
app.use('/api/basin', basin);
app.use('/tiles', tiles);

// 静态前端
const PUB = path.join(__dirname, '..', 'public');
app.use('/poi', express.static(path.join(PUB, 'poi')));
app.use('/course', express.static(path.join(PUB, 'course')));
app.use('/basin', express.static(path.join(PUB, 'basin')));
app.use('/vendor', express.static(path.join(PUB, 'vendor'), { maxAge: '7d' }));
app.get('/', (req, res) => res.redirect('/poi'));

// 404 与统一错误处理
app.use((req, res) => res.status(404).json({ error: `no route: ${req.method} ${req.path}` }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error('[api:error]', err);
  res.status(status).json({ error: err.message });
});

export default app;
