'use strict';
/* global Cesium, echarts */

window.CESIUM_BASE_URL = '/vendor/cesium/';
const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $('status').textContent = t; };

const METRICS = {
  do_mgl: { name: '溶解氧', unit: 'mg/L', color: '#38bdf8' },
  nh3_n: { name: '氨氮', unit: 'mg/L', color: '#f39c12' },
  cod_mn: { name: '高锰酸盐指数', unit: 'mg/L', color: '#2ecc71' },
  tp: { name: '总磷', unit: 'mg/L', color: '#e74c3c' },
};
const SOURCE_COLORS = { industrial: '#e74c3c', domestic: '#e67e22', agricultural: '#f1c40f' };
const SOURCE_NAMES = { industrial: '工业', domestic: '生活', agricultural: '农业' };

// ================= Cesium 场景 =================
const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri · 数据为模拟生成',
    maximumLevel: 16,
  })),
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false,
  contextOptions: { webgl: { preserveDrawingBuffer: true } }, // 保证截屏/录屏可见
});
viewer.scene.globe.enableLighting = false;
window.viewer = viewer; // 调试用
viewer.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
  if (n === 0) setStatus('地形/影像瓦片加载完毕');
});

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(114.32, 30.55, 62000),
});

// ================= 图表 =================
const chartGrade = echarts.init($('chart-grade'));
const chartSeries = echarts.init($('chart-series'));
const chartRain = echarts.init($('chart-rain'));
const gradeOption = {
  tooltip: { trigger: 'item', formatter: '{b}类：{c} 个站' },
  series: [{ type: 'pie', radius: ['45%', '78%'], center: ['50%', '55%'],
    label: { color: '#dbe4ee', fontSize: 10, formatter: '{b} {c}' },
    data: [{ name: 'Ⅱ', value: 0, itemStyle: { color: '#38b000' } },
           { name: 'Ⅲ', value: 0, itemStyle: { color: '#f1c40f' } },
           { name: 'Ⅳ', value: 0, itemStyle: { color: '#e67e22' } },
           { name: 'Ⅴ', value: 0, itemStyle: { color: '#e74c3c' } },
           { name: '劣Ⅴ', value: 0, itemStyle: { color: '#8e44ad' } }] }],
};
chartGrade.setOption(gradeOption);

// ================= 数据加载 =================
async function api(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined)).toString();
  const res = await fetch('/api/basin' + path + (qs ? '?' + qs : ''));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

let stations = [];
const entities = { rivers: null, stations: null, sources: null, boundary: null };

async function init() {
  const t0 = performance.now();
  const [overview, st, alerts, compliance] = await Promise.all([
    api('/overview'), api('/stations'), api('/alerts'), api('/analysis/compliance', { days: 30 }),
  ]);

  // 概况卡片
  $('overview-stats').innerHTML =
    `<div><b>${overview.area_km2}</b>流域面积 km²</div>
     <div><b>${overview.rivers.len_km}</b>河网总长 km</div>
     <div><b>${overview.stations.water_quality}</b>水质监测站</div>
     <div><b>${overview.sources}</b>污染源普查数</div>`;

  // 等级环图（30 天均值评价）
  const nameMap = { 'Ⅱ': 'Ⅱ', 'Ⅲ': 'Ⅲ', 'Ⅳ': 'Ⅳ', 'Ⅴ': 'Ⅴ', '劣Ⅴ': '劣Ⅴ' };
  chartGrade.setOption({ series: [{ data: gradeOption.series[0].data.map((d) => ({
    ...d, value: (compliance.gradeDistribution[nameMap[d.name]] || 0) })) }] });

  // 预警列表
  $('alert-count').textContent = alerts.count || '';
  $('alert-list').innerHTML = alerts.alerts.length ? alerts.alerts.map((a) => `
    <li data-id="${a.id}"><span class="chip" style="background:${a.grade_color}">${a.grade_name}</span>
      <span>${a.name}</span><span class="v">氨氮 ${a.nh3_n?.toFixed(2)} ${a.nh3_trend != null ? (a.nh3_trend >= 0 ? '↑' + a.nh3_trend : '↓' + Math.abs(a.nh3_trend)) + '%' : ''}</span>
    </li>`).join('') : '<li class="safe"><span class="chip" style="background:#38b000">✓</span><span>当前无超标站点</span></li>';

  // 站点列表
  stations = st.stations;
  $('station-list').innerHTML = stations.map((s) => `
    <li data-id="${s.id}" class="${s.grade && s.grade <= 3 ? 'safe' : ''}">
      <span class="chip" style="background:${s.grade_color || '#4a5a6d'};${s.kind === 'hydrology' ? 'filter:grayscale(1)' : ''}">${s.kind === 'hydrology' ? '水文' : s.grade_name}</span>
      <span>${s.name}</span>
      <span class="v">${s.latest ? `DO ${s.latest.do_mgl.toFixed(1)} · NH₃-N ${s.latest.nh3_n.toFixed(2)}` : ''}</span>
    </li>`).join('');
  document.querySelectorAll('#station-list li, #alert-list li[data-id]').forEach((li) =>
    li.addEventListener('click', () => selectStation(+li.dataset.id)));

  await loadGeometries(overview);
  viewer.resize(); // 容器布局完成后强制同步画布尺寸
  setStatus(`加载完成 · ${Math.round(performance.now() - t0)} ms`);
}

async function loadGeometries(overview) {
  // 流域边界
  entities.boundary = await Cesium.GeoJsonDataSource.load(
    { type: 'Feature', geometry: overview.boundary, properties: {} },
    { stroke: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.9), fill: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.05), clampToGround: true });
  viewer.dataSources.add(entities.boundary);
  await drawRivers();
  await drawStations();
  await drawSources();
}

// 河流 GeoJSON 由 /api/basin/rivers 返回，线宽随 Strahler 级数
async function drawRivers() {
  const gj = await (await fetch('/api/basin/rivers')).json();
  entities.rivers = await Cesium.GeoJsonDataSource.load(gj, { clampToGround: true });
  const widthByStrahler = { 1: 1.5, 2: 2.5, 3: 4, 4: 7 };
  const labels = [];
  for (const e of entities.rivers.entities.values) {
    const s = e.properties.strahler?.getValue() || 1;
    e.polyline.width = widthByStrahler[s] || 1.5;
    e.polyline.material = Cesium.Color.fromCssColorString(s >= 3 ? '#3b7dd8' : '#4d94e8').withAlpha(0.9);
  }
  viewer.dataSources.add(entities.rivers);
}

async function drawStations() {
  entities.stations = new Cesium.CustomDataSource('stations');
  for (const s of stations) {
    entities.stations.entities.add({
      position: Cesium.Cartesian3.fromDegrees(s.x, s.y),
      point: {
        pixelSize: s.kind === 'hydrology' ? 8 : 12,
        color: Cesium.Color.fromCssColorString(s.grade_color || '#4a5a6d'),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.8), outlineWidth: 1.5,
        scaleByDistance: new Cesium.NearFarScalar(2e4, 1.0, 2e5, 0.5),
      },
      label: {
        text: s.name.replace('临江·', ''),
        font: '12px "Microsoft YaHei"', fillColor: Cesium.Color.fromCssColorString('#dbe4ee'),
        showBackground: true, backgroundColor: Cesium.Color.fromCssColorString('#131a24').withAlpha(0.75),
        pixelOffset: new Cesium.Cartesian2(0, -20), horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 9e4),
      },
      properties: { stationId: s.id },
    });
  }
  viewer.dataSources.add(entities.stations);
}

let sourceList = [];
async function drawSources() {
  const { sources } = await api('/sources');
  sourceList = sources;
  entities.sources = new Cesium.CustomDataSource('sources');
  for (const src of sources) {
    entities.sources.entities.add({
      position: Cesium.Cartesian3.fromDegrees(src.x, src.y),
      point: {
        pixelSize: Math.max(6, Math.min(16, 4 + src.load_cod / 8)),
        color: Cesium.Color.fromCssColorString(SOURCE_COLORS[src.type]),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2e4, 1.0, 2e5, 0.5),
      },
      properties: { srcName: src.name, srcType: src.type, load: src.load_cod },
    });
  }
  viewer.dataSources.add(entities.sources);
}

// ================= 站点选择与详情 =================
let selectedId = null;
async function selectStation(id) {
  selectedId = id;
  const s = stations.find((x) => x.id === id);
  if (!s) return;
  $('detail').classList.add('open');
  chartSeries.resize(); chartRain.resize(); // 面板从隐藏变可见后同步画布尺寸
  $('detail-title').innerHTML = `${s.name} <span class="chip" style="background:${s.grade_color || '#4a5a6d'}">${s.kind === 'hydrology' ? '水文站' : s.grade_name + '类'}</span>`;
  $('detail-meta').innerHTML =
    `编码 ${s.code} ｜ ${s.river || ''} ｜ 里程 ${s.km ?? '—'} km<br>` +
    (s.latest ? `最新（${new Date(s.latest.ts).toLocaleString('zh-CN')}）：水温 ${s.latest.temp?.toFixed(1)}℃ · pH ${s.latest.ph?.toFixed(2)} · 溶解氧 ${s.latest.do_mgl?.toFixed(2)} · 氨氮 ${s.latest.nh3_n?.toFixed(3)} · 总磷 ${s.latest.tp?.toFixed(3)} · 浊度 ${s.latest.turbidity?.toFixed(0)} NTU` : '暂无观测');
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(s.x, s.y - 0.02, 12000), duration: 1.2 });

  const [series, rain] = await Promise.all([
    api(`/stations/${id}/series`, { days: 30, metrics: 'do_mgl,nh3_n,cod_mn,tp' }),
    api('/rain-response', { station_id: id, days: 14 }),
  ]);

  chartSeries.setOption({
    textStyle: { color: '#dbe4ee' },
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#8fa1b5', fontSize: 11 }, top: 0 },
    grid: { left: 46, right: 16, top: 26, bottom: 24 },
    xAxis: { type: 'time', axisLabel: { color: '#8fa1b5' }, axisLine: { lineStyle: { color: '#3a4b60' } } },
    yAxis: { type: 'value', axisLabel: { color: '#8fa1b5' }, splitLine: { lineStyle: { color: '#1f2b3a' } } },
    series: Object.entries(METRICS).map(([k, m]) => ({
      name: m.name, type: 'line', showSymbol: false, smooth: true, lineWidth: 1.5,
      itemStyle: { color: m.color }, lineStyle: { color: m.color, width: 1.5 },
      data: series.t.map((t, i) => [t, series.series[k][i]]),
    })),
  }, true);

  chartRain.setOption({
    textStyle: { color: '#dbe4ee' },
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#8fa1b5', fontSize: 11 }, top: 0 },
    grid: { left: 40, right: 46, top: 26, bottom: 24 },
    xAxis: { type: 'time', axisLabel: { color: '#8fa1b5' }, axisLine: { lineStyle: { color: '#3a4b60' } } },
    yAxis: [
      { type: 'value', name: 'mm', nameTextStyle: { color: '#8fa1b5' }, axisLabel: { color: '#8fa1b5' }, splitLine: { lineStyle: { color: '#1f2b3a' } } },
      { type: 'value', name: 'mg/L·NTU', nameTextStyle: { color: '#8fa1b5' }, axisLabel: { color: '#8fa1b5' }, splitLine: { show: false } },
    ],
    series: [
      { name: '降雨', type: 'bar', barMaxWidth: 4, itemStyle: { color: '#4d94e8', opacity: .8 }, data: rain.t.map((t, i) => [t, rain.rainfall[i]]) },
      { name: '浊度', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { color: '#95a5a6', width: 1.2 }, itemStyle: { color: '#95a5a6' }, data: rain.t.map((t, i) => [t, rain.turbidity[i]]) },
      { name: '氨氮', type: 'line', yAxisIndex: 1, showSymbol: false, lineStyle: { color: '#f39c12', width: 1.5 }, itemStyle: { color: '#f39c12' }, data: rain.t.map((t, i) => [t, rain.nh3_n[i]]) },
    ],
  }, true);
}
$('detail-close').addEventListener('click', () => { $('detail').classList.remove('open'); selectedId = null; });

// ================= 拾取 =================
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);
  if (!Cesium.defined(picked) || !picked.id) return;
  const props = picked.id.properties;
  if (props?.stationId) selectStation(props.stationId.getValue());
  else if (props?.srcName) {
    const type = props.srcType.getValue();
    setStatus(`${props.srcName.getValue()} ｜ ${SOURCE_NAMES[type]}源 ｜ COD负荷 ${props.load.getValue()} kg/月`);
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ================= 工具条 =================
$('cb-sources').addEventListener('change', (e) => { entities.sources.show = e.target.checked; });
$('cb-riverlabels').addEventListener('change', (e) => { if (entities.rivers) entities.rivers.show = e.target.checked; });
$('cb-boundary').addEventListener('change', (e) => { if (entities.boundary) entities.boundary.show = e.target.checked; });
window.addEventListener('resize', () => { chartGrade.resize(); chartSeries.resize(); chartRain.resize(); });

init().catch((e) => setStatus('初始化失败：' + e.message));
