import app from './app.js';
import { cfg } from './config.js';

app.listen(cfg.port, () => {
  console.log(`[webgis-server] http://localhost:${cfg.port}/poi   （POI 空间分析，Leaflet）`);
  console.log(`[webgis-server] http://localhost:${cfg.port}/basin （流域生态监测，Cesium）`);
});
