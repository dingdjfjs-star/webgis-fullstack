/**
 * PostGIS 空间索引（GiST）性能基准：
 * 对同一组空间查询分别在「有索引 / 强制禁用索引」两种状态下计时，
 * 输出 Markdown 对比表（docs/perf.md 同时落盘）。
 * 运行: npm run bench
 */
import '../src/env.js';
import fs from 'node:fs';
import pg from 'pg';
import { cfg } from '../src/config.js';

const client = new pg.Client(cfg.pg);
await client.connect();

// 清掉统计缓存影响：每条 SQL 跑 5 次取中位数
async function timed(sql) {
  const ts = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    await client.query(sql);
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return ts[2];
}

const CASES = [
  {
    name: '视野框选（bbox 相交，25 万点）',
    on: `SELECT count(*) FROM poi.pois WHERE geom && ST_MakeEnvelope(114.28,30.55,114.35,30.62,4326)`,
    off: null, // 关索引时用同一条 SQL
  },
  {
    name: 'KNN 最近邻（<-> 排序，k=10）',
    on: `SELECT id FROM poi.pois ORDER BY geom <-> ST_SetSRID(ST_Point(114.305,30.593),4326) LIMIT 10`,
    off: `SELECT * FROM (SELECT id, ST_Distance(geom, ST_SetSRID(ST_Point(114.305,30.593),4326)) d FROM poi.pois) t ORDER BY d LIMIT 10`,
  },
  {
    name: '六边形密度聚合（ST_HexagonGrid 0.01°）',
    on: `SELECT count(*) FROM (
           SELECT h.i, h.j FROM ST_HexagonGrid(0.01, ST_MakeEnvelope(114.08,30.44,114.56,30.72,4326)) h
           LEFT JOIN poi.pois p ON p.geom && h.geom AND ST_Contains(h.geom, p.geom)
           GROUP BY h.i, h.j) t`,
  },
  {
    name: '球面缓冲区（ST_DWithin 1km，geography）',
    on: `SELECT count(*) FROM poi.pois WHERE ST_DWithin(geom, ST_SetSRID(ST_Point(114.305,30.593),4326)::geography, 1000)`,
  },
  {
    name: '水质时序：单站最近 24h（station+ts 复合索引）',
    on: `SELECT count(*) FROM basin.readings WHERE station_id = 1 AND ts > now() - interval '24 hours'`,
    off: `SELECT count(*) FROM basin.readings WHERE station_id = 1 AND ts > now() - interval '24 hours'`,
  },
];

const rows = [];
for (const c of CASES) {
  const withIdx = await timed(c.on);
  let noIdx = null;
  if (c.off) {
    await client.query(`SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off;`);
    noIdx = await timed(c.off);
    await client.query(`RESET enable_indexscan; RESET enable_bitmapscan; RESET enable_indexonlyscan;`);
  } else {
    // 无独立“关索引”形态的聚合类：用顺序扫描强制器对照同一条 SQL
    await client.query(`SET enable_bitmapscan = off; SET enable_indexscan = off; SET enable_indexonlyscan = off;`);
    noIdx = await timed(c.on);
    await client.query(`RESET enable_indexscan; RESET enable_bitmapscan; RESET enable_indexonlyscan;`);
  }
  const speedup = noIdx / withIdx;
  rows.push({ name: c.name, withIdx, noIdx, speedup });
  console.log(`✓ ${c.name}`);
}
await client.end();

let md = `# 空间索引性能基准（PostgreSQL 16 + PostGIS 3.6.2，Windows 便携版）\n\n`;
md += `数据规模：POI 250,000 行 / 水质时序 87,600 行。每组查询执行 5 次取中位数。\n\n`;
md += `| 空间查询 | 有 GiST/BTREE 索引 | 禁用索引（顺序扫描） | 加速比 |\n|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.name} | ${r.withIdx.toFixed(1)} ms | ${r.noIdx.toFixed(1)} ms | ${r.speedup.toFixed(0)}× |\n`;
}
fs.mkdirSync('../docs', { recursive: true });
fs.writeFileSync('../docs/perf.md', md);
console.log('\n' + md);
