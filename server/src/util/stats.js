/**
 * 空间统计：全局 Moran's I（六边形密度格网上的空间自相关）
 * 权重：邻接二元权重（质心间距 <= 1.75 × 格网边长视为相邻）
 * 显著性：Cliff-Ord 随机化假设下的近似方差
 */
const CN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '劣Ⅴ'];

export function moransI(cells, size) {
  const n = cells.length;
  if (n < 8) return null;
  const mean = cells.reduce((s, c) => s + c.v, 0) / n;
  const z = cells.map((c) => c.v - mean);
  const ss = z.reduce((s, v) => s + v * v, 0);
  if (ss === 0) return null;

  // 空间哈希加速邻接对查找
  const thr = size * 1.75;
  const cs = thr;
  const grid = new Map();
  cells.forEach((c, i) => {
    const k = `${Math.floor(c.x / cs)},${Math.floor(c.y / cs)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  let S0 = 0, S1 = 0, S2n = 0, cross = 0, pairs = 0;
  const deg = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(cells[i].x / cs), gy = Math.floor(cells[i].y / cs);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${gx + dx},${gy + dy}`);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const d = Math.hypot(cells[i].x - cells[j].x, cells[i].y - cells[j].y);
        if (d > thr || d === 0) continue;
        pairs++;
        S0 += 2; S1 += 4;                    // 对称二元权重
        deg[i] += 1; deg[j] += 1;
        cross += 2 * z[i] * z[j];
      }
    }
  }
  S2n = deg.reduce((s, d) => s + (2 * d) ** 2, 0);
  if (S0 === 0) return null;

  const I = (n / S0) * (cross / ss);
  const EI = -1 / (n - 1);
  const b2 = z.reduce((s, v) => s + v ** 4, 0) / (ss * ss);
  const varI =
    (n * ((n * n - 3 * n + 3) * S1 - n * S2n + 3 * S0 * S0) -
     b2 * n * ((n * n - n) * S1 - 2 * n * S0 + 3 * S0 * S0)) /
    ((n - 1) * (n - 2) * (n - 3) * S0 * S0) - EI * EI;
  const zScore = (I - EI) / Math.sqrt(Math.max(varI, 1e-12));
  return {
    I: +I.toFixed(4),
    expected: +EI.toFixed(4),
    z: +zScore.toFixed(3),
    pairs,
    n,
    significant: Math.abs(zScore) > 1.96,
    label:
      zScore > 1.96 ? '显著空间聚集（高-高/低-低聚类）'
      : zScore < -1.96 ? '显著空间离散（棋盘格局）'
      : '无显著空间自相关（随机分布）',
  };
}

/** GB 3838-2002 地表水环境质量标准分级（单因子） */
export const GB3838 = {
  do_mgl: { higherBetter: true, bands: [7.5, 6, 5, 3, 2] },
  cod_mn: { higherBetter: false, bands: [2, 4, 6, 10, 15] },
  nh3_n: { higherBetter: false, bands: [0.15, 0.5, 1.0, 1.5, 2.0] },
  tp: { higherBetter: false, bands: [0.02, 0.1, 0.2, 0.3, 0.4] },
};

export function gradeMetric(metric, v) {
  if (v == null || Number.isNaN(v)) return null;
  if (metric === 'ph') return v >= 6 && v <= 9 ? 1 : 5;
  const g = GB3838[metric];
  if (!g) return null;
  const b = g.bands;
  for (let i = 0; i < b.length; i++) {
    // do_mgl 阈值按 Ⅰ→Ⅴ 递减（值越大越好），其余按 Ⅰ→Ⅴ 递增
    if (g.higherBetter ? v >= b[i] : v <= b[i]) return i + 1;
  }
  return 6; // 劣Ⅴ
}

export const gradeName = (g) => (g == null ? '—' : CN[g - 1]);
export const GRADE_COLORS = { 1: '#1890ff', 2: '#38b000', 3: '#f1c40f', 4: '#e67e22', 5: '#e74c3c', 6: '#8e44ad' };
