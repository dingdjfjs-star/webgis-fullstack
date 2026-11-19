# WebGIS 全流程系统：临江市 POI 空间分布分析 + 临江流域生态环境监测

一套完整落地的 WebGIS 全栈系统，覆盖 **空间数据库 → 后端服务 → 二/三维前端** 全流程：

```
┌─────────────────────────────────────────────────────────────────────┐
│  前端                                                               │
│   /poi   Leaflet 1.9   聚合/热力/六边形密度 + ECharts 联动           │
│   /basin Cesium 1.126  三维河网 + 站点时序 + 降雨-水质响应           │
├─────────────────────────────────────────────────────────────────────┤
│  后端  Node.js 24 + Express                                         │
│   REST API（空间查询/统计分析/时序）+ ST_AsMVT 矢量瓦片              │
├─────────────────────────────────────────────────────────────────────┤
│  数据库  PostgreSQL 16 + PostGIS 3.6.2                              │
│   schema poi    ：25 万 POI / 6 行政区（GiST + BTREE 索引）          │
│   schema basin  ：河网/12 站/25 污染源/8.76 万行逐小时水质时序        │
└─────────────────────────────────────────────────────────────────────┘
```

> 城市与数据均为**模拟生成**（固定随机种子，可复现），空间规律按真实城市建模：
> CBD 高斯聚集 + 沿主干道分布 + 乡村均匀；水质时序含降雨驱动的非点源冲刷响应。

## 快速开始

### 路线 A：Docker（克隆即跑，推荐）

```bash
git clone https://github.com/dingdjfjs-star/webgis-fullstack.git
cd webgis-fullstack/docker
docker compose up -d db server          # 等健康检查通过（约 20 秒）
docker compose exec server node scripts/seed.js   # 灌种子数据，约 30 秒
```

打开浏览器：
- **POI 空间分布分析系统**：http://localhost:3000/poi
- **流域生态环境监测平台**：http://localhost:3000/basin
- 接口健康检查：http://localhost:3000/api/health

### 路线 B：本机 PostgreSQL 16 + PostGIS

```bash
# 1) 准备一个 PG16+PostGIS 空库，写入连接配置（server 目录下 .env）
#    PORT=3000  PGHOST=localhost  PGPORT=5433  PGUSER=webgis
#    PGPASSWORD=...  PGDATABASE=webgis
# 2) 初始化库结构（幂等，可重复执行）：psql -f db/01_init.sql
cd server
npm install --omit=dev        # 运行时依赖仅 express/pg/dotenv/pg-copy-streams
npm run seed                  # 种子数据约 30 秒，固定种子 20260829 可复现
npm start                     # 默认 3000 端口
```

> 前端库（Cesium/ECharts/Leaflet）已**本地化**在 `server/public/vendor`，克隆后演示不依赖外网 CDN（底图瓦片除外）；升级库版本后运行 `npm run vendor` 重新拷贝。
> 接口集成测试：`npm test`（16 个接口）；索引性能基准：`npm run bench`。

## 功能清单

### ① 城市 POI 空间分布分析系统（Leaflet）
| 功能 | 实现 |
|---|---|
| 三种分析模式切换 | 点位聚合（markercluster）/ 热力图（聚合格网）/ 六边形密度（`ST_HexagonGrid`） |
| 类别筛选 + 视野联动 | 全部统计随 bbox 与类别实时刷新（防抖 350ms） |
| 分类/分区统计图表 | ECharts 饼图 + 条形图，数据与地图视野联动 |
| 最近设施检索 | KNN `<->` 算子 + GiST 索引，关键词命中名称/子类/大类 |
| 缓冲区分析 | 地图点击圈选，`ST_DWithin` 球面距离，输出类别构成/均分/均价 |
| 空间自相关检验 | 全局 **Moran's I**（Cliff-Ord 随机化方差，z 检验） |
| 海量点渲染 | `ST_AsMVT` 矢量瓦片接口，为 MapLibre/Mapbox 客户端预留 |

### ② 流域生态环境监测平台（Cesium）
| 功能 | 实现 |
|---|---|
| 三维流域场景 | 流域边界 + 河网（线宽随 Strahler 级数）+ 监测站/污染源标注 |
| 水质分级 | **GB 3838-2002** 单因子评价：溶解氧/氨氮/高锰酸盐指数/总磷/pH → Ⅰ~劣Ⅴ |
| 站点详情 | 点击定位飞行 + 30 天四指标时序（`date_bin` 自动降采样） |
| 降雨-水质响应 | 逐小时降雨柱状 + 浊度/氨氮双轴曲线（非点源冲刷效应可视化） |
| 超标预警 | 劣于 Ⅲ 类的站点 + 近 7 天 vs 前 7 天氨氮/溶解氧趋势 |
| 河流缓冲区排查 | 河流 N 米范围内污染源清单与 COD 负荷统计 |
| 多图层矢量瓦片 | `/tiles/basin/...` 河流/站点/污染源一次请求拼接 |

## API 一览

```
GET /api/health                          PostGIS 版本/健康
GET /api/pois                            视野 POI（bbox/categories/kw/limit）
GET /api/pois/summary                    分类 + 分区统计
GET /api/pois/heatmap                    热力图聚合点 [lat,lng,count]
GET /api/pois/hexgrid?size=              六边形密度格网（GeoJSON）
GET /api/pois/moran?size=                全局 Moran's I + z 检验
GET /api/pois/nearest?lat&lng&k&kw       KNN 最近邻
GET /api/pois/buffer?lat&lng&r           缓冲区统计
GET /tiles/pois/{z}/{x}/{y}.pbf          POI 矢量瓦片
GET /api/basin/overview                  流域概况 + 最新等级分布
GET /api/basin/stations                  站点 + 最新读数 + 分级
GET /api/basin/stations/:id/series       站点时序（时/日/周自动聚合）
GET /api/basin/rain-response             降雨-水质响应序列
GET /api/basin/analysis/compliance       GB3838 达标评价（N 天均值）
GET /api/basin/analysis/river-buffer     河流缓冲区污染源排查
GET /api/basin/alerts                    超标预警 + 趋势
GET /api/basin/rivers                    河网 GeoJSON
GET /api/basin/sources                   污染源清单
GET /tiles/basin/{z}/{x}/{y}.pbf         流域多图层矢量瓦片
```

## 空间索引性能基准

`npm run bench`（结果落盘 [docs/perf.md](docs/perf.md)；Windows 便携版，每组 5 次取中位数）：

| 空间查询 | 有索引 | 禁用索引 | 加速比 |
|---|---|---|---|
| KNN 最近邻（`<->`，k=10） | 1.3 ms | 132.9 ms | **100×** |
| 六边形密度聚合（0.01° 格网） | 444.9 ms | 28950.8 ms | **65×** |
| 水质时序单站查询（复合索引） | 0.5 ms | 6.9 ms | 15× |
| 球面缓冲区（geography 表达式索引） | 100.3 ms | 243.1 ms | 2.4× |
| 视野框选计数（CBD 密集区，8 万行计数） | 155 ms | 131 ms | ≈1×（耗时在行计数而非检索） |

> 工程要点：`ST_DWithin(geom::geography,...)` 在列上做转换会**绕过 geometry 索引**，
> 需要额外建 `(geom::geography)` 表达式索引（已包含在 [db/01_init.sql](db/01_init.sql)）。

## 项目结构

```
├─ db/01_init.sql              建库 SQL（两 schema、全部索引、幂等）
├─ server/
│  ├─ src/routes/pois.js       POI 空间分析 API
│  ├─ src/routes/basin.js      流域监测 API（GB3838 分级/预警/缓冲区）
│  ├─ src/routes/tiles.js      ST_AsMVT 矢量瓦片
│  ├─ src/util/stats.js        Moran's I + GB3838 分级函数
│  ├─ scripts/seed.js          种子数据生成器（固定种子可复现）
│  ├─ public/poi/              Leaflet 前端
│  ├─ public/basin/            Cesium 前端
│  ├─ test/api.test.js         16 个接口集成测试（npm test）
│  └─ test/bench.js            索引性能基准（npm run bench）
└─ docker/docker-compose.yml   容器化部署（db + server 一键起）
```

## 数据说明

- 所有数据由 [server/scripts/seed.js](server/scripts/seed.js) 确定性生成（种子 20260829）：
  - **POI 25 万**：45% CBD 三中心高斯(σ=0.008°) + 35% 区中心高斯(σ=0.02°) + 15% 沿 40 条主干道 + 5% 均匀
  - **行政区**：六边形网格对 6 个中心做类 Voronoi 分配后 `ST_Union` 成面
  - **水质时序 87,600 行**：季节/昼夜周期 + 站点退化梯度（上游 Ⅱ 类 → 下游 Ⅴ 类）+ 降雨事件驱动的浊度/氨氮冲刷峰
- 底图：Esri World Dark Gray / OSM / Esri 影像（免费无 Key）；Cesium 本地化在 `server/public/vendor`，演示不依赖外网 CDN（底图瓦片除外）。
