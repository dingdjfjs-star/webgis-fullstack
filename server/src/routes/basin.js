import { Router } from 'express';
import { query } from '../db.js';
import { gradeMetric, gradeName, GRADE_COLORS } from '../util/stats.js';

export const basin = Router();

const METRICS = ['ph', 'do_mgl', 'cod_mn', 'nh3_n', 'tp'];

/** 单站整体等级 = 各单因子等级中最差的一级（GB 3838 单因子评价法） */
function overall(grades) {
  const g = METRICS.map((m) => gradeMetric(m, grades[m])).filter((x) => x != null);
  return g.length ? Math.max(...g) : null;
}

/** 平台总览：边界 + 河网规模 + 面积 + 站点/污染源计数 + 最新水质等级分布 */
basin.get('/overview', async (req, res, next) => {
  try {
    const [bnd, rivers, stats, grades] = await Promise.all([
      query(`SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.002))::json AS g FROM basin.boundary LIMIT 1`),
      query(`SELECT count(*)::int AS n, round(sum(ST_Length(geom::geography, false))::numeric / 1000, 1)::float8 AS len_km FROM basin.rivers`),
      query(`SELECT (SELECT count(*)::int FROM basin.stations WHERE kind='water_quality') AS wq,
                    (SELECT count(*)::int FROM basin.stations WHERE kind='hydrology') AS hydro,
                    (SELECT count(*)::int FROM basin.sources) AS sources,
                    round(ST_Area(geom::geography, false)::numeric / 1e6, 1)::float8 AS area_km2
             FROM basin.boundary`),
      query(`SELECT DISTINCT ON (r.station_id) r.station_id, r.ph, r.do_mgl, r.cod_mn, r.nh3_n, r.tp
             FROM basin.readings r JOIN basin.stations s ON s.id = r.station_id AND s.kind='water_quality'
             ORDER BY r.station_id, r.ts DESC`),
    ]);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const r of grades.rows) dist[overall(r)]++;
    res.json({
      boundary: bnd.rows[0]?.g ?? null,
      rivers: rivers.rows[0],
      stations: { water_quality: stats.rows[0].wq, hydrology: stats.rows[0].hydro },
      sources: stats.rows[0].sources,
      area_km2: stats.rows[0].area_km2,
      gradeDistribution: Object.fromEntries(Object.entries(dist).map(([g, n]) => [gradeName(+g), n])),
    });
  } catch (e) { next(e); }
});

/** 监测站列表 + 最新读数 + 单因子等级 */
basin.get('/stations', async (req, res, next) => {
  try {
    const { rows } = await query(`
      WITH latest AS (
        SELECT DISTINCT ON (station_id) * FROM basin.readings ORDER BY station_id, ts DESC
      )
      SELECT s.id, s.code, s.name, s.kind, s.km, ST_X(s.geom) AS x, ST_Y(s.geom) AS y,
             r.name AS river, l.ts, l.temp, l.ph, l.do_mgl, l.cod_mn, l.nh3_n, l.tp, l.turbidity, l.rainfall
      FROM basin.stations s
      LEFT JOIN basin.rivers r ON r.id = s.river_id
      LEFT JOIN latest l ON l.station_id = s.id
      ORDER BY s.code`);
    const stations = rows.map((r) => {
      const grades = { ph: r.ph, do_mgl: r.do_mgl, cod_mn: r.cod_mn, nh3_n: r.nh3_n, tp: r.tp };
      const g = overall(grades);
      return {
        id: r.id, code: r.code, name: r.name, kind: r.kind, km: r.km,
        x: r.x, y: r.y, river: r.river,
        latest: r.ts ? { ts: r.ts, temp: r.temp, ph: r.ph, do_mgl: r.do_mgl, cod_mn: r.cod_mn, nh3_n: r.nh3_n, tp: r.tp, turbidity: r.turbidity, rainfall: r.rainfall } : null,
        grade: g, grade_name: gradeName(g), grade_color: GRADE_COLORS[g],
        metricGrades: Object.fromEntries(METRICS.map((m) => [m, gradeMetric(m, grades[m])])),
      };
    });
    res.json({ stations });
  } catch (e) { next(e); }
});

/** 站点时序：短窗返回小时原值，长窗按日/周聚合（date_bin 降采样） */
basin.get('/stations/:id/series', async (req, res, next) => {
  try {
    const days = Math.min(+(req.query.days || 30), 365);
    const metrics = String(req.query.metrics || 'do_mgl,nh3_n').split(',').filter((m) => METRICS.includes(m) || m === 'turbidity');
    if (!metrics.length) return res.status(400).json({ error: 'metrics 参数非法' });
    const bin = days <= 3 ? "'1 hour'" : days <= 60 ? "'1 day'" : "'7 days'";
    const cols = metrics.map((m) => `round(avg(${m})::numeric, 3)::float8 AS ${m}`).join(', ');
    const { rows } = await query(
      `SELECT date_bin(${bin}::interval, ts, '2025-01-01'::timestamptz) AS b, ${cols}
       FROM basin.readings WHERE station_id = $1 AND ts >= now() - ($2 || ' days')::interval
       GROUP BY b ORDER BY b`, [req.params.id, days]);
    res.json({
      t: rows.map((r) => r.b),
      series: Object.fromEntries(metrics.map((m) => [m, rows.map((r) => r[m])])),
      bin: bin.replace(/'/g, ''),
    });
  } catch (e) { next(e); }
});

/** 降雨-水质响应：对齐的小时降雨 / 浊度 / 氨氮（非点源冲刷效应） */
basin.get('/rain-response', async (req, res, next) => {
  try {
    const days = Math.min(+(req.query.days || 14), 90);
    const station = req.query.station_id || (await query(`SELECT id FROM basin.stations WHERE kind='water_quality' ORDER BY code LIMIT 1`)).rows[0].id;
    const { rows } = await query(
      `SELECT ts, rainfall, turbidity, nh3_n, do_mgl
       FROM basin.readings WHERE station_id = $1 AND ts >= now() - ($2 || ' days')::interval
       ORDER BY ts`, [station, days]);
    res.json({
      station_id: +station,
      t: rows.map((r) => r.ts),
      rainfall: rows.map((r) => r.rainfall),
      turbidity: rows.map((r) => r.turbidity),
      nh3_n: rows.map((r) => r.nh3_n),
      do_mgl: rows.map((r) => r.do_mgl),
    });
  } catch (e) { next(e); }
});

/** 河流缓冲区分析：距河岸 dist 米内的污染源清单与负荷统计 */
basin.get('/analysis/river-buffer', async (req, res, next) => {
  try {
    const dist = Math.min(+(req.query.dist || 1000), 5000);
    const { rows } = await query(
      `SELECT s.id, s.name, s.type, s.load_cod::float8, r.name AS river,
              round(ST_Distance(s.geom::geography, r.geom::geography, false)::numeric, 0)::int AS dist_m
       FROM basin.sources s
       JOIN basin.rivers r ON ST_DWithin(s.geom::geography, r.geom::geography, $1, false)
       ORDER BY s.load_cod DESC`, [dist]);
    const byType = {};
    for (const r of rows) {
      byType[r.type] ??= { cnt: 0, load: 0 };
      byType[r.type].cnt++;
      byType[r.type].load = +((byType[r.type].load || 0) + r.load_cod).toFixed(1);
    }
    res.json({ dist_m: dist, total: rows.length, totalLoadKg: +rows.reduce((s, r) => s + r.load_cod, 0).toFixed(1), byType, sources: rows });
  } catch (e) { next(e); }
});

/** 水质达标评价：近 N 天均值逐因子分级（GB 3838-2002） */
basin.get('/analysis/compliance', async (req, res, next) => {
  try {
    const days = Math.min(+(req.query.days || 30), 365);
    const { rows } = await query(
      `SELECT s.id, s.code, s.name,
              avg(r.ph)::float8 AS ph, avg(r.do_mgl)::float8 AS do_mgl, avg(r.cod_mn)::float8 AS cod_mn,
              avg(r.nh3_n)::float8 AS nh3_n, avg(r.tp)::float8 AS tp
       FROM basin.stations s
       JOIN basin.readings r ON r.station_id = s.id AND s.kind = 'water_quality'
            AND r.ts >= now() - ($1 || ' days')::interval
       GROUP BY s.id, s.code, s.name ORDER BY s.code`, [days]);
    const result = rows.map((r) => {
      const metricGrades = Object.fromEntries(METRICS.map((m) => [m, gradeMetric(m, r[m])]));
      const g = overall(r);
      return { id: r.id, code: r.code, name: r.name, metricGrades, grade: g, grade_name: gradeName(g), grade_color: GRADE_COLORS[g], means: { ph: r.ph, do_mgl: r.do_mgl, cod_mn: r.cod_mn, nh3_n: r.nh3_n, tp: r.tp } };
    });
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    result.forEach((r) => dist[r.grade]++);
    res.json({ days, stations: result, gradeDistribution: Object.fromEntries(Object.entries(dist).map(([g, n]) => [gradeName(+g), n])) });
  } catch (e) { next(e); }
});

/** 超标预警：最新读数劣于 Ⅲ 类的站点 + 近 7 天 vs 前 7 天趋势 */
basin.get('/alerts', async (req, res, next) => {
  try {
    const { rows } = await query(`
      WITH latest AS (
        SELECT DISTINCT ON (station_id) station_id, ts, do_mgl, nh3_n, cod_mn, tp
        FROM basin.readings ORDER BY station_id, ts DESC
      ),
      trend AS (
        SELECT station_id,
               avg(nh3_n) FILTER (WHERE ts > now() - interval '7 days') AS nh3_recent,
               avg(nh3_n) FILTER (WHERE ts <= now() - interval '7 days' AND ts > now() - interval '14 days') AS nh3_prev,
               avg(do_mgl) FILTER (WHERE ts > now() - interval '7 days') AS do_recent,
               avg(do_mgl) FILTER (WHERE ts <= now() - interval '7 days' AND ts > now() - interval '14 days') AS do_prev
        FROM basin.readings GROUP BY station_id
      )
      SELECT s.id, s.code, s.name, l.ts, l.do_mgl, l.nh3_n, l.cod_mn, l.tp, t.*
      FROM latest l
      JOIN basin.stations s ON s.id = l.station_id AND s.kind = 'water_quality'
      LEFT JOIN trend t ON t.station_id = s.id`);
    const alerts = rows
      .map((r) => {
        const grades = { ph: 7, do_mgl: r.do_mgl, cod_mn: r.cod_mn, nh3_n: r.nh3_n, tp: r.tp };
        const g = overall(grades);
        return {
          id: r.id, code: r.code, name: r.name, ts: r.ts,
          grade: g, grade_name: gradeName(g), grade_color: GRADE_COLORS[g],
          do_mgl: r.do_mgl, nh3_n: r.nh3_n,
          nh3_trend: r.nh3_prev ? +((r.nh3_recent - r.nh3_prev) / r.nh3_prev * 100).toFixed(1) : null,
          do_trend: r.do_prev ? +((r.do_recent - r.do_prev) / r.do_prev * 100).toFixed(1) : null,
        };
      })
      .filter((r) => r.grade >= 4)
      .sort((a, b) => b.grade - a.grade);
    res.json({ count: alerts.length, alerts });
  } catch (e) { next(e); }
});

/** 河流 GeoJSON（Cesium 三维河网用） */
basin.get('/rivers', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, strahler, ST_AsGeoJSON(geom)::json AS g FROM basin.rivers`);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: r.g,
        properties: { id: r.id, name: r.name, strahler: r.strahler },
      })),
    });
  } catch (e) { next(e); }
});

/** 污染源列表 */
basin.get('/sources', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, type, load_cod::float8, ST_X(geom) AS x, ST_Y(geom) AS y FROM basin.sources ORDER BY load_cod DESC`);
    res.json({ sources: rows });
  } catch (e) { next(e); }
});
