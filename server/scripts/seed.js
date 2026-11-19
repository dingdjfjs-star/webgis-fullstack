/**
 * 种子数据生成器 —— 两套系统的全部数据都在这里合成：
 *   poi   : 25 万条 POI（CBD/区中心高斯聚集 + 沿路分布 + 乡村均匀，混合空间模型）
 *   basin : 河网 + 监测站 + 污染源 + 一年逐小时水质/降雨时序（含降雨驱动的水质响应）
 * 确定性随机（固定种子），重复执行结果一致。幂等：先 TRUNCATE 再灌数。
 *
 * 运行: npm run seed  （先确保数据库已启动，见 scripts/start-db.bat）
 */
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import copyFrom from 'pg-copy-streams';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

// ---------- 确定性随机 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260829);
const rand = () => rng();
const randn = () => { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- 研究区范围（虚构城市“临江市”）----------
const ENV = { minX: 114.08, minY: 30.44, maxX: 114.56, maxY: 30.72 };
const inEnv = (x, y) => x > ENV.minX && x < ENV.maxX && y > ENV.minY && y < ENV.maxY;

// 6 个行政区中心（经纬度）
const DISTRICTS = [
  { name: '城关区', x: 114.305, y: 30.593 },
  { name: '江北区', x: 114.310, y: 30.655 },
  { name: '云溪区', x: 114.400, y: 30.560 },
  { name: '柳林区', x: 114.230, y: 30.545 },
  { name: '白沙区', x: 114.420, y: 30.640 },
  { name: '望湖区', x: 114.170, y: 30.625 },
];
const CBD = [
  { x: 114.305, y: 30.593 }, { x: 114.365, y: 30.558 }, { x: 114.272, y: 30.628 },
];

// ---------- POI 类别体系 ----------
const CATS = [
  { name: '餐饮', w: 0.24, price: 55, subs: ['火锅', '川菜', '粤菜', '面馆', '烧烤', '烘焙饮品', '快餐', '西餐'],
    brands: ['老码头', '蜀香居', '粤海轩', '一面之缘', '串串工坊', '麦香坊', '快客堡', '蓝湾西餐厅', '辣道', '汤膳坊', '竹里馆', '半山食府'] },
  { name: '购物', w: 0.20, price: 90, subs: ['超市', '便利店', '购物中心', '菜市场', '专卖店', '书店', '花店'],
    brands: ['惠民超市', '万家福', '邻里便利', '中和广场', '百汇商城', '晨光文具店', '花间集', '优品优选', '好邻居'] },
  { name: '生活服务', w: 0.14, price: 40, subs: ['理发美容', '洗衣店', '快递网点', '家电维修', '家政服务', '照相馆'],
    brands: ['精剪造型', '洁丰洗衣', '顺达快递', '百修家电', '安佳家政', '真彩照相'] },
  { name: '休闲娱乐', w: 0.12, price: 75, subs: ['KTV', '电影院', '健身房', '网咖', '茶馆', '桌游吧', '游泳馆'],
    brands: ['星光KTV', '保利影城', '力美健健身', '极客网咖', '清风茶楼', 'ABC桌游', '碧波泳馆', '迷笛琴行'] },
  { name: '住宿', w: 0.08, price: 260, subs: ['快捷酒店', '星级酒店', '民宿', '青年旅舍'],
    brands: ['如家精选', '锦江之星', '临江大酒店', '半岛酒店', '山舍民宿', '青旅客栈', '悦榕庄'] },
  { name: '教育', w: 0.08, price: 120, subs: ['幼儿园', '小学', '中学', '培训学校', '图书馆'],
    brands: ['临江一中', '城关二小', '双语幼儿园', '新东方培训', '市图书馆', '实验中学', '少年宫'] },
  { name: '医疗', w: 0.06, price: 150, subs: ['综合医院', '社区卫生中心', '诊所', '药店', '口腔门诊'],
    brands: ['临江市第一人民医院', '仁爱诊所', '康泰大药房', '惠民社区卫生中心', '博雅口腔', '中医馆'] },
  { name: '公司企业', w: 0.05, price: 60, subs: ['科技公司', '物流仓储', '建筑公司', '设计院', '金融服务'],
    brands: ['云图科技', '临江物流园', '宏达建设', '市政设计院', '临江银行', '汇智软件'] },
  { name: '汽车服务', w: 0.03, price: 200, subs: ['4S店', '洗车行', '加油站', '停车场'],
    brands: ['中石油加油站', '车爵士', '大众4S店', '极速洗车', '捷安停车'] },
];
const SUFFIX = ['', '', '旗舰店', '总店', '一店', '二店', '东门店', '西门店'];
const N_POI = 250000;

// ---------- 河网 ----------
function buildRivers() {
  const rivers = []; // {name, strahler, pts:[[x,y]...]}
  const stem = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    stem.push([
      114.10 + 0.42 * t,
      30.68 - 0.17 * t + 0.012 * Math.sin(7 * t) + 0.006 * Math.sin(23 * t),
    ]);
  }
  rivers.push({ name: '临江（干流）', strahler: 4, pts: stem });

  const tribDefs = [
    ['柳林河', 'N', 0.12, 0.055], ['清溪河', 'S', 0.24, 0.075], ['云峰溪', 'N', 0.38, 0.060],
    ['白沙河', 'N', 0.55, 0.080], ['泗水河', 'S', 0.68, 0.065], ['洛清江', 'S', 0.84, 0.070],
  ];
  const tribPts = [];
  for (const [name, side, t0, len] of tribDefs) {
    const j = stem[Math.floor(t0 * 60)];
    const sign = side === 'N' ? 1 : -1;
    const pts = [];
    for (let i = 0; i <= 26; i++) {
      const s = i / 26;
      pts.push([
        j[0] + sign * len * s * 0.9 + 0.006 * Math.sin(9 * s) * sign,
        j[1] + len * s * (side === 'N' ? 0.55 : 0.75) + 0.008 * Math.sin(13 * s),
      ]);
    }
    rivers.push({ name, strahler: 3, pts });
    tribPts.push({ name, pts });
  }
  // 二级支流
  const subDefs = [['杏花沟', 0, 0.4], ['磨盘溪', 1, 0.6], ['芦苇河', 3, 0.45], ['倒淌河', 4, 0.5]];
  for (const [name, ti, t0] of subDefs) {
    const base = tribPts[ti].pts;
    const j = base[Math.floor(t0 * (base.length - 1))];
    const perp = ti % 2 === 0 ? [0.35, 1] : [1, 0.35];
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const s = i / 14;
      pts.push([j[0] + perp[0] * 0.03 * s + 0.004 * Math.sin(11 * s), j[1] + perp[1] * 0.03 * s + 0.003 * Math.cos(9 * s)]);
    }
    rivers.push({ name, strahler: 2, pts });
  }
  // 河源级小溪
  for (let k = 0; k < 4; k++) {
    const base = tribPts[k % tribPts.length].pts;
    const j = base[Math.floor((0.3 + 0.2 * k) * (base.length - 1))];
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      pts.push([j[0] - 0.02 * s + 0.003 * Math.sin(17 * s + k), j[1] + 0.018 * s]);
    }
    rivers.push({ name: `${['无名', '东', '西', '北'][k]}小溪${k + 1}号`, strahler: 1, pts });
  }
  return rivers;
}
const onLine = (pts, t) => {
  const seg = t * (pts.length - 1);
  const i = Math.min(Math.floor(seg), pts.length - 2);
  const f = seg - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
};

// ---------- 主流程 ----------
const client = new Client({
  host: process.env.PGHOST, port: +process.env.PGPORT,
  user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE,
});
await client.connect();
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// 0) 建表
await client.query(fs.readFileSync(path.join(ROOT, 'db', '01_init.sql'), 'utf8'));
await client.query(`TRUNCATE poi.pois, poi.districts, basin.readings, basin.stations,
  basin.sources, basin.rivers, basin.boundary RESTART IDENTITY CASCADE`);
log('建表完成（schema: poi / basin）');

// 1) 行政区：六边形网格 → 就近分配 → 并合成面（类 Voronoi，保证无缝覆盖）
await client.query(`
  INSERT INTO poi.districts (name, geom)
  WITH centers(name, geom) AS (
    ${DISTRICTS.map((d, i) => `SELECT '${d.name}', ST_SetSRID(ST_MakePoint(${d.x}, ${d.y}), 4326)`).join(' UNION ALL ')}
  ),
  hexes AS (
    SELECT h.geom FROM ST_HexagonGrid(0.045, ST_MakeEnvelope(${ENV.minX}, ${ENV.minY}, ${ENV.maxX}, ${ENV.maxY}, 4326)) h
  )
  SELECT c.name, ST_Multi(ST_UnaryUnion(ST_Collect(h.geom)))
  FROM hexes h
  CROSS JOIN LATERAL (
    SELECT ce.name FROM centers ce ORDER BY ce.geom <-> ST_Centroid(h.geom) LIMIT 1
  ) c
  GROUP BY c.name`);
log('行政区边界合成完成（六边形 Voronoi）');

// 2) 25 万 POI：混合空间分布模型
const roads = [];
for (let r = 0; r < 40; r++) {
  const diag = rand() < 0.2;
  const ang = (diag ? pick([45, 135]) : pick([0, 90])) + randn() * 8;
  const a = (ang * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  let x = ENV.minX + rand() * (ENV.maxX - ENV.minX);
  let y = ENV.minY + rand() * (ENV.maxY - ENV.minY);
  const len = 0.2 + rand() * 0.25, step = 0.012, pts = [];
  for (let s = 0; s * step < len; s++) { pts.push([x, y]); x += dx * step + randn() * 0.0015; y += dy * step + randn() * 0.0015; }
  if (pts.length > 2) roads.push(pts);
}
const roadLens = roads.map((pts) => {
  let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
});
const roadTotal = roadLens.reduce((a, b) => a + b, 0);
const catPicker = (() => {
  const acc = []; let s = 0;
  for (const c of CATS) { s += c.w; acc.push([s, c]); }
  return () => { const r = rand() * s; for (const [a, c] of acc) if (r <= a) return c; return CATS[0]; };
})();
const nameUsed = new Map();
function poiName(cat, brand) {
  const nm = brand + pick(SUFFIX);
  const k = cat.name + '|' + nm;
  const n = (nameUsed.get(k) || 0) + 1;
  nameUsed.set(k, n);
  return n === 1 ? nm : `${nm}(${n}号店)`;
}
const wkt = (x, y) => `POINT(${x.toFixed(6)} ${y.toFixed(6)})`;
const pois = new Array(N_POI);
for (let i = 0; i < N_POI; i++) {
  let x, y;
  const u = rand();
  if (u < 0.45) { const c = pick(CBD); x = c.x + randn() * 0.008; y = c.y + randn() * 0.008; }        // CBD 强聚集
  else if (u < 0.80) { const d = pick(DISTRICTS); x = d.x + randn() * 0.020; y = d.y + randn() * 0.020; } // 区中心次级聚集
  else if (u < 0.95) {                                                                                  // 沿主干道
    let r = rand() * roadTotal, ri = 0;
    while (r > roadLens[ri]) { r -= roadLens[ri]; ri++; }
    const seg = r / roadLens[ri] * (roads[ri].length - 1);
    const si = Math.min(Math.floor(seg), roads[ri].length - 2), f = seg - si;
    const p0 = roads[ri][si], p1 = roads[ri][si + 1];
    x = p0[0] + (p1[0] - p0[0]) * f + randn() * 0.0012;
    y = p0[1] + (p1[1] - p0[1]) * f + randn() * 0.0012;
  } else { x = ENV.minX + rand() * (ENV.maxX - ENV.minX); y = ENV.minY + rand() * (ENV.maxY - ENV.minY); } // 均匀
  if (!inEnv(x, y)) { i--; continue; }
  const cat = catPicker();
  const rating = clamp(3.1 + Math.abs(randn()) * 0.85, 1, 5).toFixed(1);
  const price = Math.round(cat.price * Math.exp(randn() * 0.5));
  pois[i] = [poiName(cat, pick(cat.brands)), cat.name, pick(cat.subs), rating, price, wkt(x, y)];
}
log(`POI 生成完成（${N_POI.toLocaleString()} 条）`);

// COPY 入库
async function copyRows(table, cols, rows) {
  const stream = client.query(copyFrom.from(`COPY ${table} (${cols.join(',')}) FROM STDIN WITH (FORMAT csv)`));
  const CH = 20000;
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH)
      .map((r) => r.map((v) => (v == null ? '' : String(v).replace(/"/g, '""'))).map((v) => (/,|"|\n/.test(v) ? `"${v}"` : v)).join(','))
      .join('\n') + '\n';
    if (!stream.write(chunk)) await new Promise((res) => stream.once('drain', res));
  }
  stream.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
}
await copyRows('poi.pois', ['name', 'category', 'subcategory', 'rating', 'price', 'geom'], pois);
log('POI COPY 入库完成');

await client.query(`
  UPDATE poi.pois p SET district_id = d.id
  FROM poi.districts d
  WHERE p.geom && d.geom AND ST_Contains(d.geom, p.geom)`);
log('POI 归属行政区回填完成');

// 3) 河网 + 边界
const rivers = buildRivers();
for (const r of rivers) {
  const line = `LINESTRING(${r.pts.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(',')})`;
  await client.query('INSERT INTO basin.rivers(name, strahler, geom) VALUES ($1,$2,ST_SetSRID($3::geometry,4326))', [r.name, r.strahler, line]);
}
const stem = rivers[0].pts;
await client.query(`
  INSERT INTO basin.boundary(name, geom)
  SELECT '临江流域', ST_Multi(ST_Buffer(ST_ConvexHull(ST_Collect(geom))::geography, 1500)::geometry)
  FROM basin.rivers`);
log(`河网入库（${rivers.length} 条河流）+ 流域边界`);

// 4) 监测站：10 个水质站 + 2 个水文站
const STATION_DEFS = [
  ['WQ001', '临江·青石渡站', 0, 0.06, 0], ['WQ002', '临江·望江楼站', 0, 0.16, 0],
  ['WQ003', '临江·白沙洲站', 0, 0.28, 0.15], ['WQ004', '临江·双龙渡站', 0, 0.40, 0.3],
  ['WQ005', '柳林河·汇口站', 1, 0.45, 0.4], ['WQ006', '清溪河·中游站', 2, 0.50, 0.45],
  ['WQ007', '临江·云溪湾站', 0, 0.58, 0.55], ['WQ008', '临江·柳荫渡站', 0, 0.72, 0.6],
  ['WQ009', '临江·工业走廊站', 0, 0.84, 1.0], ['WQ010', '临江·入湖口站', 0, 0.95, 1.05],
  ['HD001', '临江·城西水文站', 0, 0.22, 0], ['HD002', '临江·东坝水文站', 0, 0.66, 0],
];
const stationRows = [];
for (const [code, name, ri, t, deg] of STATION_DEFS) {
  const [x, y] = onLine(rivers[ri].pts, t);
  stationRows.push({ code, name, kind: code.startsWith('WQ') ? 'water_quality' : 'hydrology', deg, x, y });
  await client.query(
    'INSERT INTO basin.stations(code,name,kind,river_id,km,geom) VALUES ($1,$2,$3,$4,$5,ST_SetSRID($6::geometry,4326))',
    [code, name, code.startsWith('WQ') ? 'water_quality' : 'hydrology', ri + 1, +(t * 46.6).toFixed(1), wkt(x, y)]);
}
log(`监测站布设完成（${stationRows.length} 个）`);

// 5) 污染源：工业源聚集在 WQ009/WQ010 上游河段，其余沿河分散
const srcTypes = [['industrial', 'industrial'], ['domestic', 'domestic'], ['agricultural', 'agricultural']];
const SRC_NAMES = {
  industrial: ['华峰化工', '临江造纸二厂', '电镀产业园', '金田纺织', '兴业制药', '钢材酸洗厂', '临江热电厂', '汇丰印染', '化工仓储区', '皮革工业园'],
  domestic: ['城南污水厂排放口', '河西污水泵站', '柳林河镇区排口', '云溪镇排口', '城关合流溢流口', '望湖新镇排口', '白沙集镇排口', '泗水河镇排口'],
  agricultural: ['青禾养殖场', '向阳农场', '绿源猪场', '河西种植基地', '洛清江畜禽区', '望湖鱼塘片区', '稻花洲农田区'],
};
let si = 0;
for (const [type, arr] of Object.entries(SRC_NAMES)) {
  for (const name of arr) {
    let x, y;
    if (type === 'industrial') { [x, y] = onLine(stem, 0.76 + rand() * 0.16); }
    else if (type === 'domestic') { const r = pick(rivers.slice(1, 5)); [x, y] = onLine(r.pts, 0.2 + rand() * 0.6); }
    else { const r = pick(rivers.slice(1)); [x, y] = onLine(r.pts, rand()); }
    x += randn() * 0.004; y += randn() * 0.004;
    const load = (type === 'industrial' ? 40 : type === 'domestic' ? 18 : 10) * (0.4 + rand() * 1.6);
    await client.query('INSERT INTO basin.sources(name,type,load_cod,geom) VALUES ($1,$2,$3,ST_SetSRID($4::geometry,4326))',
      [name, type, +load.toFixed(1), wkt(x, y)]);
    si++;
  }
}
log(`污染源入库（${si} 个，工业源向下游工业段聚集）`);

// 6) 一年逐小时水质/降雨时序（10 个水质站 × 8760 小时）
const T_END = Date.UTC(2026, 7, 29, 0, 0, 0); // 2026-08-29T00:00Z
const H = 24 * 365;
const HOUR = 3600e3;
const wqRows = [];
const rainStorm = new Float32Array(H);
// 全域共用的降雨过程：日概率 0.33，历时 3-10h，强度先升后降
{
  let h = 0;
  while (h < H) {
    if (rand() < 0.33) {
      const dur = 3 + Math.floor(rand() * 8);
      const peak = 0.5 + rand() * 5.5;
      for (let k = 0; k < dur && h + k < H; k++) {
        const ph = Math.sin((Math.PI * k) / dur);
        rainStorm[h + k] = peak * ph * (0.7 + rand() * 0.6);
      }
      h += dur + Math.floor(rand() * 12);
    } else h += 6 + Math.floor(rand() * 12);
  }
}
const season = (h) => Math.cos((2 * Math.PI * (h % (24 * 365))) / (24 * 365)); // 冬 1 夏 -1
for (const st of stationRows.filter((s) => s.kind === 'water_quality')) {
  const d = st.deg;
  const bDo = 8.2 - 2.6 * d, bCod = 2.4 + 2.9 * d, bNh3 = 0.30 + 1.35 * d, bTp = 0.05 + 0.16 * d;
  for (let h = 0; h < H; h++) {
    const storm = rainStorm[h];
    const stormLag = h >= 2 ? (rainStorm[h - 1] + rainStorm[h - 2]) / 2 : 0;
    const diurnal = Math.sin((2 * Math.PI * (h % 24)) / 24);
    const temp = 17.5 - 8.5 * season(h) + randn() * 0.8;
    const ph = clamp(7.25 + 0.25 * diurnal + randn() * 0.12 - 0.3 * d, 5.8, 9.0);
    const doMgl = clamp(bDo + 1.1 * season(h) - 0.15 * diurnal - 0.7 * stormLag + randn() * 0.3, 0.8, 13);
    const codMn = clamp(bCod + 0.4 * diurnal + 1.6 * stormLag + randn() * 0.35, 0.5, 30);
    const nh3 = clamp(bNh3 + 0.12 * diurnal + 0.38 * stormLag + randn() * 0.09, 0.02, 6);
    const tp = clamp(bTp + 0.05 * stormLag + Math.abs(randn()) * 0.015, 0.005, 1.2);
    const turb = clamp(9 + 52 * storm * storm + 8 * stormLag + Math.abs(randn()) * 2.5, 1, 400);
    const ts = new Date(T_END - (H - 1 - h) * HOUR).toISOString();
    wqRows.push([st.code, ts, temp.toFixed(2), ph.toFixed(2), doMgl.toFixed(2), codMn.toFixed(2), nh3.toFixed(3), tp.toFixed(3), turb.toFixed(1), storm.toFixed(2)]);
  }
}
log(`水质时序生成完成（${(wqRows.length / 10000).toFixed(1)} 万行，含降雨-水质响应）`);
// 站点 code → id 映射
const { rows: idMap } = await client.query('SELECT id, code FROM basin.stations');
const idBy = Object.fromEntries(idMap.map((r) => [r.code, r.id]));
// 时序 COPY 列顺序与 readings 表一致
await copyRows('basin.readings', ['station_id', 'ts', 'temp', 'ph', 'do_mgl', 'cod_mn', 'nh3_n', 'tp', 'turbidity', 'rainfall'],
  wqRows.map((r) => [idBy[r[0]], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]]));
log('时序 COPY 入库完成');

await client.query('ANALYZE poi.pois; ANALYZE basin.readings; ANALYZE poi.districts; ANALYZE basin.rivers;');
const { rows: cnt } = await client.query(`
  SELECT (SELECT count(*) FROM poi.pois) pois, (SELECT count(*) FROM basin.readings) readings,
         (SELECT count(*) FROM basin.rivers) rivers, (SELECT count(*) FROM basin.stations) stations,
         (SELECT count(*) FROM basin.sources) sources`);
log(`完成 ✅  ${JSON.stringify(cnt[0])}`);
await client.end();
