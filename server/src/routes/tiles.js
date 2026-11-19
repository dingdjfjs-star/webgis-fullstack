import { Router } from 'express';
import { query } from '../db.js';

export const tiles = Router();

const MVT_TYPE = 'application/vnd.mapbox-vector-tile';

// 瓦片包络从 Web Mercator(3857) 转到 4326，才能用上数据表的 GiST 索引
const ENV = 'ST_Transform(ST_TileEnvelope($1,$2,$3), 4326)';

/** POI 矢量瓦片：ST_AsMVT + ST_TileEnvelope，类别过滤 */
tiles.get('/pois/:z/:x/:y.pbf', async (req, res, next) => {
  try {
    const { z, x, y } = req.params;
    const p = [+z, +x, +y];
    let catSql = '';
    if (req.query.categories) {
      p.push(String(req.query.categories).split(','));
      catSql = 'AND p.category = ANY($4)';
    }
    const { rows } = await query(
      `SELECT ST_AsMVT(q, 'pois', 4096, 'm') AS tile FROM (
         SELECT p.id, p.name, p.category, p.subcategory, p.rating::float8 AS rating, p.price,
                ST_AsMVTGeom(p.geom, ${ENV}, 4096, 64, true) AS m
         FROM poi.pois p
         WHERE p.geom && ${ENV} ${catSql}
         LIMIT 50000
       ) q`, p);
    const buf = rows[0].tile;
    res.set({ 'Content-Type': MVT_TYPE, 'Cache-Control': 'public, max-age=300' });
    res.end(buf?.length ? buf : undefined);
  } catch (e) { next(e); }
});

/** 流域矢量瓦片：多图层（河流/监测站/污染源）拼接为单瓦片 */
tiles.get('/basin/:z/:x/:y.pbf', async (req, res, next) => {
  try {
    const { z, x, y } = req.params;
    const layers = String(req.query.layers || 'rivers,stations,sources').split(',')
      .filter((l) => ['rivers', 'stations', 'sources'].includes(l));
    const chunks = [];
    for (const layer of layers) {
      const sql = {
        rivers: `SELECT r.id, r.name, r.strahler,
                 ST_AsMVTGeom(r.geom, ${ENV}, 4096, 32, true) AS m
                 FROM basin.rivers r WHERE r.geom && ${ENV}`,
        stations: `SELECT s.id, s.code, s.name, s.kind,
                 ST_AsMVTGeom(s.geom, ${ENV}, 4096, 64, true) AS m
                 FROM basin.stations s WHERE s.geom && ${ENV}`,
        sources: `SELECT s.id, s.name, s.type, s.load_cod,
                 ST_AsMVTGeom(s.geom, ${ENV}, 4096, 64, true) AS m
                 FROM basin.sources s WHERE s.geom && ${ENV}`,
      }[layer];
      const { rows } = await query(
        `SELECT ST_AsMVT(q, '${layer}', 4096, 'm') AS tile FROM (${sql}) q`, [+z, +x, +y]);
      if (rows[0].tile?.length) chunks.push(rows[0].tile);
    }
    res.set({ 'Content-Type': MVT_TYPE, 'Cache-Control': 'public, max-age=300' });
    res.end(chunks.length ? Buffer.concat(chunks) : undefined);
  } catch (e) { next(e); }
});
