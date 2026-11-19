import { Router } from 'express';
import { query } from '../db.js';
import { moransI } from '../util/stats.js';

export const pois = Router();

/** 组装公共过滤条件（bbox / 类别 / 关键词），返回 SQL 片段与参数数组 */
function poiWhere({ bbox, categories, kw }, p = [], alias = 'p') {
  const c = [];
  if (bbox) {
    const [minx, miny, maxx, maxy] = String(bbox).split(',').map(Number);
    if ([minx, miny, maxx, maxy].some(Number.isNaN)) throw Object.assign(new Error('bbox 参数非法'), { status: 400 });
    p.push(minx, miny, maxx, maxy);
    c.push(`${alias}.geom && ST_MakeEnvelope($${p.length - 3},$${p.length - 2},$${p.length - 1},$${p.length},4326)`);
  }
  if (categories) {
    p.push(String(categories).split(','));
    c.push(`${alias}.category = ANY($${p.length})`);
  }
  if (kw) {
    p.push(`%${kw}%`);
    c.push(`(${alias}.name ILIKE $${p.length} OR ${alias}.subcategory ILIKE $${p.length} OR ${alias}.category ILIKE $${p.length})`);
  }
  return c.length ? 'WHERE ' + c.join(' AND ') : '';
}

const COLS = 'p.id, p.name, p.category, p.subcategory, p.rating::float8 AS rating, p.price, ST_X(p.geom) x, ST_Y(p.geom) y';

/** 视野内 POI 列表（GeoJSON FeatureCollection） */
pois.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(+(req.query.limit || 2000), 5000);
    const p = [];
    const where = poiWhere(req.query, p);
    p.push(limit);
    const { rows } = await query(
      `SELECT ${COLS} FROM poi.pois p ${where} LIMIT $${p.length}`, p);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.x, r.y] },
        properties: { id: r.id, name: r.name, category: r.category, subcategory: r.subcategory, rating: r.rating, price: r.price },
      })),
      count: rows.length,
    });
  } catch (e) { next(e); }
});

/** 分类 / 分区统计（驱动饼图与柱状图） */
pois.get('/summary', async (req, res, next) => {
  try {
    const p = [], p2 = [];
    const where = poiWhere(req.query, p);
    const byCategory = (await query(
      `SELECT category, count(*)::int AS cnt FROM poi.pois p ${where} GROUP BY category ORDER BY cnt DESC`, p)).rows;
    const where2 = poiWhere(req.query, p2);
    const byDistrict = (await query(
      `SELECT d.name AS district, count(p.id)::int AS cnt
       FROM poi.pois p JOIN poi.districts d ON p.district_id = d.id ${where2}
       GROUP BY d.name ORDER BY cnt DESC`, p2)).rows;
    res.json({ total: byCategory.reduce((s, r) => s + r.cnt, 0), byCategory, byDistrict });
  } catch (e) { next(e); }
});

/** 热力图数据：格网聚合为 [lat,lng,weight]（leafletter.heat 直用） */
pois.get('/heatmap', async (req, res, next) => {
  try {
    const prec = Math.min(Math.max(+(req.query.prec || 4), 2), 5);
    const p = [prec];
    const where = poiWhere(req.query, p);
    const { rows } = await query(
      `SELECT round(ST_Y(p.geom)::numeric, $1)::float8 AS lat,
              round(ST_X(p.geom)::numeric, $1)::float8 AS lng,
              count(*)::int AS c
       FROM poi.pois p ${where} GROUP BY 1, 2`, p);
    res.json({ points: rows.map((r) => [r.lat, r.lng, r.c]) });
  } catch (e) { next(e); }
});

/** 六边形密度格网（ST_HexagonGrid 空间聚合，供密度图与 Moran's I） */
pois.get('/hexgrid', async (req, res, next) => {
  try {
    const size = Math.min(Math.max(+(req.query.size || 0.01), 0.002), 0.1);
    const bbox = req.query.bbox || '114.08,30.44,114.56,30.72';
    const [minx, miny, maxx, maxy] = bbox.split(',').map(Number);
    const p = [size, minx, miny, maxx, maxy];
    const catArr = req.query.categories ? String(req.query.categories).split(',') : null;
    if (catArr) p.push(catArr);
    const q = `
      SELECT h.i, h.j, ST_X(ST_Centroid(h.geom)) AS cx, ST_Y(ST_Centroid(h.geom)) AS cy,
             ST_AsGeoJSON(h.geom)::json AS geom, count(p.id)::int AS cnt
      FROM ST_HexagonGrid($1, ST_Expand(ST_MakeEnvelope($2,$3,$4,$5,4326), $1)) h
      LEFT JOIN poi.pois p
        ON p.geom && h.geom AND ST_Contains(h.geom, p.geom)
        ${catArr ? 'AND p.category = ANY($6)' : ''}
      GROUP BY h.i, h.j, h.geom`;
    const { rows } = await query(q, p);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: r.geom,
        properties: { i: r.i, j: r.j, cx: r.cx, cy: r.cy, count: r.cnt },
      })),
    });
  } catch (e) { next(e); }
});

/** 全局 Moran's I：六边形密度上的空间自相关检验 */
pois.get('/moran', async (req, res, next) => {
  try {
    const size = Math.min(Math.max(+(req.query.size || 0.01), 0.002), 0.1);
    const bbox = req.query.bbox || '114.08,30.44,114.56,30.72';
    const [minx, miny, maxx, maxy] = bbox.split(',').map(Number);
    const p = [size, minx, miny, maxx, maxy];
    if (req.query.categories) p.push(String(req.query.categories).split(','));
    const { rows } = await query(
      `SELECT ST_X(ST_Centroid(h.geom)) AS cx, ST_Y(ST_Centroid(h.geom)) AS cy, count(p.id)::int AS cnt
       FROM ST_HexagonGrid($1, ST_Expand(ST_MakeEnvelope($2,$3,$4,$5,4326), $1)) h
       LEFT JOIN poi.pois p
         ON p.geom && h.geom AND ST_Contains(h.geom, p.geom)
         ${req.query.categories ? 'AND p.category = ANY($6)' : ''}
       GROUP BY h.i, h.j, h.geom`, p);
    const m = moransI(rows.map((r) => ({ x: r.cx, y: r.cy, v: Math.log(1 + r.cnt) })), size);
    res.json({ size, ...m });
  } catch (e) { next(e); }
});

/** KNN 最近邻检索（GiST 索引 <-> 排序） */
pois.get('/nearest', async (req, res, next) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat/lng 必填' });
    const k = Math.min(+(req.query.k || 10), 50);
    const p = [+lng, +lat];
    let where = '';
    if (req.query.categories) { p.push(String(req.query.categories).split(',')); where = `WHERE p.category = ANY($${p.length})`; }
    if (req.query.kw) {
      p.push(`%${req.query.kw}%`);
      where += (where ? ' AND' : ' WHERE') + ` (p.name ILIKE $${p.length} OR p.subcategory ILIKE $${p.length} OR p.category ILIKE $${p.length})`;
    }
    p.push(k);
    const { rows } = await query(
      `SELECT ${COLS}, ST_Distance(p.geom::geography, ST_SetSRID(ST_Point($1,$2),4326)::geography)::int AS dist_m
       FROM poi.pois p ${where} ORDER BY p.geom <-> ST_SetSRID(ST_Point($1,$2),4326) LIMIT $${p.length}`, p);
    res.json({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.x, r.y] },
        properties: { id: r.id, name: r.name, category: r.category, subcategory: r.subcategory, rating: r.rating, price: r.price, dist_m: r.dist_m },
      })),
    });
  } catch (e) { next(e); }
});

/** 缓冲区分析：以某点为圆心统计半径内 POI 构成 */
pois.get('/buffer', async (req, res, next) => {
  try {
    const { lat, lng } = req.query;
    const r = Math.min(+(req.query.r || 1000), 10000);
    if (!lat || !lng) return res.status(400).json({ error: 'lat/lng 必填' });
    const p = [+lng, +lat, r];
    let catSql = '';
    if (req.query.categories) { p.push(String(req.query.categories).split(',')); catSql = `AND p.category = ANY($${p.length})`; }
    const circle = (await query(
      `SELECT ST_AsGeoJSON(ST_Buffer(ST_SetSRID(ST_Point($1,$2),4326)::geography, $3)::geometry)::json AS g`, [+lng, +lat, r])).rows[0].g;
    const { rows } = await query(
      `SELECT p.category, count(*)::int AS cnt, round(avg(p.rating)::numeric, 2)::float8 AS avg_rating,
              round(avg(p.price)::numeric, 0)::int AS avg_price
       FROM poi.pois p
       WHERE ST_DWithin(p.geom, ST_SetSRID(ST_Point($1,$2),4326)::geography, $3) ${catSql}
       GROUP BY p.category ORDER BY cnt DESC`, p);
    res.json({
      circle,
      total: rows.reduce((s, x) => s + x.cnt, 0),
      radius_m: r,
      byCategory: rows,
    });
  } catch (e) { next(e); }
});
