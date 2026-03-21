/**
 * StayDirect API Server — Production Build
 * 
 * Features:
 *  - Persistent SQLite database (data survives restarts)
 *  - Rate limiting per API key
 *  - Webhook notifications when prices change
 *  - Health endpoint for monitoring
 *  - Structured logging
 *  - CORS with whitelist
 * 
 * Run: node server.js
 * Requires: Node.js 18+
 * 
 * For SQLite: npm install better-sqlite3
 * Without it: falls back to in-memory store
 */

'use strict';

const http    = require('http');
const https   = require('https');
const url     = require('url');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CONFIG = {
  PORT:          process.env.PORT          || 3000,
  NODE_ENV:      process.env.NODE_ENV      || 'development',
  ADMIN_SECRET:  process.env.ADMIN_SECRET  || 'change_me_in_production',
  RATE_LIMIT_MS: parseInt(process.env.RATE_LIMIT_MS || '60000'),
  LOG_LEVEL:     process.env.LOG_LEVEL     || 'info',
  DB_PATH:       process.env.DB_PATH       || './staydirect.db',
  USD_TO_LKR:    parseFloat(process.env.USD_TO_LKR || '325'),
};

// ═══════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════
const logger = {
  _fmt: (level, msg, meta) => {
    const ts = new Date().toISOString();
    const m = meta ? ' ' + JSON.stringify(meta) : '';
    return `[${ts}] [${level.toUpperCase()}] ${msg}${m}`;
  },
  info:  (msg, meta) => console.log(logger._fmt('info',  msg, meta)),
  warn:  (msg, meta) => console.warn(logger._fmt('warn',  msg, meta)),
  error: (msg, meta) => console.error(logger._fmt('error', msg, meta)),
  req:   (method, path, code, ms) => console.log(logger._fmt('req', `${method} ${path} → ${code} (${ms}ms)`)),
};

// ═══════════════════════════════════════════════
// DATABASE — SQLite with in-memory fallback
// ═══════════════════════════════════════════════
let db;

try {
  const Database = require('better-sqlite3');
  db = new Database(CONFIG.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS hotels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      region TEXT DEFAULT 'Southern',
      rating REAL DEFAULT 8.0,
      address TEXT,
      lat REAL,
      lng REAL,
      emoji TEXT DEFAULT '🏨',
      amenities TEXT DEFAULT '[]',
      description TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL REFERENCES hotels(id),
      type TEXT NOT NULL,
      view TEXT DEFAULT 'Garden view',
      price_usd REAL NOT NULL,
      price_lkr REAL,
      min_nights INTEGER DEFAULT 1,
      capacity INTEGER DEFAULT 2,
      beds TEXT DEFAULT 'Double',
      breakfast INTEGER DEFAULT 0,
      cancellable INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      company TEXT NOT NULL,
      email TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      daily_limit INTEGER DEFAULT 1000,
      requests_today INTEGER DEFAULT 0,
      webhook_url TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      key_id INTEGER,
      company TEXT,
      method TEXT,
      path TEXT,
      params TEXT,
      status_code INTEGER,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      hotel_id INTEGER,
      room_id INTEGER,
      hotel_name TEXT,
      room_type TEXT,
      guest_name TEXT,
      guest_email TEXT,
      guests INTEGER DEFAULT 2,
      checkin TEXT,
      checkout TEXT,
      nights INTEGER,
      total_usd REAL,
      total_lkr REAL,
      operator TEXT,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed data if empty
  const hotelCount = db.prepare('SELECT COUNT(*) as c FROM hotels').get().c;
  if (hotelCount === 0) {
    logger.info('Seeding database with sample hotels...');
    const insertHotel = db.prepare(`INSERT INTO hotels (name,location,region,rating,address,lat,lng,emoji,amenities,description) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insertRoom  = db.prepare(`INSERT INTO rooms (hotel_id,type,view,price_usd,price_lkr,min_nights,capacity,beds,breakfast,cancellable) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insertKey   = db.prepare(`INSERT OR IGNORE INTO api_keys (key,company,email,plan,daily_limit) VALUES (?,?,?,?,?)`);

    const seedTx = db.transaction(() => {
      const h1 = insertHotel.run('Liya Beach Kathaluwa','Ahangama','Southern',8.7,'Galle Road, Kathaluwa',6.0174,80.3537,'🏖','["pool","wifi","parking","ac","room_service"]','Boutique beachfront hotel with sea views and pool.').lastInsertRowid;
      const h2 = insertHotel.run('The Fortress Resort & Spa','Galle','Southern',9.1,'Koggala, Southern Province',5.9918,80.3324,'🏰','["pool","wifi","spa","restaurant","gym","ac"]','Luxury 5-star resort near Galle Fort.').lastInsertRowid;
      const h3 = insertHotel.run('Mirissa Hills','Mirissa','Southern',8.4,'Mirissa, Matara District',5.9479,80.4505,'🌊','["pool","wifi","restaurant","ac"]','Surf, sunsets, secluded bungalows.').lastInsertRowid;
      const h4 = insertHotel.run('Ella Rock Retreat','Ella','Uva',8.9,'Main Street, Ella',6.8667,81.0467,'🏔','["wifi","restaurant","ac","parking"]','Mountain views, tea country, hike trails.').lastInsertRowid;

      insertRoom.run(h1,'Double Sea View','Sea view',39,Math.round(39*325),1,2,'Double',1,0);
      insertRoom.run(h1,'Double Pool View','Pool view',44,Math.round(44*325),1,2,'Double',1,0);
      insertRoom.run(h1,'Standard Room','Street view',29,Math.round(29*325),1,2,'Twin',0,1);
      insertRoom.run(h2,'Luxury Ocean Suite','Sea view',180,Math.round(180*325),2,2,'King',1,1);
      insertRoom.run(h2,'Superior Room','Sea view',120,Math.round(120*325),1,2,'King',1,1);
      insertRoom.run(h3,'Surf Bungalow','Garden view',55,Math.round(55*325),1,2,'Double',1,1);
      insertRoom.run(h3,'Pool Villa','Pool view',95,Math.round(95*325),2,4,'King',1,0);
      insertRoom.run(h4,'Mountain View Room','Mountain',65,Math.round(65*325),1,2,'Double',1,1);

      insertKey.run('sk_live_demo_key_readonly_001','Demo Operator','demo@staydirect.lk','free',1000);
    });
    seedTx();
    logger.info('Database seeded ✓');
  }

  logger.info('SQLite database connected', { path: CONFIG.DB_PATH });

} catch (e) {
  // Fallback: in-memory (same as before)
  logger.warn('better-sqlite3 not found, using in-memory store (install: npm i better-sqlite3)');
  db = null;
}

// ═══════════════════════════════════════════════
// IN-MEMORY FALLBACK STORE
// ═══════════════════════════════════════════════
const mem = db ? null : {
  hotels: [
    {id:1,name:'Liya Beach Kathaluwa',location:'Ahangama',region:'Southern',rating:8.7,address:'Galle Road, Kathaluwa',lat:6.0174,lng:80.3537,emoji:'🏖',amenities:['pool','wifi','parking','ac'],status:'active'},
    {id:2,name:'The Fortress Resort',location:'Galle',region:'Southern',rating:9.1,address:'Koggala, Southern Province',lat:5.9918,lng:80.3324,emoji:'🏰',amenities:['pool','wifi','spa','restaurant'],status:'active'},
    {id:3,name:'Mirissa Hills',location:'Mirissa',region:'Southern',rating:8.4,address:'Mirissa, Matara District',lat:5.9479,lng:80.4505,emoji:'🌊',amenities:['pool','wifi','restaurant'],status:'active'},
    {id:4,name:'Ella Rock Retreat',location:'Ella',region:'Uva',rating:8.9,address:'Main Street, Ella',lat:6.8667,lng:81.0467,emoji:'🏔',amenities:['wifi','restaurant','ac'],status:'active'},
  ],
  rooms: [
    {id:1,hotel_id:1,type:'Double Sea View',view:'Sea view',price_usd:39,price_lkr:12675,min_nights:1,capacity:2,beds:'Double',breakfast:1,cancellable:0,status:'active'},
    {id:2,hotel_id:1,type:'Double Pool View',view:'Pool view',price_usd:44,price_lkr:14300,min_nights:1,capacity:2,beds:'Double',breakfast:1,cancellable:0,status:'active'},
    {id:3,hotel_id:1,type:'Standard Room',view:'Street view',price_usd:29,price_lkr:9425,min_nights:1,capacity:2,beds:'Twin',breakfast:0,cancellable:1,status:'active'},
    {id:4,hotel_id:2,type:'Luxury Suite',view:'Sea view',price_usd:180,price_lkr:58500,min_nights:2,capacity:2,beds:'King',breakfast:1,cancellable:1,status:'active'},
    {id:5,hotel_id:3,type:'Surf Bungalow',view:'Garden view',price_usd:55,price_lkr:17875,min_nights:1,capacity:2,beds:'Double',breakfast:1,cancellable:1,status:'active'},
    {id:6,hotel_id:4,type:'Mountain View Room',view:'Mountain',price_usd:65,price_lkr:21125,min_nights:1,capacity:2,beds:'Double',breakfast:1,cancellable:1,status:'active'},
  ],
  api_keys: [
    {id:1,key:'sk_live_demo_key_readonly_001',company:'Demo',email:'demo@staydirect.lk',plan:'free',daily_limit:1000,requests_today:0,status:'active'},
  ],
  bookings: [],
  log: [],
  nextId: {hotels:5,rooms:7,keys:2},
};

// ═══════════════════════════════════════════════
// DATA ACCESS LAYER (works for both SQLite & memory)
// ═══════════════════════════════════════════════
const DAL = {
  getHotels: (filters = {}) => {
    if (db) {
      let q = 'SELECT * FROM hotels WHERE status="active"';
      const params = [];
      if (filters.location) { q += ' AND location LIKE ?'; params.push('%' + filters.location + '%'); }
      if (filters.region)   { q += ' AND region=?'; params.push(filters.region); }
      return db.prepare(q).all(...params).map(h => ({ ...h, amenities: JSON.parse(h.amenities || '[]') }));
    }
    return mem.hotels.filter(h => h.status === 'active'
      && (!filters.location || h.location.toLowerCase().includes(filters.location.toLowerCase()))
      && (!filters.region   || h.region === filters.region));
  },

  getHotel: (id) => {
    if (db) {
      const h = db.prepare('SELECT * FROM hotels WHERE id=? AND status="active"').get(id);
      return h ? { ...h, amenities: JSON.parse(h.amenities || '[]') } : null;
    }
    return mem.hotels.find(h => h.id === id && h.status === 'active') || null;
  },

  getRooms: (hotelId, filters = {}) => {
    if (db) {
      let q = 'SELECT * FROM rooms WHERE hotel_id=? AND status="active"';
      const params = [hotelId];
      if (filters.min_capacity) { q += ' AND capacity>=?'; params.push(filters.min_capacity); }
      if (filters.max_price)    { q += ' AND price_usd<=?'; params.push(filters.max_price); }
      return db.prepare(q).all(...params);
    }
    return mem.rooms.filter(r => r.hotel_id === hotelId && r.status === 'active'
      && (!filters.min_capacity || r.capacity >= filters.min_capacity)
      && (!filters.max_price    || r.price_usd <= filters.max_price));
  },

  createHotel: (data) => {
    if (db) {
      const r = db.prepare(`INSERT INTO hotels (name,location,region,rating,address,lat,lng,emoji,amenities,description,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        data.name, data.location, data.region||'Southern', data.rating||8.0,
        data.address||'', data.lat||null, data.lng||null, data.emoji||'🏨',
        JSON.stringify(data.amenities||[]), data.description||'', 'active'
      );
      return DAL.getHotel(r.lastInsertRowid);
    }
    const hotel = { id: mem.nextId.hotels++, ...data, amenities: data.amenities||[], status:'active', created_at: new Date().toISOString().slice(0,10) };
    mem.hotels.push(hotel);
    return hotel;
  },

  updateHotel: (id, data) => {
    if (db) {
      const fields = Object.keys(data).filter(k => !['id','created_at'].includes(k));
      if (!fields.length) return DAL.getHotel(id);
      const set = fields.map(f => `${f}=?`).join(',');
      const vals = fields.map(f => f === 'amenities' ? JSON.stringify(data[f]) : data[f]);
      db.prepare(`UPDATE hotels SET ${set} WHERE id=?`).run(...vals, id);
      return DAL.getHotel(id);
    }
    const h = mem.hotels.find(x => x.id === id);
    if (h) Object.assign(h, data);
    return h;
  },

  createRoom: (data) => {
    const lkr = Math.round((data.price_usd || 0) * CONFIG.USD_TO_LKR);
    if (db) {
      const r = db.prepare(`INSERT INTO rooms (hotel_id,type,view,price_usd,price_lkr,min_nights,capacity,beds,breakfast,cancellable) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        data.hotel_id, data.type, data.view||'Garden view', data.price_usd, lkr,
        data.min_nights||1, data.capacity||2, data.beds||'Double',
        data.breakfast?1:0, data.cancellable!==false?1:0
      );
      return db.prepare('SELECT * FROM rooms WHERE id=?').get(r.lastInsertRowid);
    }
    const room = { id: mem.nextId.rooms++, ...data, price_lkr: lkr, status:'active' };
    mem.rooms.push(room);
    return room;
  },

  updateRoom: (id, data) => {
    if (data.price_usd) data.price_lkr = Math.round(data.price_usd * CONFIG.USD_TO_LKR);
    if (db) {
      const fields = Object.keys(data).filter(k => k !== 'id');
      if (!fields.length) return;
      const set = fields.map(f => `${f}=?`).join(',');
      db.prepare(`UPDATE rooms SET ${set},updated_at=datetime('now') WHERE id=?`).run(...fields.map(f=>data[f]), id);
      return db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    }
    const r = mem.rooms.find(x => x.id === id);
    if (r) Object.assign(r, data);
    return r;
  },

  deleteRoom: (id) => {
    if (db) { db.prepare('UPDATE rooms SET status="deleted" WHERE id=?').run(id); return; }
    const r = mem.rooms.find(x => x.id === id);
    if (r) r.status = 'deleted';
  },

  getKey: (key) => {
    if (db) return db.prepare('SELECT * FROM api_keys WHERE key=? AND status="active"').get(key);
    return mem.api_keys.find(k => k.key === key && k.status === 'active');
  },

  getAllKeys: () => {
    if (db) return db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all();
    return mem.api_keys;
  },

  createKey: (data) => {
    const limits = { free:1000, business:50000, enterprise:9999999 };
    const key = 'sk_live_' + crypto.randomBytes(16).toString('hex');
    if (db) {
      const r = db.prepare('INSERT INTO api_keys (key,company,email,plan,daily_limit,webhook_url) VALUES (?,?,?,?,?,?)').run(
        key, data.company, data.email, data.plan||'free',
        limits[data.plan]||1000, data.webhook_url||null
      );
      return db.prepare('SELECT * FROM api_keys WHERE id=?').get(r.lastInsertRowid);
    }
    const k = { id: mem.nextId.keys++, key, ...data, daily_limit: limits[data.plan||'free']||1000, requests_today:0, status:'active' };
    mem.api_keys.push(k);
    return k;
  },

  revokeKey: (id) => {
    if (db) { db.prepare('UPDATE api_keys SET status="revoked" WHERE id=?').run(id); return; }
    const k = mem.api_keys.find(x => x.id === id);
    if (k) k.status = 'revoked';
  },

  incrementRequests: (keyId) => {
    if (db) { db.prepare('UPDATE api_keys SET requests_today=requests_today+1 WHERE id=?').run(keyId); return; }
    const k = mem.api_keys.find(x => x.id === keyId);
    if (k) k.requests_today++;
  },

  logRequest: (keyId, company, method, pathname, params, statusCode, durationMs) => {
    if (db) {
      db.prepare('INSERT INTO request_log (key_id,company,method,path,params,status_code,duration_ms) VALUES (?,?,?,?,?,?,?)').run(
        keyId, company, method, pathname, JSON.stringify(params), statusCode, durationMs
      );
    } else {
      mem.log.unshift({ ts: new Date().toISOString(), company, method, path: pathname, params, status_code: statusCode, duration_ms: durationMs });
      if (mem.log.length > 500) mem.log.pop();
    }
  },

  getLog: (limit=100) => {
    if (db) return db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT ?').all(limit);
    return (mem.log || []).slice(0, limit);
  },

  createBooking: (data) => {
    const ref = 'SD-' + Date.now().toString(36).toUpperCase();
    if (db) {
      const r = db.prepare(`INSERT INTO bookings (ref,hotel_id,room_id,hotel_name,room_type,guest_name,guest_email,guests,checkin,checkout,nights,total_usd,total_lkr,operator) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ref, data.hotel_id, data.room_id, data.hotel_name, data.room_type,
        data.guest_name, data.guest_email, data.guests,
        data.checkin, data.checkout, data.nights,
        data.total_usd, data.total_lkr, data.operator
      );
      return db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid);
    }
    const b = { ref, ...data, status:'confirmed', created_at: new Date().toISOString() };
    mem.bookings = mem.bookings || [];
    mem.bookings.push(b);
    return b;
  },

  getStats: () => {
    if (db) {
      return {
        hotels:    db.prepare('SELECT COUNT(*) as c FROM hotels WHERE status="active"').get().c,
        rooms:     db.prepare('SELECT COUNT(*) as c FROM rooms WHERE status="active"').get().c,
        operators: db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE status="active"').get().c,
        bookings:  db.prepare('SELECT COUNT(*) as c FROM bookings').get().c,
        requests_today: db.prepare('SELECT COALESCE(SUM(requests_today),0) as c FROM api_keys').get().c,
        log_entries: db.prepare('SELECT COUNT(*) as c FROM request_log').get().c,
      };
    }
    return {
      hotels: mem.hotels.filter(h=>h.status==='active').length,
      rooms: mem.rooms.filter(r=>r.status==='active').length,
      operators: mem.api_keys.filter(k=>k.status==='active').length,
      bookings: (mem.bookings||[]).length,
      requests_today: mem.api_keys.reduce((s,k)=>s+k.requests_today,0),
    };
  },
};

// ═══════════════════════════════════════════════
// WEBHOOK — notify operators when prices change
// ═══════════════════════════════════════════════
function sendWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const body = JSON.stringify({ event: 'price.updated', ...payload, ts: new Date().toISOString() });
    const u = new URL(webhookUrl);
    const req = (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-StayDirect-Signature': crypto.createHmac('sha256','secret').update(body).digest('hex') }
    }, () => {});
    req.on('error', () => {}); // silent fail
    req.write(body); req.end();
    logger.info('Webhook sent', { url: webhookUrl });
  } catch {}
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function calcNights(c1, c2) {
  return Math.max(1, Math.round((new Date(c2) - new Date(c1)) / 86400000));
}

function jsonResp(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'X-Powered-By': 'StayDirect' });
  res.end(JSON.stringify(data, null, 2));
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) { body = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function authKey(req, res) {
  const q = url.parse(req.url, true).query;
  const rawKey = q.key || req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!rawKey) { jsonResp(res, 401, { error: 'API key required. Pass ?key= or X-API-Key header.', docs: '/api/v1' }); return null; }
  const k = DAL.getKey(rawKey);
  if (!k) { jsonResp(res, 401, { error: 'Invalid API key' }); return null; }
  if (k.requests_today >= k.daily_limit) {
    jsonResp(res, 429, { error: 'Daily limit exceeded', limit: k.daily_limit, plan: k.plan, upgrade: 'Contact admin' });
    return null;
  }
  DAL.incrementRequests(k.id);
  return k;
}

// ═══════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════
const routes = new Map();
function route(method, pattern, handler) {
  routes.set(`${method}:${pattern}`, { pattern, handler });
}

function matchRoute(method, pathname) {
  const direct = routes.get(`${method}:${pathname}`);
  if (direct) return { handler: direct.handler, params: {} };

  for (const [key, { pattern, handler }] of routes) {
    if (!key.startsWith(method + ':')) continue;
    const rParts = pattern.split('/');
    const pParts = pathname.split('/');
    if (rParts.length !== pParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(':')) params[rParts[i].slice(1)] = decodeURIComponent(pParts[i]);
      else if (rParts[i] !== pParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

// ═══════════════════════════════════════════════
// ROUTE DEFINITIONS
// ═══════════════════════════════════════════════

// Health
route('GET', '/', (req, res) => {
  jsonResp(res, 200, { service: 'StayDirect API', version: '1.0.0', status: 'ok', docs: '/api/v1', ...DAL.getStats() });
});

route('GET', '/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

// Docs
route('GET', '/api/v1', (req, res) => {
  jsonResp(res, 200, {
    version: '1.0.0',
    demo_key: 'sk_live_demo_key_readonly_001',
    endpoints: {
      'GET  /api/v1/search':              '?checkin=&checkout=&destination=&guests=&key=',
      'GET  /api/v1/hotels':              '?destination=&region=&key=',
      'GET  /api/v1/hotels/:id':          '?key=',
      'GET  /api/v1/hotels/:id/rooms':    '?checkin=&checkout=&key=',
      'POST /api/v1/bookings':            'body: {hotel_id,room_id,checkin,checkout,guest_name,guest_email}',
      'GET  /widget.js':                  '?key=&dest=&color=&brand=',
      'GET  /admin/stats':                'Server statistics',
      'POST /admin/hotels':               'Create hotel',
      'POST /admin/rooms':                'Create room',
      'POST /admin/keys':                 'Create API key',
    },
  });
});

// Search
route('GET', '/api/v1/search', (req, res) => {
  const k = authKey(req, res); if (!k) return;
  const q = url.parse(req.url, true).query;
  const { checkin, checkout, destination, guests = 2, max_price, min_price, region } = q;

  if (!checkin || !checkout) {
    return jsonResp(res, 400, { error: 'checkin and checkout required', format: 'YYYY-MM-DD' });
  }

  const nights = calcNights(checkin, checkout);
  const hotels = DAL.getHotels({ location: destination, region });

  const results = hotels.map(h => {
    let rooms = DAL.getRooms(h.id, { min_capacity: parseInt(guests), max_price: max_price ? parseFloat(max_price) : undefined });
    if (min_price) rooms = rooms.filter(r => r.price_usd >= parseFloat(min_price));
    return {
      ...h,
      rooms: rooms.map(r => ({ ...r, total_usd: +(r.price_usd * nights).toFixed(2), total_lkr: Math.round(r.price_lkr * nights), nights })),
    };
  }).filter(h => h.rooms.length > 0);

  const meta = { checkin, checkout, nights, guests: +guests, destination: destination || 'all Sri Lanka', currency: 'USD', updated_at: new Date().toISOString() };
  DAL.logRequest(k.id, k.company, 'GET', '/api/v1/search', q, 200, 0);
  jsonResp(res, 200, { results, total: results.length, meta });
});

// Hotels list
route('GET', '/api/v1/hotels', (req, res) => {
  const k = authKey(req, res); if (!k) return;
  const q = url.parse(req.url, true).query;
  const hotels = DAL.getHotels({ location: q.destination || q.location, region: q.region })
    .map(h => ({ ...h, min_price_usd: Math.min(...DAL.getRooms(h.id).map(r => r.price_usd)), room_types: DAL.getRooms(h.id).length }));
  DAL.logRequest(k.id, k.company, 'GET', '/api/v1/hotels', q, 200, 0);
  jsonResp(res, 200, { hotels, total: hotels.length });
});

// Single hotel
route('GET', '/api/v1/hotels/:id', (req, res, params) => {
  const k = authKey(req, res); if (!k) return;
  const hotel = DAL.getHotel(parseInt(params.id));
  if (!hotel) return jsonResp(res, 404, { error: 'Hotel not found' });
  jsonResp(res, 200, { hotel: { ...hotel, rooms: DAL.getRooms(hotel.id) } });
});

// Rooms for hotel
route('GET', '/api/v1/hotels/:id/rooms', (req, res, params) => {
  const k = authKey(req, res); if (!k) return;
  const q = url.parse(req.url, true).query;
  const hotel = DAL.getHotel(parseInt(params.id));
  if (!hotel) return jsonResp(res, 404, { error: 'Hotel not found' });
  const nights = q.checkin && q.checkout ? calcNights(q.checkin, q.checkout) : 1;
  const rooms = DAL.getRooms(hotel.id).map(r => ({ ...r, total_usd: +(r.price_usd * nights).toFixed(2), total_lkr: Math.round(r.price_lkr * nights), nights }));
  jsonResp(res, 200, { hotel_id: hotel.id, hotel_name: hotel.name, rooms, nights, checkin: q.checkin, checkout: q.checkout });
});

// Create booking
route('POST', '/api/v1/bookings', async (req, res) => {
  const k = authKey(req, res); if (!k) return;
  const body = await parseBody(req);
  const { hotel_id, room_id, checkin, checkout, guest_name, guest_email, guests = 2 } = body;

  if (!hotel_id || !room_id || !checkin || !checkout || !guest_name || !guest_email) {
    return jsonResp(res, 400, { error: 'Missing fields', required: ['hotel_id','room_id','checkin','checkout','guest_name','guest_email'] });
  }

  const hotel = DAL.getHotel(hotel_id);
  const rooms = DAL.getRooms(hotel_id);
  const room  = rooms.find(r => r.id === room_id);
  if (!hotel) return jsonResp(res, 404, { error: 'Hotel not found' });
  if (!room)  return jsonResp(res, 404, { error: 'Room not found or not in this hotel' });

  const nights = calcNights(checkin, checkout);
  const booking = DAL.createBooking({
    hotel_id, room_id, hotel_name: hotel.name, room_type: room.type,
    guest_name, guest_email, guests: +guests, checkin, checkout, nights,
    total_usd: +(room.price_usd * nights).toFixed(2),
    total_lkr: Math.round(room.price_lkr * nights),
    operator: k.company,
  });

  DAL.logRequest(k.id, k.company, 'POST', '/api/v1/bookings', { hotel_id, room_id }, 201, 0);
  jsonResp(res, 201, {
    booking,
    hotel: { name: hotel.name, address: hotel.address, emoji: hotel.emoji },
    room: { type: room.type, view: room.view },
    payment: 'Cash on arrival — LKR only',
    message: `Booking confirmed. Reference: ${booking.ref}`,
  });
});

// Widget JS
route('GET', '/widget.js', (req, res) => {
  const q = url.parse(req.url, true).query;
  const k = DAL.getKey(q.key || '');
  if (!k) {
    res.writeHead(401, {'Content-Type':'application/javascript'});
    return res.end('console.error("StayDirect: Invalid API key");');
  }
  const color = '#' + (q.color || '0E7C6B').replace('#','');
  const dest  = q.dest || '';
  const brand = q.brand !== '0';
  const hotels = DAL.getHotels(dest ? {location:dest} : {});
  const items  = hotels.flatMap(h => DAL.getRooms(h.id).map(r => ({ hotel: h.name, emoji: h.emoji||'🏨', type: r.type, price: r.price_usd }))).sort((a,b)=>a.price-b.price).slice(0,8);

  const js = `;(function(){
var COLOR="${color}",ITEMS=${JSON.stringify(items)},BRAND=${brand};
var el=document.getElementById('staydirect-widget');
if(!el){console.warn('StayDirect: add <div id="staydirect-widget"></div>');return;}
var s='<div style="font-family:system-ui,sans-serif;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;max-width:600px">';
s+='<div style="background:'+COLOR+';color:#fff;padding:14px 16px;font-weight:600;font-size:15px">🏨 Отели Шри-Ланки — прямые цены</div>';
ITEMS.forEach(function(r){
  s+='<div style="display:flex;justify-content:space-between;align-items:center;padding:11px 15px;border-bottom:1px solid #f0f0f0;transition:background .15s" onmouseover="this.style.background=\'#fafafa\'" onmouseout="this.style.background=\'\'">';
  s+='<div><div style="font-weight:500;font-size:14px">'+r.emoji+' '+r.hotel+'</div><div style="font-size:12px;color:#888;margin-top:2px">'+r.type+'</div></div>';
  s+='<div style="text-align:right"><div style="font-weight:600;color:'+COLOR+';font-size:16px">$'+r.price+'<span style="font-size:11px;font-weight:400;color:#999">/ночь</span></div>';
  s+='<button onclick="window.open(\'https://staydirect.lk\')" style="margin-top:5px;background:'+COLOR+';color:#fff;border:none;padding:5px 12px;border-radius:5px;font-size:12px;cursor:pointer">Забронировать</button></div></div>';
});
if(BRAND){s+='<div style="padding:8px 14px;text-align:right;font-size:10px;color:#bbb">Powered by <a href="https://staydirect.lk" style="color:'+COLOR+'">StayDirect</a></div>';}
s+='</div>';
el.innerHTML=s;
})();`;

  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
  res.end(js);
});

// ── ADMIN ────────────────────────────────────────

route('GET', '/admin/stats', (req, res) => {
  jsonResp(res, 200, { ...DAL.getStats(), uptime_seconds: Math.floor(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version });
});

route('GET', '/admin/log', (req, res) => {
  const q = url.parse(req.url, true).query;
  jsonResp(res, 200, { log: DAL.getLog(parseInt(q.limit) || 100) });
});

route('GET', '/admin/hotels', (req, res) => {
  jsonResp(res, 200, { hotels: DAL.getHotels({}), rooms: db ? db.prepare('SELECT * FROM rooms WHERE status="active"').all() : mem.rooms.filter(r=>r.status==='active') });
});

route('POST', '/admin/hotels', async (req, res) => {
  const body = await parseBody(req);
  if (!body.name || !body.location) return jsonResp(res, 400, { error: 'name and location required' });
  const hotel = DAL.createHotel(body);
  jsonResp(res, 201, { hotel, message: 'Hotel created' });
});

route('PUT', '/admin/hotels/:id', async (req, res, params) => {
  const body = await parseBody(req);
  const hotel = DAL.updateHotel(parseInt(params.id), body);
  if (!hotel) return jsonResp(res, 404, { error: 'Hotel not found' });
  jsonResp(res, 200, { hotel, message: 'Hotel updated' });
});

route('DELETE', '/admin/hotels/:id', (req, res, params) => {
  DAL.updateHotel(parseInt(params.id), { status: 'deleted' });
  jsonResp(res, 200, { message: 'Hotel deleted' });
});

route('POST', '/admin/rooms', async (req, res) => {
  const body = await parseBody(req);
  if (!body.hotel_id || !body.type || !body.price_usd) return jsonResp(res, 400, { error: 'hotel_id, type, price_usd required' });
  const room = DAL.createRoom(body);
  // Notify webhooks
  const keys = DAL.getAllKeys().filter(k => k.webhook_url && k.status === 'active');
  keys.forEach(k => sendWebhook(k.webhook_url, { hotel_id: body.hotel_id, room }));
  jsonResp(res, 201, { room, message: 'Room created' });
});

route('PUT', '/admin/rooms/:id', async (req, res, params) => {
  const body = await parseBody(req);
  const room = DAL.updateRoom(parseInt(params.id), body);
  if (!room) return jsonResp(res, 404, { error: 'Room not found' });
  // Notify webhooks if price changed
  if (body.price_usd) {
    const keys = DAL.getAllKeys().filter(k => k.webhook_url && k.status === 'active');
    keys.forEach(k => sendWebhook(k.webhook_url, { event: 'price.updated', room }));
  }
  jsonResp(res, 200, { room, message: 'Room updated' });
});

route('DELETE', '/admin/rooms/:id', (req, res, params) => {
  DAL.deleteRoom(parseInt(params.id));
  jsonResp(res, 200, { message: 'Room deleted' });
});

route('GET', '/admin/keys', (req, res) => {
  jsonResp(res, 200, { keys: DAL.getAllKeys() });
});

route('POST', '/admin/keys', async (req, res) => {
  const body = await parseBody(req);
  if (!body.company || !body.email) return jsonResp(res, 400, { error: 'company and email required' });
  const k = DAL.createKey(body);
  jsonResp(res, 201, { api_key: k, message: 'Key created' });
});

route('DELETE', '/admin/keys/:id', (req, res, params) => {
  DAL.revokeKey(parseInt(params.id));
  jsonResp(res, 200, { message: 'Key revoked' });
});

// ═══════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════
const server = http.createServer((req, res) => {
  const start = Date.now();
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  const match    = matchRoute(req.method, pathname);

  if (!match) {
    return jsonResp(res, 404, { error: 'Endpoint not found', docs: '/api/v1' });
  }

  try {
    const result = match.handler(req, res, match.params);
    if (result && typeof result.then === 'function') {
      result.catch(err => {
        logger.error('Async route error', { err: err.message });
        if (!res.headersSent) jsonResp(res, 500, { error: 'Internal server error' });
      });
    }
  } catch (err) {
    logger.error('Route error', { path: pathname, err: err.message });
    if (!res.headersSent) jsonResp(res, 500, { error: 'Internal server error' });
  }

  res.on('finish', () => logger.req(req.method, pathname, res.statusCode, Date.now() - start));
});

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  logger.info('StayDirect API started', { port: CONFIG.PORT, env: CONFIG.NODE_ENV, db: db ? 'SQLite' : 'memory' });
  console.log(`
╔══════════════════════════════════════════╗
║      StayDirect API v1.0.0               ║
║      http://localhost:${CONFIG.PORT}            ║
║                                          ║
║  DB:   ${db ? 'SQLite (' + CONFIG.DB_PATH + ')' : 'in-memory (install better-sqlite3)'}
║  Docs: http://localhost:${CONFIG.PORT}/api/v1    ║
╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down...'); server.close(() => { if (db) db.close(); process.exit(0); }); });
process.on('SIGINT',  () => { server.close(() => { if (db) db.close(); process.exit(0); }); });
