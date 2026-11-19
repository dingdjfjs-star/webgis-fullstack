import pg from 'pg';
import { cfg } from './config.js';

export const pool = new pg.Pool(cfg.pg);

export const query = (text, params) => pool.query(text, params);
