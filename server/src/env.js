import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .env 固定在仓库根目录（本文件位于 server/src 或 server/scripts 下，向上两级）
const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
dotenv.config({ path: p });
