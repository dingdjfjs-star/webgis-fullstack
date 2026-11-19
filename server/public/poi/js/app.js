'use strict';
/* global L, echarts */

// ================= 常量与状态 =================
const CAT_COLORS = {
  '餐饮': '#f25c54', '购物': '#f7b32b', '生活服务': '#4ecdc4', '休闲娱乐': '#a06cd5',
  '住宿': '#5aa9e6', '教育': '#7fb069', '医疗': '#ef476f', '公司企业': '#8d99ae', '汽车服务': '#b08968',
};
const HEX_RAMP = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']; // 密度色带

const state = {
  mode: 'cluster',
  cats: new Set(Object.keys(CAT_COLORS)),
  bufferArmed: false,
};

const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

// ================= 地图 =================
const map = L.map('map', { center: [30.58, 114.32], zoom: 12, preferCanvas: true });
const baseLayers = {
  '深色底图': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 16, attribution: '© Esri · 数据为模拟生成' }),
  '标准底图': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
  '卫星影像': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, attribution: '© Esri Imagery' }),
};
baseLayers['深色底图'].addTo(map);
L.control.layers(baseLayers, null, { position: 'bottomright' }).addTo(map);

const clusterGroup = L.markerClusterGroup({ disableClusteringAtZoom: 16, maxClusterRadius: 45, chunkedLoading: true });
const heatGroup = L.layerGroup();
const hexGroup = L.layerGroup();
const auxGroup = L.layerGroup(); // 缓冲区 / 最近邻标注
map.addLayer(auxGroup);
clusterGroup.addTo(map);

// ================= API 帮助函数 =================
async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  const t0 = performance.now();
  const res = await fetch('/api' + path + (qs ? '?' + qs : ''));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return { data: await res.json(), ms: Math.round(performance.now() - t0) };
}
const viewParams = () => ({
  bbox: map.getBounds().toBBoxString(),
  categories: [...state.cats].join(',') || undefined,
});
const hexSize = () => {
  const z = map.getZoom();
  return z <= 11 ? 0.03 : z <= 12 ? 0.018 : z <= 13 ? 0.012 : 0.006;
};

// ================= 三种分析模式 =================
async function loadCluster() {
  const { data, ms } = await api('/pois', { ...viewParams(), limit: 5000 });
  clusterGroup.clearLayers();
  for (const f of data.features) {
    const p = f.properties;
    clusterGroup.addLayer(L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
      radius: 4, weight: 0.6, color: '#0b0f14', fillColor: CAT_COLORS[p.category] || '#ccc', fillOpacity: 0.92,
    }).bindPopup(`<b>${p.name}</b><br>${p.category} · ${p.subcategory || ''}<br>评分 ${p.rating ?? '—'} ｜ 人均 ¥${p.price ?? '—'}`));
  }
  $('map-chip').textContent = `视野内 POI：${data.count.toLocaleString()}${data.count >= 5000 ? '（已达上限，建议切热力/密度模式）' : ''}`;
  setStatus(`点位聚合 · ${data.count.toLocaleString()} 要素 · ${ms} ms`);
}

async function loadHeat() {
  const prec = map.getZoom() >= 13 ? 4 : 3;
  const { data, ms } = await api('/pois/heatmap', { ...viewParams(), prec });
  heatGroup.clearLayers();
  const max = Math.max(...data.points.map((x) => x[2]), 1);
  const layer = L.heatLayer(data.points, {
    radius: 22, blur: 18, maxZoom: 16, minOpacity: 0.04, max,
    gradient: { 0.15: '#2c7bb6', 0.35: '#abd9e9', 0.55: '#ffffbf', 0.75: '#fdae61', 1: '#d7191c' },
  });
  heatGroup.addLayer(layer);
  $('map-chip').textContent = `热力栅格：${data.points.length.toLocaleString()} 格`;
  setStatus(`热力图 · ${data.points.length.toLocaleString()} 聚合格网 · ${ms} ms`);
}

async function loadHex() {
  const { data, ms } = await api('/pois/hexgrid', { ...viewParams(), size: hexSize() });
  hexGroup.clearLayers();
  const counts = data.features.map((f) => f.properties.count).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => counts.length ? counts[Math.min(Math.floor(p * counts.length), counts.length - 1)] : 0;
  const breaks = [q(0.2), q(0.4), q(0.6), q(0.8), Infinity];
  const color = (c) => c <= 0 ? '#202a36' : HEX_RAMP[breaks.findIndex((b) => c <= b)];
  const geo = L.geoJSON(data, {
    style: (f) => ({ weight: 0.4, color: '#0b0f14', fillColor: color(f.properties.count), fillOpacity: 0.78 }),
    onEachFeature: (f, l) => l.bindTooltip(`${f.properties.count.toLocaleString()} 个 POI`, { sticky: true }),
  });
  hexGroup.addLayer(geo);
  $('map-chip').textContent = `六边形格网：${data.features.length.toLocaleString()} 格（边长 ${(hexSize() * 87000).toFixed(0)}m）`;
  setStatus(`六边形密度 · ${data.features.length.toLocaleString()} 格 · ${ms} ms`);
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  [clusterGroup, heatGroup, hexGroup].forEach((l) => map.removeLayer(l));
  ({ cluster: clusterGroup, heat: heatGroup, hex: hexGroup })[mode].addTo(map);
  renderLegend();
  refresh();
}

// ================= 刷新调度 =================
let timer = null;
const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(refresh, 350); };
async function refresh() {
  try {
    if (state.mode === 'cluster') await loadCluster();
    else if (state.mode === 'heat') await loadHeat();
    else await loadHex();
    loadCharts();
  } catch (e) { setStatus('查询失败：' + e.message); }
}

// ================= 图表（ECharts）=================
const pie = echarts.init($('chart-pie'), null, { renderer: 'canvas' });
const bar = echarts.init($('chart-bar'), null, { renderer: 'canvas' });
const AXIS = { axisLine: { lineStyle: { color: '#3a4b60' } }, axisLabel: { color: '#8fa1b5' } };
pie.setOption({
  textStyle: { color: '#dbe4ee' },
  tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
  series: [{ type: 'pie', radius: ['38%', '68%'], center: ['50%', '52%'],
    label: { color: '#dbe4ee', fontSize: 11 }, itemStyle: { borderColor: '#151d28', borderWidth: 1 }, data: [] }],
});
bar.setOption({
  textStyle: { color: '#dbe4ee' },
  grid: { left: 70, right: 40, top: 10, bottom: 24 },
  tooltip: {},
  xAxis: { type: 'value', ...AXIS, splitLine: { lineStyle: { color: '#1f2b3a' } } },
  yAxis: { type: 'category', ...AXIS, data: [] },
  series: [{ type: 'bar', barMaxWidth: 14, itemStyle: { color: '#38bdf8' }, data: [] }],
});

async function loadCharts() {
  try {
    const { data } = await api('/pois/summary', viewParams());
    pie.setOption({ series: [{ data: data.byCategory.map((r) => ({
      name: r.category, value: r.cnt, itemStyle: { color: CAT_COLORS[r.category] || '#999' } })) }] });
    const d = [...data.byDistrict].reverse();
    bar.setOption({ yAxis: { data: d.map((r) => r.district) }, series: [{ data: d.map((r) => r.cnt) }] });
  } catch { /* 静默：图随主流程重试 */ }
}

$('btn-moran').addEventListener('click', async () => {
  $('moran-card').textContent = '计算中…';
  try {
    const { data } = await api('/pois/moran', { ...viewParams(), size: hexSize() });
    if (!data) { $('moran-card').textContent = '格网数不足，请缩小范围或减小格网'; return; }
    $('moran-card').innerHTML =
      `Moran's I = <b>${data.I}</b> ｜ 期望值 ${data.expected}<br>` +
      `z 得分 = <b>${data.z}</b> <span class="sig" style="background:${data.significant ? '#0c3a52' : '#33404f'}">` +
      `${data.significant ? '显著 (p<0.05)' : '不显著'}</span><br>` +
      `结论：<b>${data.label}</b><br>` +
      `<span style="color:#8fa1b5">格网 n=${data.n}，邻接对 ${data.pairs}；变量 = ln(1+POI数)</span>`;
  } catch (e) { $('moran-card').textContent = '计算失败：' + e.message; }
});

// ================= 类别筛选 =================
function buildCatList() {
  $('cat-list').innerHTML = Object.entries(CAT_COLORS).map(([c, col]) => `
    <label class="cat-item" data-cat="${c}">
      <input type="checkbox" checked><span class="cat-dot" style="background:${col}"></span>${c}
    </label>`).join('');
  $('cat-list').addEventListener('change', (e) => {
    const label = e.target.closest('.cat-item');
    const cat = label.dataset.cat;
    e.target.checked ? state.cats.add(cat) : state.cats.delete(cat);
    label.classList.toggle('off', !e.target.checked);
    refresh();
  });
  $('cat-all').addEventListener('click', () => { syncCats(true); });
  $('cat-none').addEventListener('click', () => { syncCats(false); });
}
function syncCats(on) {
  state.cats = on ? new Set(Object.keys(CAT_COLORS)) : new Set();
  document.querySelectorAll('.cat-item').forEach((l) => {
    l.querySelector('input').checked = on;
    l.classList.toggle('off', !on);
  });
  refresh();
}

// ================= 最近邻检索 =================
async function searchNearest() {
  const kw = $('kw').value.trim();
  const c = map.getCenter();
  $('nearest-list').innerHTML = '<li>检索中…</li>';
  try {
    const { data } = await api('/pois/nearest', { lat: c.lat, lng: c.lng, k: 8, kw, categories: [...state.cats].join(',') || undefined });
    auxGroup.clearLayers();
    auxGroup.addLayer(L.circleMarker([c.lat, c.lng], { radius: 6, color: '#38bdf8', fillOpacity: 1 })
      .bindTooltip('检索起点（视图中心）'));
    $('nearest-list').innerHTML = data.features.length ? data.features.map((f, i) => {
      const p = f.properties;
      return `<li data-i="${i}"><span style="color:${CAT_COLORS[p.category] || '#ccc'}">●</span>
        <span style="flex:1">${p.name}</span><span class="d">${p.dist_m} m</span></li>`;
    }).join('') : '<li>未找到匹配设施</li>';
    auxGroup.eachLayer((l) => { if (l.bindPopup) l.closePopup(); });
    data.features.forEach((f) => auxGroup.addLayer(L.circleMarker(
      [f.geometry.coordinates[1], f.geometry.coordinates[0]],
      { radius: 5, color: '#fff', weight: 1.5, fillColor: CAT_COLORS[f.properties.category] || '#ccc', fillOpacity: 1 }
    ).bindPopup(`<b>${f.properties.name}</b><br>距离起点 ${f.properties.dist_m} m`)));
    $('nearest-list').querySelectorAll('li[data-i]').forEach((li) => {
      li.addEventListener('click', () => {
        const f = data.features[+li.dataset.i];
        map.flyTo([f.geometry.coordinates[1], f.geometry.coordinates[0]], Math.max(map.getZoom(), 15));
      });
    });
    setStatus(`最近邻 KNN · 返回 ${data.features.length} 条`);
  } catch (e) { $('nearest-list').innerHTML = `<li>失败：${e.message}</li>`; }
}

// ================= 缓冲区分析 =================
$('btn-buffer').addEventListener('click', () => {
  state.bufferArmed = !state.bufferArmed;
  $('btn-buffer').textContent = state.bufferArmed ? '点地图选圆心…' : '圈选';
  $('buf-hint').textContent = state.bufferArmed ? '在地图上点击任意位置作为圆心' : '点击「圈选」后在地图上点击圆心';
  $('map').style.cursor = state.bufferArmed ? 'crosshair' : '';
});

async function runBuffer(latlng) {
  const r = +$('buf-r').value;
  const t0 = performance.now();
  try {
    const { data } = await api('/pois/buffer', {
      lat: latlng.lat, lng: latlng.lng, r, categories: [...state.cats].join(',') || undefined,
    });
    auxGroup.eachLayer((l) => { if (l._isBuf) auxGroup.removeLayer(l); });
    const circle = L.geoJSON(data.circle, { style: { color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.08 } });
    circle.eachLayer((l) => { l._isBuf = true; auxGroup.addLayer(l); });
    auxGroup.addLayer(L.circleMarker([latlng.lat, latlng.lng], { radius: 5, color: '#fff', fillColor: '#38bdf8', fillOpacity: 1, _isBuf: true }));
    const rows = data.byCategory.slice(0, 6).map((x) =>
      `<tr><td><span class="cat-dot" style="background:${CAT_COLORS[x.category]}"></span> ${x.category}</td>
       <td>${x.cnt.toLocaleString()}</td><td>${x.avg_rating ?? '—'}</td></tr>`).join('');
    $('buf-result').innerHTML =
      `<table><tr><th>类别</th><th>数量</th><th>均分</th></tr>${rows}
       <tr><td class="total">合计</td><td class="total">${data.total.toLocaleString()}</td><td></td></tr></table>
       <p class="hint">半径 ${r} m · ST_DWithin 球面距离 · ${Math.round(performance.now() - t0)} ms</p>`;
  } catch (e) { $('buf-result').innerHTML = `<p class="hint">失败：${e.message}</p>`; }
}
map.on('click', (e) => { if (state.bufferArmed) runBuffer(e.latlng); });

// ================= 图例 / 面板 / 事件绑定 =================
function renderLegend() {
  let old = $('legend'); if (old) old.remove();
  const div = document.createElement('div');
  div.id = 'legend';
  if (state.mode === 'hex') {
    div.innerHTML = '<b>六边形密度</b><br>' + HEX_RAMP.map((c, i) =>
      `<span class="cat-dot" style="background:${c}"></span> ${['低', '较低', '中', '较高', '高'][i]}`).join('　');
  } else if (state.mode === 'heat') {
    div.innerHTML = '<b>热力图</b><br><span style="background:linear-gradient(90deg,#2c7bb6,#abd9e9,#ffffbf,#fdae61,#d7191c);display:inline-block;width:120px;height:8px;border-radius:3px"></span><br>低 → 高';
  } else {
    div.innerHTML = '<b>POI 类别</b><br>' + Object.entries(CAT_COLORS).slice(0, 9).map(([c, col]) =>
      `<span class="cat-dot" style="background:${col}"></span>${c}`).join('　');
  }
  document.body.appendChild(div);
}

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('btn-nearest').addEventListener('click', searchNearest);
$('kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchNearest(); });
map.on('moveend', scheduleRefresh);
$('panel-toggle').addEventListener('click', () => {
  const p = $('charts-panel'), open = p.classList.toggle('open');
  $('panel-toggle').classList.toggle('open', open);
  $('panel-toggle').textContent = open ? '收起 ▶' : '统计图表 ◀';
  setTimeout(() => { pie.resize(); bar.resize(); }, 280);
});

// ================= 启动 =================
buildCatList();
renderLegend();
refresh();
