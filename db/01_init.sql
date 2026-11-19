-- ============================================================
-- WebGIS 全流程系统 · 数据库初始化（幂等，可重复执行）
-- 数据库: webgis  |  扩展: PostGIS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS postgis;

-- ------------------------------------------------------------
-- Schema 1: poi  —— 城市 POI 空间分布分析系统
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS poi;

-- 行政区（面）
CREATE TABLE IF NOT EXISTS poi.districts (
  id    serial PRIMARY KEY,
  name  text NOT NULL UNIQUE,
  geom  geometry(MultiPolygon, 4326) NOT NULL
);

-- POI（点）
CREATE TABLE IF NOT EXISTS poi.pois (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,           -- 大类: 餐饮/购物/医疗/教育/...
  subcategory text,                    -- 子类: 火锅/便利店/综合医院/...
  rating      numeric(2,1),            -- 评分 1.0-5.0
  price       integer,                 -- 人均消费(元)
  district_id integer REFERENCES poi.districts(id),
  geom        geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS pois_geom_gist     ON poi.pois USING gist (geom);
-- 缓冲区分析走 ST_DWithin(geom::geography, ...)，需要 geography 表达式索引才能命中
CREATE INDEX IF NOT EXISTS pois_geom_geog_gist ON poi.pois USING gist ((geom::geography));
CREATE INDEX IF NOT EXISTS pois_category_idx  ON poi.pois (category);
CREATE INDEX IF NOT EXISTS pois_district_idx  ON poi.pois (district_id);
CREATE INDEX IF NOT EXISTS pois_name_idx      ON poi.pois (name text_pattern_ops);
CREATE INDEX IF NOT EXISTS districts_geom_gist ON poi.districts USING gist (geom);

-- ------------------------------------------------------------
-- Schema 2: basin —— 流域生态环境监测平台
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS basin;

-- 流域边界（面）
CREATE TABLE IF NOT EXISTS basin.boundary (
  id   serial PRIMARY KEY,
  name text NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

-- 河流（线，strahler 为河源分级：数字越大越接近干流）
CREATE TABLE IF NOT EXISTS basin.rivers (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  strahler integer NOT NULL DEFAULT 1,
  geom     geometry(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS rivers_geom_gist ON basin.rivers USING gist (geom);

-- 监测站（点）
CREATE TABLE IF NOT EXISTS basin.stations (
  id       serial PRIMARY KEY,
  code     text NOT NULL UNIQUE,       -- 站点编码 WQ001 / HD001
  name     text NOT NULL,
  kind     text NOT NULL DEFAULT 'water_quality'
           CHECK (kind IN ('water_quality', 'hydrology')),
  river_id integer REFERENCES basin.rivers(id),
  km       numeric(6,1),               -- 距河口里程
  geom     geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS stations_geom_gist ON basin.stations USING gist (geom);

-- 污染源（点）
CREATE TABLE IF NOT EXISTS basin.sources (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  type     text NOT NULL CHECK (type IN ('industrial', 'domestic', 'agricultural')),
  load_cod numeric(8,2),               -- COD 负荷 kg/月
  geom     geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_geom_gist ON basin.sources USING gist (geom);

-- 水质 / 水文逐小时监测时序
CREATE TABLE IF NOT EXISTS basin.readings (
  id        bigserial PRIMARY KEY,
  station_id integer NOT NULL REFERENCES basin.stations(id),
  ts        timestamptz NOT NULL,
  temp      real,                      -- 水温 ℃
  ph        real,
  do_mgl    real,                      -- 溶解氧 mg/L
  cod_mn    real,                      -- 高锰酸盐指数 mg/L
  nh3_n     real,                      -- 氨氮 mg/L
  tp        real,                      -- 总磷 mg/L
  turbidity real,                      -- 浊度 NTU
  rainfall  real                       -- 降水量 mm/h
);
-- 时序查询主要按 (station, 时间倒序) 走
CREATE INDEX IF NOT EXISTS readings_station_ts_idx ON basin.readings (station_id, ts DESC);
CREATE INDEX IF NOT EXISTS readings_ts_brin        ON basin.readings USING brin (ts);
