/**
 * API 集成测试（依赖：数据库已就绪、服务运行在 localhost:3000）
 * 运行: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:3000';
const BBOX = '114.08,30.44,114.56,30.72';
const get = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json().catch(() => null), res };
};

test('健康检查返回 PostGIS 版本', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.ok(body.ok);
  assert.match(body.postgis, /POSTGIS="3\./);
});

test('视野 POI 查询：GeoJSON 结构与上限约束', async () => {
  const { status, body } = await get(`/api/pois?bbox=${BBOX}&limit=500`);
  assert.equal(status, 200);
  assert.equal(body.type, 'FeatureCollection');
  assert.ok(body.count <= 500);
  const f = body.features[0];
  assert.ok(f.properties.name && f.properties.category);
  assert.equal(f.geometry.type, 'Point');
});

test('POI 汇总：全城 25 万条、9 类、6 区', async () => {
  const { body } = await get(`/api/pois/summary?bbox=${BBOX}`);
  assert.equal(body.total, 250000);
  assert.equal(body.byCategory.length, 9);
  assert.equal(body.byDistrict.length, 6);
});

test('关键词联动搜索：子类别也能命中', async () => {
  const { body } = await get(`/api/pois?bbox=${BBOX}&kw=${encodeURIComponent('火锅')}&limit=50`);
  assert.ok(body.count > 0);
  const hit = body.features.some((f) =>
    f.properties.subcategory.includes('火锅') || f.properties.name.includes('火锅') || f.properties.category.includes('火锅'));
  assert.ok(hit);
});

test('六边形密度：格网计数总和等于 POI 总数', async () => {
  const { body } = await get(`/api/pois/hexgrid?bbox=${BBOX}&size=0.02`);
  const sum = body.features.reduce((s, f) => s + f.properties.count, 0);
  assert.equal(sum, 250000);
});

test("全局 Moran's I：显著空间聚集", async () => {
  const { body } = await get('/api/pois/moran?size=0.02');
  assert.equal(body.significant, true);
  assert.ok(body.I > 0.3, `I=${body.I} 应为正自相关`);
});

test('KNN 最近邻：按距离递增返回', async () => {
  const { body } = await get('/api/pois/nearest?lat=30.593&lng=114.305&k=5');
  assert.equal(body.features.length, 5);
  const d = body.features.map((f) => f.properties.dist_m);
  for (let i = 1; i < d.length; i++) assert.ok(d[i] >= d[i - 1] - 1e-6);
});

test('缓冲区分析：类别构成完整、半径生效', async () => {
  const { body } = await get('/api/pois/buffer?lat=30.593&lng=114.305&r=1000');
  assert.ok(body.total > 1000);
  assert.equal(body.radius_m, 1000);
  assert.ok(body.byCategory.length >= 5);
  assert.equal(body.circle.type, 'Polygon');
});

test('MVT 瓦片：返回非空 protobuf', async () => {
  const { res } = await get('/tiles/pois/12/3348/1682.pbf');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /mapbox-vector-tile/);
  assert.ok(+(res.headers.get('content-length') || 0) > 100);
});

test('流域站点：12 个站、等级字段齐全', async () => {
  const { body } = await get('/api/basin/stations');
  assert.equal(body.stations.length, 12);
  const wq = body.stations.filter((s) => s.kind === 'water_quality');
  assert.equal(wq.length, 10);
  for (const s of wq) {
    assert.ok(s.grade >= 1 && s.grade <= 6);
    assert.ok(s.latest && s.latest.do_mgl > 0);
  }
});

test('站点时序：30 天按日聚合返回 28-31 个桶', async () => {
  const { body } = await get('/api/basin/stations/1/series?days=30&metrics=do_mgl,nh3_n');
  assert.ok(body.t.length >= 28 && body.t.length <= 31);
  assert.ok(body.series.do_mgl.every((v) => v === null || v > 0));
});

test('降雨-水质响应：存在明显降雨事件', async () => {
  const { body } = await get('/api/basin/rain-response?days=14');
  const maxRain = Math.max(...body.rainfall);
  assert.ok(maxRain > 1, '两周内应至少有一场降雨');
});

test('水质分级：全站分布在 Ⅱ~Ⅴ 且符合设计梯度', async () => {
  const { body } = await get('/api/basin/analysis/compliance?days=30');
  const grades = body.stations.map((s) => s.grade);
  assert.equal(grades.length, 10);
  assert.ok(Math.min(...grades) >= 2 && Math.max(...grades) <= 5);
  // 干流自上游（WQ001）到下游（WQ010）整体退化
  assert.ok(grades[0] < grades[9]);
});

test('超标预警：只含 Ⅳ 类及以下站点', async () => {
  const { body } = await get('/api/basin/alerts');
  for (const a of body.alerts) assert.ok(a.grade >= 4);
});

test('河流缓冲区：1km 内有污染源且负荷为正数', async () => {
  const { body } = await get('/api/basin/analysis/river-buffer?dist=1000');
  assert.ok(body.total > 10);
  assert.ok(body.totalLoadKg > 0);
  for (const s of body.sources) assert.ok(s.dist_m <= 1000);
});

test('流域 MVT：多图层瓦片非空', async () => {
  const { res } = await get('/tiles/basin/11/1674/841.pbf');
  assert.equal(res.status, 200);
  assert.ok(+(res.headers.get('content-length') || 0) > 50);
});
