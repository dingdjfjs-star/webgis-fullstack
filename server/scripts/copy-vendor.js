/**
 * 把 node_modules 里的前端库拷到 public/vendor，全部本地化 ——
 * 演示时不依赖任何外网 CDN（Leaflet / MarkerCluster / heatmap / ECharts / Cesium）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = path.join(root, 'server', 'node_modules');
const OUT = path.join(root, 'server', 'public', 'vendor');

const jobs = [
  ['leaflet/dist', 'leaflet'],
  ['leaflet.markercluster/dist', 'leaflet.markercluster'],
  ['leaflet.heat/dist', 'leaflet.heat'],
  ['echarts/dist', 'echarts'],
  ['cesium/Build/Cesium', 'cesium'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [src, dest] of jobs) {
  const s = path.join(NM, src);
  const d = path.join(OUT, dest);
  if (!fs.existsSync(s)) { console.error(`[vendor] 缺少 ${src}，先在 server/ 下 npm install`); process.exit(1); }
  fs.rmSync(d, { recursive: true, force: true });
  fs.cpSync(s, d, { recursive: true });
  console.log(`[vendor] ${dest} ✓`);
}
console.log('[vendor] 全部就绪 →', OUT);
