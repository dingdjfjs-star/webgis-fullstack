import './env.js';

export const cfg = {
  port: +(process.env.PORT || 3000),
  pg: {
    host: process.env.PGHOST || '127.0.0.1',
    port: +(process.env.PGPORT || 5433),
    user: process.env.PGUSER || 'webgis',
    password: process.env.PGPASSWORD || 'webgis123',
    database: process.env.PGDATABASE || 'webgis',
    max: 10,
    idleTimeoutMillis: 30000,
  },
};
