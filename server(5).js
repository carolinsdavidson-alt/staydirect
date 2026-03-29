const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS hotels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    loc TEXT NOT NULL,
    region TEXT DEFAULT 'Southern',
    rating REAL DEFAULT 8.0,
    emoji TEXT DEFAULT '🏨',
    photo TEXT DEFAULT '',
    address TEXT DEFAULT '',
    amenities TEXT DEFAULT '',
    desc TEXT DEFAULT '',
    status TEXT DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotelId INTEGER NOT NULL,
    type TEXT NOT NULL,
    view TEXT DEFAULT 'Sea view',
    beds TEXT DEFAULT 'DBL',
    price REAL NOT NULL,
    prices TEXT DEFAULT '{}',
    capacity INTEGER DEFAULT 2,
    minNights INTEGER DEFAULT 1,
    breakfast TEXT DEFAULT 'BB',
    cancel INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    FOREIGN KEY (hotelId) REFERENCES hotels(id)
  );
  CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    email TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    plan TEXT DEFAULT 'free',
    limitReq INTEGER DEFAULT 1000,
    today INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    webhook TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    hotelName TEXT NOT NULL,
    roomType TEXT NOT NULL,
    guestName TEXT NOT NULL,
    guestEmail TEXT DEFAULT '',
    checkin TEXT NOT NULL,
    checkout TEXT NOT NULL,
    nights INTEGER DEFAULT 1,
    totalUsd REAL DEFAULT 0,
    operator TEXT DEFAULT '',
    status TEXT DEFAULT 'confirmed',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotelId INTEGER DEFAULT 0,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'season',
    dateFrom TEXT NOT NULL,
    dateTo TEXT NOT NULL,
    prices TEXT DEFAULT '{}',
    surcharge REAL DEFAULT 0,
    status TEXT DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (datetime('now')),
    operator TEXT DEFAULT '',
    method TEXT DEFAULT 'GET',
    endpoint TEXT DEFAULT '',
    statusCode INTEGER DEFAULT 200
  );
`);

try {
  const hasFK = db.prepare("SELECT sql FROM sqlite_master WHERE name='rate_periods'").get();
  if (hasFK && hasFK.sql && hasFK.sql.includes('FOREIGN KEY')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_periods_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotelId INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'season',
        dateFrom TEXT NOT NULL,
        dateTo TEXT NOT NULL,
        prices TEXT DEFAULT '{}',
        surcharge REAL DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
      INSERT INTO rate_periods_new SELECT * FROM rate_periods;
      DROP TABLE rate_periods;
      ALTER TABLE rate_periods_new RENAME TO rate_periods;
    `);
  }
} catch(e) { console.log('rate_periods migration:', e.message); }

try {
  db.prepare("SELECT mealPlans FROM hotels LIMIT 1").get();
} catch(e) {
  db.exec("ALTER TABLE hotels ADD COLUMN mealPlans TEXT DEFAULT \'[\"BB\"]\' ");
  console.log('Migrated hotels: added mealPlans column');
}

function normalizePrices(raw) {
  let p = {};
  try { p = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch(e){ return {}; }
  if (!p || typeof p !== 'object') return {};
  const keys = Object.keys(p);
  if (keys.length === 0) return {};
  const first = p[keys[0]];
  if (typeof first === 'object' && first !== null) return p;
  return { BB: p };
}

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header' });
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(apiKey);
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  if (row.status !== 'active') return res.status(403).json({ error: 'API key revoked' });
  if (row.today >= row.limitReq) return res.status(429).json({ error: 'Rate limit exceeded' });
  db.prepare('UPDATE keys SET today = today + 1 WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO api_log (operator, method, endpoint, statusCode) VALUES (?, ?, ?, ?)').run(row.company, req.method, req.originalUrl, 200);
  req.apiKey = row;
  next();
}

app.get('/api/admin/hotels', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM hotels').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/hotels', (req, res) => {
  try {
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    if (!name || !loc) return res.status(400).json({ error: 'name and loc are required' });
    const result = db.prepare(`INSERT INTO hotels (name, loc, region, rating, emoji, photo, address, amenities, desc, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(name, loc, region||'Southern', rating||8.0, emoji||'🏨', photo||'', address||'', amenities||'', desc||'', status||'active');
    res.status(201).json(db.prepare('SELECT * FROM hotels WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/hotels/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Hotel not found' });
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    db.prepare(`UPDATE hotels SET name=?, loc=?, region=?, rating=?, emoji=?, photo=?, address=?, amenities=?, desc=?, status=? WHERE id=?`).run(name??existing.name, loc??existing.loc, region??existing.region, rating??existing.rating, emoji??existing.emoji, photo??existing.photo, address??existing.address, amenities??existing.amenities, desc??existing.desc, status??existing.status, req.params.id);
    res.json(db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/hotels/:id/toggle', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    db.prepare('UPDATE hotels SET status = ? WHERE id = ?').run(hotel.status==='active'?'hidden':'active', req.params.id);
    res.json(db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/rooms', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM rooms').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/rooms', (req, res) => {
  try {
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    if (!hotelId || !type) return res.status(400).json({ error: 'hotelId and type are required' });
    const pricesJson = typeof prices === 'object' ? JSON.stringify(prices) : (prices || '{}');
    const basePrice = price || 0;
    const result = db.prepare(`INSERT INTO rooms (hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hotelId, type, view||'Sea view', beds||'DBL', basePrice, pricesJson, capacity||2, minNights||1, breakfast||'BB', cancel??1, status||'active');
    res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/rooms/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Room not found' });
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    const pricesJson = prices ? (typeof prices === 'object' ? JSON.stringify(prices) : prices) : existing.prices;
    db.prepare(`UPDATE rooms SET hotelId=?, type=?, view=?, beds=?, price=?, prices=?, capacity=?, minNights=?, breakfast=?, cancel=?, status=? WHERE id=?`).run(hotelId??existing.hotelId, type??existing.type, view??existing.view, beds??existing.beds, price??existing.price, pricesJson, capacity??existing.capacity, minNights??existing.minNights, breakfast??existing.breakfast, cancel??existing.cancel, status??existing.status, req.params.id);
    res.json(db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Room not found' });
    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    res.json({ success: true, id: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/keys', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM keys').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/keys', (req, res) => {
  try {
    const { company, email, key, plan, limitReq, webhook } = req.body;
    if (!company || !email || !key) return res.status(400).json({ error: 'company, email, and key are required' });
    const result = db.prepare(`INSERT INTO keys (company, email, key, plan, limitReq, webhook) VALUES (?, ?, ?, ?, ?, ?)`).run(company, email, key, plan||'free', limitReq||1000, webhook||'');
    res.status(201).json(db.prepare('SELECT * FROM keys WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'API key already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/keys/:id/revoke', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Key not found' });
    db.prepare('UPDATE keys SET status = ? WHERE id = ?').run('revoked', req.params.id);
    res.json(db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/hotels/:id/price-matrix', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const rooms = db.prepare("SELECT * FROM rooms WHERE hotelId = ? AND status = 'active'").all(req.params.id);
    const periods = db.prepare("SELECT * FROM rate_periods WHERE (hotelId = ? OR hotelId = 0) AND status = 'active' ORDER BY dateFrom").all(req.params.id);
    let mealPlans; try { mealPlans = JSON.parse(hotel.mealPlans || '["BB"]'); } catch(e) { mealPlans = ['BB']; }
    const roomsOut = rooms.map(r => {
      let prices = normalizePrices(r.prices);
      if (Object.keys(prices).length === 0 && r.price > 0) prices = { BB: { DBL: r.price } };
      return { id: r.id, type: r.type, view: r.view, capacity: r.capacity, prices };
    });
    const periodsOut = periods.map(p => ({ id: p.id, name: p.name, type: p.type, dateFrom: p.dateFrom, dateTo: p.dateTo, prices: normalizePrices(p.prices), surcharge: p.surcharge||0 }));
    res.json({ hotel, rooms: roomsOut, periods: periodsOut, mealPlans });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/hotels/:id/price-matrix', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const { rooms, periods } = req.body;
    const updateRoom = db.prepare('UPDATE rooms SET prices = ?, price = ? WHERE id = ?');
    const updatePeriod = db.prepare('UPDATE rate_periods SET prices = ? WHERE id = ?');
    const tx = db.transaction(() => {
      if (rooms && Array.isArray(rooms)) for (const r of rooms) {
        const norm = r.prices || {};
        const bb = norm.BB || norm[Object.keys(norm)[0]] || {};
        const basePrice = bb.DBL || bb.SGL || Object.values(bb)[0] || 0;
        updateRoom.run(JSON.stringify(r.prices||{}), basePrice, r.id);
      }
      if (periods && Array.isArray(periods)) for (const p of periods) updatePeriod.run(JSON.stringify(p.prices||{}), p.id);
    });
    tx();
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/rate-periods', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM rate_periods ORDER BY dateFrom').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/rate-periods', (req, res) => {
  try {
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    if (!name || !dateFrom || !dateTo) return res.status(400).json({ error: 'name, dateFrom, dateTo required' });
    const pricesJson = typeof prices === 'object' ? JSON.stringify(prices) : (prices || '{}');
    const result = db.prepare(`INSERT INTO rate_periods (hotelId, name, type, dateFrom, dateTo, prices, surcharge, status) VALUES (?,?,?,?,?,?,?,?)`).run(hotelId||0, name, type||'season', dateFrom, dateTo, pricesJson, surcharge||0, status||'active');
    res.status(201).json(db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/rate-periods/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    const pricesJson = prices ? (typeof prices === 'object' ? JSON.stringify(prices) : prices) : existing.prices;
    db.prepare(`UPDATE rate_periods SET hotelId=?, name=?, type=?, dateFrom=?, dateTo=?, prices=?, surcharge=?, status=? WHERE id=?`).run(hotelId??existing.hotelId, name??existing.name, type??existing.type, dateFrom??existing.dateFrom, dateTo??existing.dateTo, pricesJson, surcharge??existing.surcharge, status??existing.status, req.params.id);
    res.json(db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/rate-periods/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM rate_periods WHERE id = ?').run(req.params.id);
    res.json({ success: true, id: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/bookings', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM bookings ORDER BY createdAt DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', (req, res) => {
  try {
    res.json({
      hotels: db.prepare('SELECT COUNT(*) as count FROM hotels').get().count,
      rooms: db.prepare('SELECT COUNT(*) as count FROM rooms').get().count,
      keys: db.prepare('SELECT COUNT(*) as count FROM keys').get().count,
      bookings: db.prepare('SELECT COUNT(*) as count FROM bookings').get().count
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/log', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM api_log ORDER BY id DESC LIMIT 50').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/log/stats', (req, res) => {
  try {
    res.json({
      requests: db.prepare('SELECT COALESCE(SUM(today), 0) as total FROM keys').get().total,
      operators: db.prepare("SELECT COUNT(*) as count FROM keys WHERE status = 'active'").get().count,
      bookings: db.prepare('SELECT COUNT(*) as count FROM bookings').get().count,
      revenue: db.prepare('SELECT COALESCE(SUM(totalUsd), 0) as total FROM bookings').get().total
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1', (req, res) => {
  res.json({ service: 'StayDirect Hotel API', version: 'v1', status: 'operational' });
});

app.get('/api/v1/hotels', requireApiKey, (req, res) => {
  try { res.json(db.prepare("SELECT * FROM hotels WHERE status = 'active'").all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/hotels/:id/rooms', requireApiKey, (req, res) => {
  try {
    const hotel = db.prepare("SELECT * FROM hotels WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json({ hotel, rooms: db.prepare("SELECT * FROM rooms WHERE hotelId = ? AND status = 'active'").all(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/bookings', requireApiKey, (req, res) => {
  try {
    const { hotelId, roomId, guestName, guestEmail, checkin, checkout } = req.body;
    if (!hotelId || !roomId || !guestName || !checkin || !checkout) return res.status(400).json({ error: 'Missing required fields' });
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(hotelId);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND hotelId = ?').get(roomId, hotelId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const nights = Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
    if (nights < room.minNights) return res.status(400).json({ error: `Minimum ${room.minNights} night(s) required` });
    const ref = 'SD-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2,6).toUpperCase();
    const result = db.prepare(`INSERT INTO bookings (ref, hotelName, roomType, guestName, guestEmail, checkin, checkout, nights, totalUsd, operator, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`).run(ref, hotel.name, room.type, guestName, guestEmail||'', checkin, checkout, nights, room.price*nights, req.apiKey.company);
    res.status(201).json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/public/hotels', (req, res) => {
  try {
    const hotels = db.prepare("SELECT * FROM hotels WHERE status = 'active'").all();
    const rooms = db.prepare("SELECT * FROM rooms WHERE status = 'active'").all();
    res.json(hotels.map(h => ({ ...h, rooms: rooms.filter(r => r.hotelId === h.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Admin HTML embedded
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StayDirect — Панель управления</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,300&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --ink:#0D0D0B; --ink2:#3D3A35; --muted:#7A7570;
  --sand:#F7F3EC; --sand2:#EDE8DF; --white:#fff;
  --teal:#0A6E5C; --teal2:#0E9478; --teal-l:#E3F2EE;
  --coral:#D4522A; --coral-l:#FDF0EB;
  --amber:#C4982A; --amber-l:#FBF4E3;
  --border:rgba(13,13,11,0.1); --border2:rgba(13,13,11,0.2);
  --r:10px; --r2:14px;
  --shadow:0 2px 16px rgba(13,13,11,0.07);
  --shadow2:0 8px 32px rgba(13,13,11,0.12);
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Outfit',sans-serif;background:var(--sand2);color:var(--ink);min-height:100vh}
button,input,select,textarea{font-family:inherit}

/* ── LOGIN ── */
#login-screen{position:fixed;inset:0;background:var(--ink);display:flex;align-items:center;justify-content:center;z-index:999;}
.login-box{background:var(--white);border-radius:20px;padding:48px;width:100%;max-width:400px;text-align:center;}
.login-logo{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:600;margin-bottom:8px}
.login-logo span{color:var(--teal)}
.login-sub{font-size:14px;color:var(--muted);margin-bottom:32px}
.login-field{margin-bottom:14px;text-align:left}
.login-field label{font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:5px}
.login-field input{width:100%;padding:11px 14px;border:1px solid var(--border2);border-radius:8px;font-size:14px;background:var(--sand);transition:border-color .2s;}
.login-field input:focus{outline:none;border-color:var(--teal);background:#fff}
.login-btn{width:100%;padding:13px;background:var(--teal);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;transition:all .2s;margin-top:8px;}
.login-btn:hover{background:var(--teal2)}
.login-hint{font-size:12px;color:var(--muted);margin-top:16px}

/* ── LAYOUT ── */
#app{display:none;min-height:100vh}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh}

/* ── SIDEBAR ── */
.sidebar{background:var(--ink);color:#fff;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;}
.sidebar-logo{padding:24px 20px 20px;font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);}
.sidebar-logo span{color:var(--teal2)}
.sidebar-section{font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em;padding:20px 20px 8px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;font-size:14px;color:rgba(255,255,255,0.6);cursor:pointer;transition:all .15s;border-left:3px solid transparent;}
.nav-item:hover{background:rgba(255,255,255,0.05);color:#fff}
.nav-item.active{background:rgba(10,110,92,0.15);color:#fff;border-left-color:var(--teal2)}
.nav-item .icon{font-size:16px;width:20px;text-align:center}
.sidebar-footer{margin-top:auto;padding:16px 20px;border-top:1px solid rgba(255,255,255,0.08)}
.logout-btn{width:100%;padding:9px;background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.5);border:1px solid rgba(255,255,255,0.1);border-radius:7px;font-size:13px;cursor:pointer;transition:all .15s;}
.logout-btn:hover{background:rgba(255,255,255,0.1);color:#fff}

/* ── MAIN ── */
.main{flex:1;overflow-y:auto}
.topbar{background:var(--white);border-bottom:1px solid var(--border);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
.page-title{font-size:18px;font-weight:500}
.topbar-right{display:flex;align-items:center;gap:12px}
.btn{padding:9px 20px;border-radius:8px;font-size:13px;font-weight:500;border:none;cursor:pointer;transition:all .15s;}
.btn-green{background:var(--teal);color:#fff}
.btn-green:hover{background:var(--teal2)}
.btn-outline{background:transparent;border:1px solid var(--border2);color:var(--ink)}
.btn-outline:hover{border-color:var(--teal);color:var(--teal)}
.btn-red{background:var(--coral-l);color:var(--coral);border:1px solid rgba(212,82,42,0.2)}
.btn-red:hover{background:var(--coral);color:#fff}
.btn-sm{padding:6px 12px;font-size:12px;border-radius:6px}
.content{padding:28px 32px}

/* ── KPI ── */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:var(--r2);padding:20px}
.kpi-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.kpi-value{font-family:'Cormorant Garamond',serif;font-size:36px;font-weight:600;line-height:1}
.kpi-value.green{color:var(--teal)}
.kpi-value.amber{color:var(--amber)}
.kpi-sub{font-size:11px;color:var(--muted);margin-top:4px}

/* ── TABLE ── */
.card{background:var(--white);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;margin-bottom:20px}
.card-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
.card-title{font-size:15px;font-weight:500}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:11px 16px;font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);background:var(--sand);}
td{padding:13px 16px;font-size:14px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--sand)}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500}
.badge-green{background:var(--teal-l);color:var(--teal)}
.badge-amber{background:var(--amber-l);color:var(--amber)}
.badge-red{background:var(--coral-l);color:var(--coral)}
.actions-cell{display:flex;gap:6px}
.tabs{display:flex;gap:0;border-bottom:2px solid var(--border2)}
.tab{padding:10px 20px;font-size:14px;font-weight:500;border:none;background:none;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--teal);border-bottom-color:var(--teal)}

/* ── MODAL ── */
.overlay{position:fixed;inset:0;background:rgba(13,13,11,0.5);z-index:200;display:none;align-items:center;justify-content:center;padding:20px;}
.overlay.open{display:flex}
.modal{background:var(--white);border-radius:var(--r2);width:100%;max-width:600px;max-height:92vh;overflow-y:auto;box-shadow:var(--shadow2);}
.modal-head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--white);border-radius:var(--r2) var(--r2) 0 0;z-index:2;}
.modal-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:300}
.modal-close{width:32px;height:32px;border-radius:50%;border:none;background:var(--sand);cursor:pointer;font-size:16px;color:var(--muted);display:flex;align-items:center;justify-content:center;}
.modal-body{padding:24px}
.modal-foot{padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;position:sticky;bottom:0;background:var(--white);border-radius:0 0 var(--r2) var(--r2);z-index:2;}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.fg{display:flex;flex-direction:column;gap:5px}
.fg.full{grid-column:1/-1}
.fg label{font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.fg input,.fg select,.fg textarea{padding:9px 12px;border:1px solid var(--border2);border-radius:8px;font-size:14px;background:var(--sand);color:var(--ink);transition:border-color .15s;}
.fg input:focus,.fg select:focus,.fg textarea:focus{outline:none;border-color:var(--teal);background:#fff;}
.fg textarea{height:80px;resize:vertical}
.section-divider{grid-column:1/-1;font-size:12px;font-weight:600;color:var(--teal);text-transform:uppercase;letter-spacing:.06em;padding:8px 0 4px;border-top:1px solid var(--border);margin-top:4px;}

/* ── SEASON TABS IN ROOM MODAL ── */
.rm-season-tabs{
  display:flex;gap:0;border-bottom:2px solid var(--border2);
  margin:0 -24px;padding:0 24px;
  background:var(--sand);
  position:sticky;top:63px;z-index:1;
}
.rm-stab{
  padding:9px 14px;font-size:12px;font-weight:500;
  border:none;background:none;color:var(--muted);
  cursor:pointer;border-bottom:2px solid transparent;
  margin-bottom:-2px;transition:all .2s;white-space:nowrap;
}
.rm-stab:hover{color:var(--ink)}
.rm-stab.active{color:var(--teal);border-bottom-color:var(--teal)}
.rm-stab.has-data::after{content:'●';font-size:6px;color:var(--teal);vertical-align:super;margin-left:3px;}
.rm-stab.surcharge-tab.active{color:var(--coral);border-bottom-color:var(--coral)}
.season-panel{display:none}
.season-panel.active{display:block}
.season-info{
  font-size:12px;color:var(--muted);
  padding:8px 12px;background:var(--sand);
  border-radius:8px;margin-bottom:12px;
  border-left:3px solid var(--teal);
}
.season-info.surcharge-info{border-left-color:var(--coral)}
.surcharge-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.surcharge-row label{font-size:12px;font-weight:500;color:var(--ink2);min-width:160px;}
.surcharge-row input{width:100px;padding:8px 10px;border:1px solid var(--border2);border-radius:7px;font-size:15px;font-weight:500;color:var(--coral);background:var(--coral-l);}
.surcharge-row input:focus{outline:none;border-color:var(--coral);background:#fff;}

/* ── MEAL TABS ── */
.meal-tab{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid var(--border2);background:var(--white);color:var(--muted);cursor:pointer;transition:all .15s;}
.meal-tab:hover{border-color:var(--teal);color:var(--teal)}
.meal-tab.active{background:var(--teal);color:#fff;border-color:var(--teal)}
.meal-panel{display:none}
.meal-panel.active{display:block}

/* ── PRICE EDITOR ── */
.price-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.price-card{background:var(--white);border:1px solid var(--border);border-radius:var(--r2);padding:18px;transition:all .2s}
.price-card:hover{border-color:var(--teal);box-shadow:var(--shadow)}
.pc-hotel{font-size:13px;color:var(--muted);margin-bottom:4px}
.pc-room{font-size:15px;font-weight:500;margin-bottom:12px}
.pc-price-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.pc-price-row label{font-size:12px;color:var(--muted);min-width:80px}
.price-input{flex:1;padding:8px 12px;border:1px solid var(--border2);border-radius:7px;font-size:16px;font-weight:500;color:var(--teal);background:var(--teal-l);transition:all .15s;}
.price-input:focus{outline:none;border-color:var(--teal);background:#fff}
.pc-save{width:100%;padding:8px;background:var(--teal);color:#fff;border:none;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;}
.pc-save:hover{background:var(--teal2)}
.pc-saved{background:var(--teal-l);color:var(--teal)}

/* TOAST */
.toast{position:fixed;bottom:24px;right:24px;z-index:500;padding:13px 20px;border-radius:9px;font-size:14px;color:#fff;transform:translateY(60px);opacity:0;transition:all .25s;pointer-events:none;}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{background:var(--teal)}
.toast.error{background:var(--coral)}
.loading-spinner{text-align:center;padding:40px;color:var(--muted);font-size:14px}
.search-bar{display:flex;gap:12px;margin-bottom:20px;align-items:center;}
.search-input{flex:1;padding:10px 16px;border:1px solid var(--border2);border-radius:8px;font-size:14px;background:var(--white);transition:border-color .15s;max-width:360px;}
.search-input:focus{outline:none;border-color:var(--teal)}
.search-input::placeholder{color:var(--muted)}
.pagination{display:flex;align-items:center;gap:8px;justify-content:center;padding:20px 0}
.page-btn{padding:6px 14px;border-radius:6px;font-size:13px;border:1px solid var(--border2);background:var(--white);cursor:pointer;transition:all .15s;color:var(--ink);}
.page-btn:hover{border-color:var(--teal);color:var(--teal)}
.page-btn.active{background:var(--teal);color:#fff;border-color:var(--teal)}
.page-btn:disabled{opacity:.4;cursor:default}
.page-info{font-size:13px;color:var(--muted)}

/* PRICE MATRIX */
.pm-room-section{margin-bottom:28px}
.pm-room-header{padding:14px 20px;background:var(--sand);border:1px solid var(--border);border-radius:var(--r2) var(--r2) 0 0;font-size:15px;font-weight:500;display:flex;align-items:center;gap:8px;}
.pm-room-header .pm-view{font-size:12px;color:var(--muted);font-weight:400}
.pm-meal-tabs{display:flex;gap:0;border-bottom:2px solid var(--border2);margin-bottom:0}
.pm-meal-tab{padding:8px 18px;font-size:13px;font-weight:500;border:none;background:none;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s;}
.pm-meal-tab:hover{color:var(--ink)}
.pm-meal-tab.active{color:var(--teal);border-bottom-color:var(--teal)}
.pm-meal-tab .pm-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:4px;vertical-align:middle}
.pm-meal-tab .pm-dot.has-data{background:var(--teal)}
.pm-table{width:100%;border-collapse:collapse;border:1px solid var(--border);border-top:none}
.pm-table th{text-align:center;padding:10px 8px;font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border);background:var(--sand);white-space:nowrap;}
.pm-table th:first-child{text-align:left;padding-left:16px;min-width:120px}
.pm-table td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:center}
.pm-table td:first-child{text-align:left;padding-left:16px;font-size:13px;font-weight:500;color:var(--ink2)}
.pm-table tr:last-child td{border-bottom:none}
.pm-table tr:hover td{background:rgba(10,110,92,0.02)}
.pm-input{width:80px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:14px;text-align:center;background:var(--white);color:var(--ink);transition:all .15s;}
.pm-input:focus{outline:none;border-color:var(--teal);background:var(--teal-l)}
.pm-input:not(:placeholder-shown){color:var(--teal);font-weight:500}
.pm-surcharges{margin-top:16px;padding:14px 20px;background:var(--coral-l);border:1px solid rgba(212,82,42,0.15);border-radius:var(--r2);font-size:13px}
.pm-surcharges strong{color:var(--coral)}
.pm-save-bar{position:sticky;bottom:0;background:var(--white);border-top:1px solid var(--border);padding:16px 0;display:flex;justify-content:center;gap:12px;z-index:5;}

/* ── PAGES ── */
.page{display:none}
.page.active{display:block}

@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}
  .kpi-row{grid-template-columns:repeat(2,1fr)}
  .content{padding:16px}
  .form-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="login-screen">
  <div class="login-box">
    <div class="login-logo">Stay<span>Direct</span></div>
    <div class="login-sub">Панель управления</div>
    <div class="login-field"><label>Email</label><input type="email" id="login-email" placeholder="admin@staydirect.pro"></div>
    <div class="login-field"><label>Пароль</label><input type="password" id="login-pass" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()"></div>
    <button class="login-btn" onclick="doLogin()">Войти →</button>
    <div class="login-hint"><a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="fe9f9a939790be8d8a9f879a978c9b9d8ad08e8c91">[email&#160;protected]</a> / staydirect2026</div>
  </div>
</div>

<!-- APP -->
<div id="app">
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-logo">Stay<span>Direct</span> <span style="font-size:11px;color:rgba(255,255,255,0.3);font-family:'Outfit'">Admin</span></div>
      <div class="sidebar-section">Управление</div>
      <div class="nav-item active" data-page="dashboard" onclick="showPage('dashboard',this)"><span class="icon">📊</span>Дашборд</div>
      <div class="nav-item" data-page="hotels" onclick="showPage('hotels',this)"><span class="icon">🏨</span>Отели</div>
      <div class="nav-item" data-page="rooms" onclick="showPage('rooms',this)"><span class="icon">🛏</span>Номера</div>
      <div class="nav-item" data-page="prices" onclick="showPage('prices',this)"><span class="icon">💰</span>Цены</div>
      <div class="sidebar-section">Операторы</div>
      <div class="nav-item" data-page="keys" onclick="showPage('keys',this)"><span class="icon">🔑</span>API ключи</div>
      <div class="nav-item" data-page="bookings" onclick="showPage('bookings',this)"><span class="icon">📋</span>Бронирования</div>
      <div class="nav-item" data-page="log" onclick="showPage('log',this)"><span class="icon">📈</span>Статистика</div>
      <div class="sidebar-section">Система</div>
      <div class="nav-item" onclick="window.open('/api/v1','_blank')"><span class="icon">🔗</span>API</div>
      <div class="nav-item" onclick="window.open('/','_blank')"><span class="icon">🌐</span>Сайт</div>
      <div class="sidebar-footer"><button class="logout-btn" onclick="doLogout()">← Выйти</button></div>
    </aside>

    <div class="main">
      <div class="topbar">
        <div class="page-title" id="page-title">Дашборд</div>
        <div class="topbar-right">
          <span style="font-size:13px;color:var(--muted)" id="topbar-date"></span>
          <div style="width:32px;height:32px;border-radius:50%;background:var(--teal-l);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:500;color:var(--teal)">A</div>
        </div>
      </div>
      <div class="content">

        <!-- DASHBOARD -->
        <div id="page-dashboard" class="page active">
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-label">Отелей</div><div class="kpi-value green" id="kpi-h">—</div><div class="kpi-sub">в базе</div></div>
            <div class="kpi"><div class="kpi-label">Номеров</div><div class="kpi-value green" id="kpi-r">—</div><div class="kpi-sub">типов</div></div>
            <div class="kpi"><div class="kpi-label">Операторов</div><div class="kpi-value" id="kpi-o">—</div><div class="kpi-sub">активных</div></div>
            <div class="kpi"><div class="kpi-label">Бронирований</div><div class="kpi-value amber" id="kpi-b">—</div><div class="kpi-sub">всего</div></div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Последние отели</div><button class="btn btn-green btn-sm" onclick="showPage('hotels',document.querySelector('[data-page=hotels]'))">Все отели</button></div>
            <table><thead><tr><th>Название</th><th>Локация</th><th>Номеров</th><th>Мин. цена</th><th>Статус</th></tr></thead>
            <tbody id="dash-table"><tr><td colspan="5" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Последние бронирования</div></div>
            <table><thead><tr><th>Ref</th><th>Отель</th><th>Гость</th><th>Даты</th><th>Сумма</th><th>Статус</th></tr></thead>
            <tbody id="book-dash-table"><tr><td colspan="6" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
        </div>

        <!-- HOTELS -->
        <div id="page-hotels" class="page">
          <div class="search-bar">
            <input class="search-input" id="hotel-search" placeholder="Поиск по названию или локации..." oninput="filterHotels()">
            <button class="btn btn-green" onclick="openHotelModal()">+ Добавить отель</button>
          </div>
          <div class="card">
            <table><thead><tr><th>Отель</th><th>Локация</th><th>Рейтинг</th><th>Номеров</th><th>Статус</th><th>Действия</th></tr></thead>
            <tbody id="hotels-table"><tr><td colspan="6" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
          <div class="pagination" id="hotels-pagination"></div>
        </div>

        <!-- ROOMS -->
        <div id="page-rooms" class="page">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
            <select id="rooms-hotel-filter" onchange="onRoomsHotelChange()" style="padding:9px 14px;border:1px solid var(--border2);border-radius:8px;font-size:14px;min-width:280px">
              <option value="">Все отели</option>
            </select>
            <input class="search-input" id="room-search" placeholder="Поиск по типу номера..." oninput="filterRooms()" style="flex:1;min-width:200px">
          </div>
          <div class="tabs" id="rooms-tabs" style="margin-bottom:16px;display:none">
            <button class="tab active" id="tab-rm-matrix" onclick="switchRoomsTab('matrix')">📋 Матрица цен</button>
            <button class="tab" id="tab-rm-seasons" onclick="switchRoomsTab('seasons')">📅 Сезоны <span id="rm-seasons-count"></span></button>
            <button class="tab" id="tab-rm-rooms" onclick="switchRoomsTab('rooms')">🛏 Номера <span id="rm-rooms-count"></span></button>
          </div>
          <div id="rm-tab-matrix" style="display:none">
            <div id="pm-container"><div class="loading-spinner">Выберите отель для просмотра матрицы цен</div></div>
          </div>
          <div id="rm-tab-rooms">
            <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
              <button class="btn btn-green" onclick="openRoomModal()">+ Добавить номер</button>
            </div>
            <div class="card">
              <table><thead><tr><th>Отель</th><th>Тип номера</th><th>Вид</th><th>Вмест.</th><th>Цены ($/ночь)</th><th>Статус</th><th>Действия</th></tr></thead>
              <tbody id="rooms-table"><tr><td colspan="7" class="loading-spinner">Загрузка...</td></tr></tbody></table>
            </div>
            <div class="pagination" id="rooms-pagination"></div>
          </div>
          <div id="rm-tab-seasons" style="display:none">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px">Сезоны меняют базовые цены номеров. Доплаты (Новый Год, Рождество) прибавляются к сезонной цене.</div>
            <div style="display:flex;gap:8px;margin-bottom:16px">
              <button class="btn btn-green" onclick="openSeasonModal()">+ Добавить период</button>
              <button class="btn btn-outline" onclick="seedDefaultSeasons()">📅 Стандартные сезоны</button>
            </div>
            <div class="card">
              <table><thead><tr><th>Название</th><th>Тип</th><th>Даты</th><th>Доплата</th><th>Статус</th><th>Действия</th></tr></thead>
              <tbody id="rm-seasons-table"><tr><td colspan="6" class="loading-spinner">Загрузка...</td></tr></tbody></table>
            </div>
          </div>
        </div>

        <!-- PRICES -->
        <div id="page-prices" class="page">
          <div style="margin-bottom:24px">
            <div style="font-size:15px;font-weight:500;margin-bottom:4px">Быстрое обновление цен</div>
            <div style="font-size:13px;color:var(--muted)">Измени цену и нажми «Сохранить» — сразу обновится для всех туроператоров</div>
          </div>
          <div class="search-bar"><input class="search-input" id="price-search" placeholder="Поиск по отелю или номеру..." oninput="filterPrices()"></div>
          <div class="price-grid" id="prices-grid"><div class="loading-spinner">Загрузка...</div></div>
        </div>

        <!-- HOTEL DETAIL -->
        <div id="page-hotel-detail" class="page">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
            <button class="btn btn-outline btn-sm" onclick="showPage('hotels',document.querySelector('[data-page=hotels]'))">← Назад</button>
            <div>
              <div style="font-size:18px;font-weight:600" id="hd-hotel-name"></div>
              <div style="font-size:13px;color:var(--muted)" id="hd-hotel-loc"></div>
            </div>
          </div>
          <div class="tabs" style="margin-bottom:20px">
            <button class="tab active" id="tab-hd-rooms" onclick="switchHdTab('rooms')">🛏 Номера <span id="hd-rooms-count" style="font-size:11px;color:var(--muted)"></span></button>
            <button class="tab" id="tab-hd-seasons" onclick="switchHdTab('seasons')">📅 Сезоны <span id="hd-seasons-count" style="font-size:11px;color:var(--muted)"></span></button>
          </div>
          <div id="hd-tab-rooms">
            <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
              <button class="btn btn-green" onclick="openRoomModal()">+ Добавить номер</button>
            </div>
            <div class="card">
              <table><thead><tr><th>Тип номера</th><th>Вид</th><th>Питание</th><th>Вмест.</th><th>Цены ($/ночь)</th><th>Статус</th><th>Действия</th></tr></thead>
              <tbody id="hd-rooms-table"><tr><td colspan="7" class="loading-spinner">Загрузка...</td></tr></tbody></table>
            </div>
          </div>
          <div id="hd-tab-seasons" style="display:none">
            <div style="font-size:13px;color:var(--muted);margin-bottom:12px">Сезоны меняют базовые цены номеров. Доплаты (Новый Год, Рождество) прибавляются к сезонной цене.</div>
            <div style="display:flex;gap:8px;margin-bottom:16px">
              <button class="btn btn-green" onclick="openSeasonModal()">+ Добавить период</button>
              <button class="btn btn-outline" onclick="seedDefaultSeasons()">📅 Стандартные сезоны</button>
            </div>
            <div class="card">
              <table><thead><tr><th>Название</th><th>Тип</th><th>Даты</th><th>Доплата</th><th>Статус</th><th>Действия</th></tr></thead>
              <tbody id="hd-seasons-table"><tr><td colspan="6" class="loading-spinner">Загрузка...</td></tr></tbody></table>
            </div>
          </div>
        </div>

        <!-- API KEYS -->
        <div id="page-keys" class="page">
          <div style="display:flex;justify-content:flex-end;margin-bottom:20px"><button class="btn btn-green" onclick="openKeyModal()">+ Выдать ключ</button></div>
          <div class="card">
            <table><thead><tr><th>Компания</th><th>Email</th><th>Ключ</th><th>План</th><th>Запросов сегодня</th><th>Статус</th><th></th></tr></thead>
            <tbody id="keys-table"><tr><td colspan="7" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
        </div>

        <!-- BOOKINGS -->
        <div id="page-bookings" class="page">
          <div class="card">
            <div class="card-header"><div class="card-title">Все бронирования</div></div>
            <table><thead><tr><th>Ref</th><th>Отель / Номер</th><th>Гость</th><th>Заезд</th><th>Выезд</th><th>Ночей</th><th>Сумма $</th><th>Оператор</th><th>Статус</th></tr></thead>
            <tbody id="bookings-table"><tr><td colspan="9" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
        </div>

        <!-- LOG -->
        <div id="page-log" class="page">
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-label">Запросов сегодня</div><div class="kpi-value green" id="log-req">—</div></div>
            <div class="kpi"><div class="kpi-label">Активных операторов</div><div class="kpi-value" id="log-ops">—</div></div>
            <div class="kpi"><div class="kpi-label">Бронирований</div><div class="kpi-value amber" id="log-book">—</div></div>
            <div class="kpi"><div class="kpi-label">Доход (расч.)</div><div class="kpi-value green" id="log-rev">—</div></div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Лог API запросов</div><button class="btn btn-outline btn-sm" onclick="loadLog()">Обновить</button></div>
            <table><thead><tr><th>Время</th><th>Оператор</th><th>Метод</th><th>Endpoint</th><th>Статус</th></tr></thead>
            <tbody id="log-table"><tr><td colspan="5" class="loading-spinner">Загрузка...</td></tr></tbody></table>
          </div>
        </div>

      </div>
    </div>
  </div>
</div>

<!-- MODAL: Hotel -->
<div class="overlay" id="modal-hotel">
  <div class="modal">
    <div class="modal-head"><div class="modal-title" id="modal-hotel-title">Добавить отель</div><button class="modal-close" onclick="closeModal('modal-hotel')">✕</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="fg full"><label>Название отеля *</label><input id="h-name" placeholder="Liya Beach Kathaluwa"></div>
        <div class="fg"><label>Локация *</label>
          <select id="h-loc">
            <option value="Ahangama">Ахангама</option><option value="Galle">Галле</option>
            <option value="Mirissa">Мирисса</option><option value="Ella">Элла</option>
            <option value="Colombo">Коломбо</option><option value="Hikkaduwa">Хиккадува</option>
            <option value="Negombo">Негомбо</option><option value="Bentota">Бентота</option>
            <option value="Kandy">Канди</option><option value="Tangalle">Тангалле</option>
          </select>
        </div>
        <div class="fg"><label>Регион</label>
          <select id="h-region">
            <option value="Southern">Southern</option><option value="Western">Western</option>
            <option value="Central">Central</option><option value="Uva">Uva</option>
          </select>
        </div>
        <div class="fg"><label>Рейтинг (0–10)</label><input id="h-rating" type="number" min="0" max="10" step="0.1" placeholder="8.7"></div>
        <div class="fg"><label>Эмодзи</label><input id="h-emoji" placeholder="🏖" maxlength="2"></div>
        <div class="fg full"><label>Фото URL</label><input id="h-photo" placeholder="https://images.unsplash.com/photo-..."></div>
        <div id="h-photo-preview" style="display:none;margin:-8px 0 8px;grid-column:1/-1"><img style="max-height:120px;border-radius:8px;border:1px solid var(--border)" /></div>
        <div class="fg full"><label>Адрес</label><input id="h-address" placeholder="Galle Road, Kathaluwa, 80650"></div>
        <div class="fg full"><label>Удобства</label><input id="h-amenities" placeholder="Pool, WiFi, AC, Parking, Restaurant"></div>
        <div class="fg full"><label>Описание</label><textarea id="h-desc" placeholder="Краткое описание отеля..."></textarea></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="closeModal('modal-hotel')">Отмена</button>
      <button class="btn btn-green" id="save-hotel-btn" onclick="saveHotel()">Сохранить</button>
    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     MODAL: Room — полная форма с сезонами, питанием и датами
     ═══════════════════════════════════════════════════════════════════ -->
<div class="overlay" id="modal-room">
  <div class="modal" style="max-width:680px">
    <div class="modal-head">
      <div class="modal-title" id="modal-room-title">Добавить номер</div>
      <button class="modal-close" onclick="closeModal('modal-room')">✕</button>
    </div>
    <div class="modal-body" style="padding-top:16px">

      <!-- Базовая информация -->
      <div class="form-grid" style="margin-bottom:16px">
        <div class="fg full"><label>Отель *</label><select id="r-hotel"></select></div>
        <div class="fg full"><label>Тип номера *</label>
          <input id="r-type" list="room-types" placeholder="Введите или выберите...">
          <datalist id="room-types">
            <option value="Standard Room"><option value="Superior Room"><option value="Deluxe Room">
            <option value="Premium Room"><option value="Suite"><option value="Junior Suite">
            <option value="Villa"><option value="Bungalow"><option value="Tent / Eco Tent">
          </datalist>
        </div>
        <div class="fg">
          <label>Вид из номера</label>
          <input id="r-view" list="view-types" placeholder="Введите или выберите...">
          <datalist id="view-types">
            <option value="Sea view"><option value="Ocean view"><option value="Pool view">
            <option value="Garden view"><option value="Mountain view"><option value="Jungle view">
            <option value="River view"><option value="Lagoon view"><option value="Street view">
          </datalist>
        </div>
        <div class="fg"><label>Вместимость (чел.)</label><input id="r-capacity" type="number" min="1" value="2"></div>
        <div class="fg"><label>Мин. ночей</label><input id="r-minnights" type="number" min="1" value="1"></div>
        <div class="fg"><label>Можно отменить</label>
          <select id="r-cancel"><option value="1">Да</option><option value="0">Нет</option></select>
        </div>
      </div>

      <!-- Вкладки сезонов -->
      <div style="margin:0 -24px;border-top:1px solid var(--border)">
        <div class="rm-season-tabs">
          <button class="rm-stab active" id="rmstab-base" onclick="switchRmSeasonTab('base')">💰 Базовый</button>
          <button class="rm-stab" id="rmstab-low" onclick="switchRmSeasonTab('low')">🌿 Low</button>
          <button class="rm-stab" id="rmstab-mid" onclick="switchRmSeasonTab('mid')">☀️ Mid</button>
          <button class="rm-stab" id="rmstab-high" onclick="switchRmSeasonTab('high')">🔥 High</button>
          <button class="rm-stab surcharge-tab" id="rmstab-surcharge" onclick="switchRmSeasonTab('surcharge')">🎄 Доплаты</button>
        </div>
      </div>

      <!-- ── БАЗОВЫЙ СЕЗОН ── -->
      <div class="season-panel active" id="rmpanel-base" style="padding-top:14px">
        <div class="season-info">Базовые цены действуют по умолчанию, когда нет активного сезона.</div>
        <!-- Питание: вкладки внутри сезона -->
        <div id="base-meal-tabs" style="display:flex;gap:4px;flex-wrap:wrap;margin:12px 0 8px">
          <button class="meal-tab active" onclick="switchMealTab('base','RO',this)">RO</button>
          <button class="meal-tab" onclick="switchMealTab('base','BB',this)">BB</button>
          <button class="meal-tab" onclick="switchMealTab('base','HB',this)">HB</button>
          <button class="meal-tab" onclick="switchMealTab('base','FB',this)">FB</button>
          <button class="meal-tab" onclick="switchMealTab('base','AI',this)">AI</button>
        </div>
        <div id="base-meal-panels">
          <div class="meal-panel active" id="base-RO-panel"><div class="form-grid">
            <div class="section-divider">RO — Room Only ($/ночь)</div>
            <div class="fg"><label>SGL</label><input id="r-base-RO-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-base-RO-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-base-RO-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-base-RO-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg full"><label style="color:var(--muted);font-size:10px">С детьми / инфантами</label></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-base-RO-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-base-RO-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-base-RO-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-base-RO-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-base-RO-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD (1 eb)</label><input id="r-base-RO-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-base-RO-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-base-RO-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="base-BB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">BB — Bed &amp; Breakfast · Доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>Доплата SGL</label><input id="r-base-BB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата DBL</label><input id="r-base-BB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата TPL</label><input id="r-base-BB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата 4 PAX</label><input id="r-base-BB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-base-BB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-base-BB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-base-BB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-base-BB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-base-BB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD (1 eb)</label><input id="r-base-BB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-base-BB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-base-BB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="base-HB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">HB — Half Board · Доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>Доплата SGL</label><input id="r-base-HB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата DBL</label><input id="r-base-HB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата TPL</label><input id="r-base-HB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата 4 PAX</label><input id="r-base-HB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-base-HB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-base-HB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-base-HB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-base-HB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-base-HB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD (1 eb)</label><input id="r-base-HB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-base-HB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-base-HB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="base-FB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">FB — Full Board · Доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>Доплата SGL</label><input id="r-base-FB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата DBL</label><input id="r-base-FB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата TPL</label><input id="r-base-FB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата 4 PAX</label><input id="r-base-FB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-base-FB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-base-FB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-base-FB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-base-FB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-base-FB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD (1 eb)</label><input id="r-base-FB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-base-FB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-base-FB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="base-AI-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">AI — All Inclusive · Доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>Доплата SGL</label><input id="r-base-AI-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата DBL</label><input id="r-base-AI-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата TPL</label><input id="r-base-AI-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>Доплата 4 PAX</label><input id="r-base-AI-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-base-AI-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-base-AI-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-base-AI-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-base-AI-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-base-AI-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD (1 eb)</label><input id="r-base-AI-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-base-AI-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-base-AI-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
        </div>
      </div>

      <!-- ── LOW SEASON ── -->
      <div class="season-panel" id="rmpanel-low" style="padding-top:14px">
        <div class="season-info">🌿 <strong>Low Season</strong> — низкий сезон.</div>
        <div class="form-grid" style="margin-bottom:10px">
          <div class="fg"><label>📅 Дата начала</label><input id="r-low-from" type="date"></div>
          <div class="fg"><label>📅 Дата окончания</label><input id="r-low-to" type="date"></div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          <button class="meal-tab active" onclick="switchMealTab('low','RO',this)">RO</button>
          <button class="meal-tab" onclick="switchMealTab('low','BB',this)">BB</button>
          <button class="meal-tab" onclick="switchMealTab('low','HB',this)">HB</button>
          <button class="meal-tab" onclick="switchMealTab('low','FB',this)">FB</button>
          <button class="meal-tab" onclick="switchMealTab('low','AI',this)">AI</button>
        </div>
        <div id="low-meal-panels">
          <div class="meal-panel active" id="low-RO-panel"><div class="form-grid">
            <div class="section-divider">🌿 Low · RO ($/ночь)</div>
            <div class="fg"><label>SGL</label><input id="r-low-RO-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-low-RO-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-low-RO-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-low-RO-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-low-RO-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-low-RO-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD (1 eb)</label><input id="r-low-RO-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF (1 eb)</label><input id="r-low-RO-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-low-RO-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-low-RO-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF (no eb)</label><input id="r-low-RO-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF (no eb)</label><input id="r-low-RO-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="low-BB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🌿 Low · BB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-low-BB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-low-BB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-low-BB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-low-BB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-low-BB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-low-BB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-low-BB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-low-BB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-low-BB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-low-BB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-low-BB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-low-BB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="low-HB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🌿 Low · HB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-low-HB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-low-HB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-low-HB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-low-HB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-low-HB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-low-HB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-low-HB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-low-HB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-low-HB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-low-HB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-low-HB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-low-HB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="low-FB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🌿 Low · FB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-low-FB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-low-FB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-low-FB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-low-FB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-low-FB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-low-FB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-low-FB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-low-FB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-low-FB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-low-FB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-low-FB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-low-FB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="low-AI-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🌿 Low · AI — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-low-AI-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-low-AI-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-low-AI-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-low-AI-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-low-AI-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-low-AI-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-low-AI-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-low-AI-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-low-AI-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-low-AI-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-low-AI-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-low-AI-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
        </div>
      </div>

      <!-- ── MID SEASON ── -->
      <div class="season-panel" id="rmpanel-mid" style="padding-top:14px">
        <div class="season-info">☀️ <strong>Mid Season</strong> — средний сезон.</div>
        <div class="form-grid" style="margin-bottom:10px">
          <div class="fg"><label>📅 Дата начала</label><input id="r-mid-from" type="date"></div>
          <div class="fg"><label>📅 Дата окончания</label><input id="r-mid-to" type="date"></div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          <button class="meal-tab active" onclick="switchMealTab('mid','RO',this)">RO</button>
          <button class="meal-tab" onclick="switchMealTab('mid','BB',this)">BB</button>
          <button class="meal-tab" onclick="switchMealTab('mid','HB',this)">HB</button>
          <button class="meal-tab" onclick="switchMealTab('mid','FB',this)">FB</button>
          <button class="meal-tab" onclick="switchMealTab('mid','AI',this)">AI</button>
        </div>
        <div id="mid-meal-panels">
          <div class="meal-panel active" id="mid-RO-panel"><div class="form-grid">
            <div class="section-divider">☀️ Mid · RO ($/ночь)</div>
            <div class="fg"><label>SGL</label><input id="r-mid-RO-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-mid-RO-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-mid-RO-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-mid-RO-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-mid-RO-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-mid-RO-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-mid-RO-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-mid-RO-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-mid-RO-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-mid-RO-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-mid-RO-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-mid-RO-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="mid-BB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">☀️ Mid · BB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-mid-BB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-mid-BB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-mid-BB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-mid-BB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-mid-BB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-mid-BB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-mid-BB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-mid-BB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-mid-BB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-mid-BB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-mid-BB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-mid-BB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="mid-HB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">☀️ Mid · HB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-mid-HB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-mid-HB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-mid-HB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-mid-HB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-mid-HB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-mid-HB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-mid-HB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-mid-HB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-mid-HB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-mid-HB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-mid-HB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-mid-HB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="mid-FB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">☀️ Mid · FB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-mid-FB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-mid-FB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-mid-FB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-mid-FB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-mid-FB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-mid-FB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-mid-FB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-mid-FB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-mid-FB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-mid-FB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-mid-FB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-mid-FB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="mid-AI-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">☀️ Mid · AI — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-mid-AI-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-mid-AI-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-mid-AI-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-mid-AI-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-mid-AI-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-mid-AI-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-mid-AI-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-mid-AI-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-mid-AI-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-mid-AI-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-mid-AI-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-mid-AI-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
        </div>
      </div>

      <!-- ── HIGH SEASON ── -->
      <div class="season-panel" id="rmpanel-high" style="padding-top:14px">
        <div class="season-info">🔥 <strong>High Season</strong> — высокий сезон.</div>
        <div class="form-grid" style="margin-bottom:10px">
          <div class="fg"><label>📅 Дата начала</label><input id="r-high-from" type="date"></div>
          <div class="fg"><label>📅 Дата окончания</label><input id="r-high-to" type="date"></div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          <button class="meal-tab active" onclick="switchMealTab('high','RO',this)">RO</button>
          <button class="meal-tab" onclick="switchMealTab('high','BB',this)">BB</button>
          <button class="meal-tab" onclick="switchMealTab('high','HB',this)">HB</button>
          <button class="meal-tab" onclick="switchMealTab('high','FB',this)">FB</button>
          <button class="meal-tab" onclick="switchMealTab('high','AI',this)">AI</button>
        </div>
        <div id="high-meal-panels">
          <div class="meal-panel active" id="high-RO-panel"><div class="form-grid">
            <div class="section-divider">🔥 High · RO ($/ночь)</div>
            <div class="fg"><label>SGL</label><input id="r-high-RO-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-high-RO-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-high-RO-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-high-RO-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-high-RO-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-high-RO-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-high-RO-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-high-RO-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-high-RO-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-high-RO-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-high-RO-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-high-RO-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="high-BB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🔥 High · BB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-high-BB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-high-BB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-high-BB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-high-BB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-high-BB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-high-BB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-high-BB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-high-BB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-high-BB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-high-BB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-high-BB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-high-BB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="high-HB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🔥 High · HB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-high-HB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-high-HB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-high-HB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-high-HB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-high-HB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-high-HB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-high-HB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-high-HB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-high-HB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-high-HB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-high-HB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-high-HB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="high-FB-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🔥 High · FB — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-high-FB-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-high-FB-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-high-FB-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-high-FB-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-high-FB-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-high-FB-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-high-FB-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-high-FB-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-high-FB-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-high-FB-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-high-FB-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-high-FB-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
          <div class="meal-panel" id="high-AI-panel" style="display:none"><div class="form-grid">
            <div class="section-divider">🔥 High · AI — доплата к RO ($/ночь/чел.)</div>
            <div class="fg"><label>SGL</label><input id="r-high-AI-sgl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>DBL</label><input id="r-high-AI-dbl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>TPL</label><input id="r-high-AI-tpl" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label>4 PAX</label><input id="r-high-AI-4pax" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (no eb)</label><input id="r-high-AI-dbl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF (1 eb)</label><input id="r-high-AI-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+CHD</label><input id="r-high-AI-dbl-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2INF</label><input id="r-high-AI-dbl-2inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+INF+CHD</label><input id="r-high-AI-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">DBL+2CHD</label><input id="r-high-AI-dbl-2chd" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+INF</label><input id="r-high-AI-tpl-inf" type="number" min="0" placeholder="—"></div>
            <div class="fg"><label style="font-size:10px">TPL+2INF</label><input id="r-high-AI-tpl-2inf" type="number" min="0" placeholder="—"></div>
          </div></div>
        </div>
      </div>

      <!-- ── ДОПЛАТЫ ── -->
      <div class="season-panel" id="rmpanel-surcharge" style="padding-top:14px">
        <div class="season-info surcharge-info">🎄 Доплата прибавляется к сезонной цене в праздничные даты ($/ночь на номер).</div>
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:16px">
          <div style="background:var(--sand);border-radius:10px;padding:14px">
            <div style="font-size:13px;font-weight:600;color:var(--coral);margin-bottom:10px">🎄 Рождество (Christmas)</div>
            <div class="form-grid">
              <div class="fg"><label>📅 Дата начала</label><input id="r-xmas-from" type="date"></div>
              <div class="fg"><label>📅 Дата окончания</label><input id="r-xmas-to" type="date"></div>
              <div class="fg"><label>Доплата SGL ($/ночь)</label><input id="r-xmas-sgl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата DBL ($/ночь)</label><input id="r-xmas-dbl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата TPL ($/ночь)</label><input id="r-xmas-tpl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата 4 PAX ($/ночь)</label><input id="r-xmas-4pax" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
            </div>
          </div>
          <div style="background:var(--sand);border-radius:10px;padding:14px">
            <div style="font-size:13px;font-weight:600;color:var(--coral);margin-bottom:10px">🎆 Новый год (New Year)</div>
            <div class="form-grid">
              <div class="fg"><label>📅 Дата начала</label><input id="r-ny-from" type="date"></div>
              <div class="fg"><label>📅 Дата окончания</label><input id="r-ny-to" type="date"></div>
              <div class="fg"><label>Доплата SGL ($/ночь)</label><input id="r-ny-sgl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата DBL ($/ночь)</label><input id="r-ny-dbl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата TPL ($/ночь)</label><input id="r-ny-tpl" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
              <div class="fg"><label>Доплата 4 PAX ($/ночь)</label><input id="r-ny-4pax" type="number" min="0" placeholder="—" style="color:var(--coral)"></div>
            </div>
          </div>
        </div>
      </div>

    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="closeModal('modal-room')">Отмена</button>
      <button class="btn btn-green" id="save-room-btn" onclick="saveRoom()">Сохранить</button>
    </div>
  </div>
</div>

<!-- MODAL: API Key -->
<div class="overlay" id="modal-key">
  <div class="modal">
    <div class="modal-head"><div class="modal-title">Выдать API-ключ</div><button class="modal-close" onclick="closeModal('modal-key')">✕</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="fg full"><label>Название компании *</label><input id="k-company" placeholder="TUI Russia"></div>
        <div class="fg full"><label>Email *</label><input id="k-email" type="email" placeholder="api@company.com"></div>
        <div class="fg"><label>Тарифный план</label>
          <select id="k-plan"><option value="free">Free (1 000 req/день)</option><option value="business">Business ($49/мес)</option><option value="enterprise">Enterprise</option></select>
        </div>
        <div class="fg"><label>Webhook URL (опционально)</label><input id="k-webhook" placeholder="https://yoursite.com/webhook"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="closeModal('modal-key')">Отмена</button>
      <button class="btn btn-green" onclick="saveKey()">Создать ключ</button>
    </div>
  </div>
</div>

<!-- MODAL: Season/Period -->
<div class="overlay" id="modal-season">
  <div class="modal" style="max-width:560px">
    <div class="modal-head"><div class="modal-title" id="modal-season-title">Добавить период</div><button class="modal-close" onclick="closeModal('modal-season')">✕</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="fg full"><label>Название *</label><input id="s-name" placeholder="напр. High Season 2026"></div>
        <div class="fg"><label>Тип *</label>
          <select id="s-type" onchange="toggleSurchargeField()">
            <option value="season">🌞 Сезон (свои цены)</option>
            <option value="surcharge">🎄 Доплата (праздник)</option>
          </select>
        </div>
        <input type="hidden" id="s-hotel">
        <div class="fg"><label>Дата начала *</label><input id="s-from" type="date"></div>
        <div class="fg"><label>Дата окончания *</label><input id="s-to" type="date"></div>
        <div class="fg" id="s-surcharge-wrap"><label>Доплата $/ночь</label><input id="s-surcharge" type="number" min="0" placeholder="напр. 30"></div>
        <div class="section-divider" id="s-prices-divider">💰 Цены сезона (опционально — перезаписывают базовые)</div>
        <div class="fg"><label>SGL</label><input id="s-price-sgl" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label>DBL</label><input id="s-price-dbl" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label>TPL</label><input id="s-price-tpl" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label>4 PAX</label><input id="s-price-4pax" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+INF (no ex.bed)</label><input id="s-price-dbl-inf" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+INF (1 ex.bed)</label><input id="s-price-dbl-inf-eb" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+CHD (1 ex.bed)</label><input id="s-price-dbl-chd" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+2INF (1 ex.bed)</label><input id="s-price-dbl-2inf" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+INF+CHD (ex.bed)</label><input id="s-price-dbl-inf-chd" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">DBL+2CHD (1 ex.bed)</label><input id="s-price-dbl-2chd" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">TPL+INF (no ex.bed)</label><input id="s-price-tpl-inf" type="number" min="0" placeholder="—"></div>
        <div class="fg"><label style="font-size:11px">TPL+2INF (no ex.bed)</label><input id="s-price-tpl-2inf" type="number" min="0" placeholder="—"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" onclick="closeModal('modal-season')">Отмена</button>
      <button class="btn btn-green" id="save-season-btn" onclick="saveSeason()">Сохранить</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script><script>
// ═══════════════════════════════
// API CLIENT
// ═══════════════════════════════
const API = {
  async get(url) { const r=await fetch(url); if(!r.ok)throw new Error((await r.json()).error||r.statusText); return r.json(); },
  async post(url,data) { const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if(!r.ok)throw new Error((await r.json()).error||r.statusText); return r.json(); },
  async put(url,data) { const r=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if(!r.ok)throw new Error((await r.json()).error||r.statusText); return r.json(); },
  async patch(url,data) { const r=await fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})}); if(!r.ok)throw new Error((await r.json()).error||r.statusText); return r.json(); },
  async del(url) { const r=await fetch(url,{method:'DELETE'}); if(!r.ok)throw new Error((await r.json()).error||r.statusText); return r.json(); }
};

// STATE
let hotelsCache=[], roomsCache=[], editingId={hotel:null,room:null};
const PER_PAGE=25;
let hotelsPage=1, roomsPage=1, hotelsFiltered=[], roomsFiltered=[], pricesFiltered=[];

// AUTH
function doLogin() {
  const e=document.getElementById('login-email').value;
  const p=document.getElementById('login-pass').value;
  if(e==='admin@staydirect.pro'&&p==='staydirect2026'){
    document.getElementById('login-screen').style.display='none';
    document.getElementById('app').style.display='block';
    loadDashboard();
  } else { showToast('Неверный email или пароль','error'); }
}
function doLogout(){ document.getElementById('app').style.display='none'; document.getElementById('login-screen').style.display='flex'; }

// NAVIGATION
const pageTitles={dashboard:'Дашборд',hotels:'Отели',rooms:'Номера',prices:'Цены','hotel-detail':'Отель',keys:'API ключи',bookings:'Бронирования',log:'Статистика'};
function showPage(p,el){
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+p).classList.add('active');
  document.getElementById('page-title').textContent=pageTitles[p]||p;
  if(el)el.classList.add('active');
  loadPage(p);
}
function loadPage(p){
  if(p==='dashboard')loadDashboard();
  else if(p==='hotels')loadHotels();
  else if(p==='rooms')loadRooms();
  else if(p==='prices')loadPrices();
  else if(p==='hotel-detail')loadHotelDetail(currentHotelDetailId);
  else if(p==='keys')loadKeys();
  else if(p==='bookings')loadBookings();
  else if(p==='log')loadLog();
}

// HELPERS
function hotelById(id){ return hotelsCache.find(h=>h.id===id); }
function roomsByHotel(hid){ return roomsCache.filter(r=>r.hotelId===hid&&r.status==='active'); }
function minPrice(hid){ const r=roomsByHotel(hid); return r.length?Math.min(...r.map(x=>x.price)):0; }
function genKey(){ return 'sk_live_'+Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10); }
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function updatePhotoPreview(url){
  const wrap=document.getElementById('h-photo-preview');
  if(url&&url.startsWith('http')){ wrap.style.display='block'; wrap.querySelector('img').src=url; }
  else{ wrap.style.display='none'; }
}
document.addEventListener('DOMContentLoaded',()=>{
  const pi=document.getElementById('h-photo');
  if(pi)pi.addEventListener('input',e=>updatePhotoPreview(e.target.value));
});

function renderPagination(containerId,totalItems,currentPage,onPageChange){
  const totalPages=Math.ceil(totalItems/PER_PAGE);
  const c=document.getElementById(containerId);
  if(totalPages<=1){c.innerHTML='';return;}
  let html=\`<button class="page-btn" \${currentPage===1?'disabled':''} onclick="\${onPageChange}(\${currentPage-1})">←</button>\`;
  const start=Math.max(1,currentPage-2),end=Math.min(totalPages,currentPage+2);
  if(start>1)html+=\`<button class="page-btn" onclick="\${onPageChange}(1)">1</button>\`;
  if(start>2)html+=\`<span class="page-info">…</span>\`;
  for(let i=start;i<=end;i++)html+=\`<button class="page-btn \${i===currentPage?'active':''}" onclick="\${onPageChange}(\${i})">\${i}</button>\`;
  if(end<totalPages-1)html+=\`<span class="page-info">…</span>\`;
  if(end<totalPages)html+=\`<button class="page-btn" onclick="\${onPageChange}(\${totalPages})">\${totalPages}</button>\`;
  html+=\`<button class="page-btn" \${currentPage===totalPages?'disabled':''} onclick="\${onPageChange}(\${currentPage+1})">→</button>\`;
  html+=\`<span class="page-info">\${totalItems} записей</span>\`;
  c.innerHTML=html;
}

// ═══════════════════════════════
// SEASON TABS IN ROOM MODAL
// ═══════════════════════════════
// Переключение вкладки питания внутри сезона
function switchMealTab(season, meal, btn) {
  const container = document.getElementById(season + "-meal-panels");
  if (!container) return;
  container.querySelectorAll(".meal-panel").forEach(p => p.style.display = "none");
  const panel = document.getElementById(season + "-" + meal + "-panel");
  if (panel) panel.style.display = "block";
  // update tab buttons
  const tabsEl = btn.closest(".season-panel, [id^=rmpanel]");
  if (tabsEl) tabsEl.querySelectorAll(".meal-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
}

function switchRmSeasonTab(tab){
  ['base','low','mid','high','surcharge'].forEach(t=>{
    document.getElementById('rmstab-'+t).classList.toggle('active',t===tab);
    document.getElementById('rmpanel-'+t).classList.toggle('active',t===tab);
  });
}

// Конфигурация полей цен для каждого сезона
const SEASON_ACCOM_KEYS=[
  {suffix:'sgl',key:'SGL'},{suffix:'dbl',key:'DBL'},{suffix:'tpl',key:'TPL'},{suffix:'4pax',key:'4PAX'},
  {suffix:'dbl-inf',key:'DBL_INF'},{suffix:'dbl-inf-eb',key:'DBL_INF_EB'},{suffix:'dbl-chd',key:'DBL_CHD'},
  {suffix:'dbl-2inf',key:'DBL_2INF'},{suffix:'dbl-inf-chd',key:'DBL_INF_CHD'},{suffix:'dbl-2chd',key:'DBL_2CHD'},
  {suffix:'tpl-inf',key:'TPL_INF'},{suffix:'tpl-2inf',key:'TPL_2INF'}
];

function getSeasonPrices(prefix){
  const p={};
  SEASON_ACCOM_KEYS.forEach(f=>{
    const el=document.getElementById(\`r-\${prefix}-\${f.suffix}\`);
    if(el){const v=parseFloat(el.value);if(v>0)p[f.key]=v;}
  });
  return p;
}

function setSeasonPrices(prefix,prices){
  let p={};
  try{p=typeof prices==='string'?JSON.parse(prices||'{}'):(prices||{});}catch(e){}
  // handle nested format
  const keys=Object.keys(p);
  if(keys.length>0&&typeof p[keys[0]]==='object'&&p[keys[0]]!==null){
    p=p.BB||p[keys[0]]||{};
  }
  SEASON_ACCOM_KEYS.forEach(f=>{
    const el=document.getElementById(\`r-\${prefix}-\${f.suffix}\`);
    if(el)el.value=p[f.key]||'';
  });
}

function clearSeasonPrices(prefix){
  SEASON_ACCOM_KEYS.forEach(f=>{
    const el=document.getElementById(\`r-\${prefix}-\${f.suffix}\`);
    if(el)el.value='';
  });
}

function hasSeasonData(prefix){
  return SEASON_ACCOM_KEYS.some(f=>{
    const el=document.getElementById(\`r-\${prefix}-\${f.suffix}\`);
    return el&&parseFloat(el.value)>0;
  });
}

function updateRmTabIndicators(){
  ['low','mid','high'].forEach(p=>{
    const btn=document.getElementById('rmstab-'+p);
    if(btn)btn.classList.toggle('has-data',hasSeasonData(p));
  });
  // surcharge indicator
  const btn=document.getElementById('rmstab-surcharge');
  if(btn){
    const xmas=parseFloat(document.getElementById('r-xmas-surcharge').value)||0;
    const ny=parseFloat(document.getElementById('r-ny-surcharge').value)||0;
    btn.classList.toggle('has-data',xmas>0||ny>0);
  }
}

// обновляем индикаторы при вводе
document.addEventListener('input',e=>{
  if(e.target.closest('#modal-room'))updateRmTabIndicators();
});

// ═══════════════════════════════
// DASHBOARD
// ═══════════════════════════════
async function loadDashboard(){
  document.getElementById('topbar-date').textContent=new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  try{
    const[stats,hotels,rooms,bookings]=await Promise.all([
      API.get('/api/admin/stats'),API.get('/api/admin/hotels'),
      API.get('/api/admin/rooms'),API.get('/api/admin/bookings')
    ]);
    hotelsCache=hotels; roomsCache=rooms;
    document.getElementById('kpi-h').textContent=stats.hotels;
    document.getElementById('kpi-r').textContent=stats.rooms;
    document.getElementById('kpi-o').textContent=stats.keys;
    document.getElementById('kpi-b').textContent=stats.bookings;
    document.getElementById('dash-table').innerHTML=hotels.slice(0,5).map(h=>\`
      <tr>
        <td><strong>\${h.photo?'<img src="'+escHtml(h.photo)+'" style="width:32px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px">':escHtml(h.emoji)+' '}\${escHtml(h.name)}</strong></td>
        <td>\${escHtml(h.loc)}</td><td>\${roomsByHotel(h.id).length}</td>
        <td><strong style="color:var(--teal)">$\${minPrice(h.id)}/ночь</strong></td>
        <td><span class="badge badge-\${h.status==='active'?'green':'amber'}">\${h.status==='active'?'Активен':'Скрыт'}</span></td>
      </tr>\`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Нет отелей</td></tr>';
    document.getElementById('book-dash-table').innerHTML=bookings.length
      ?bookings.slice(0,5).map(b=>\`
        <tr>
          <td><code style="font-size:11px">\${escHtml(b.ref)}</code></td>
          <td>\${escHtml(b.hotelName)}</td><td>\${escHtml(b.guestName)}</td><td>\${escHtml(b.checkin)}</td>
          <td><strong style="color:var(--teal)">$\${b.totalUsd}</strong></td>
          <td><span class="badge badge-green">Подтверждено</span></td>
        </tr>\`).join('')
      :'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Бронирований пока нет</td></tr>';
  }catch(err){showToast('Ошибка загрузки: '+err.message,'error');}
}

// ═══════════════════════════════
// HOTELS
// ═══════════════════════════════
async function loadHotels(){
  try{
    hotelsCache=await API.get('/api/admin/hotels');
    roomsCache=await API.get('/api/admin/rooms');
    hotelsFiltered=[...hotelsCache]; hotelsPage=1; renderHotelsPage();
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
function filterHotels(){
  const q=document.getElementById('hotel-search').value.toLowerCase();
  hotelsFiltered=hotelsCache.filter(h=>h.name.toLowerCase().includes(q)||h.loc.toLowerCase().includes(q)||(h.region||'').toLowerCase().includes(q));
  hotelsPage=1; renderHotelsPage();
}
function goHotelsPage(p){hotelsPage=p;renderHotelsPage();}
function renderHotelsPage(){
  const start=(hotelsPage-1)*PER_PAGE,slice=hotelsFiltered.slice(start,start+PER_PAGE);
  document.getElementById('hotels-table').innerHTML=slice.map(h=>\`
    <tr>
      <td><strong>\${h.photo?'<img src="'+escHtml(h.photo)+'" style="width:40px;height:30px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:8px">':escHtml(h.emoji)+' '}\${escHtml(h.name)}</strong></td>
      <td>\${escHtml(h.loc)}</td><td>★ \${h.rating}</td><td>\${roomsByHotel(h.id).length}</td>
      <td><span class="badge badge-\${h.status==='active'?'green':'amber'}">\${h.status==='active'?'Активен':'Скрыт'}</span></td>
      <td><div class="actions-cell">
        <button class="btn btn-green btn-sm" onclick="openHotelDetail(\${h.id})">Номера</button>
        <button class="btn btn-outline btn-sm" onclick="editHotel(\${h.id})">Изменить</button>
        <button class="btn btn-sm" style="background:var(--\${h.status==='active'?'amber-l':'teal-l'});color:var(--\${h.status==='active'?'amber':'teal'});border:1px solid var(--border2)" onclick="toggleHotel(\${h.id})">\${h.status==='active'?'Скрыть':'Показать'}</button>
      </div></td>
    </tr>\`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Ничего не найдено</td></tr>';
  renderPagination('hotels-pagination',hotelsFiltered.length,hotelsPage,'goHotelsPage');
}
function openHotelModal(id=null){
  editingId.hotel=id;
  document.getElementById('modal-hotel-title').textContent=id?'Изменить отель':'Добавить отель';
  if(id){
    const h=hotelById(id);
    document.getElementById('h-name').value=h.name;
    document.getElementById('h-loc').value=h.loc;
    document.getElementById('h-region').value=h.region||'Southern';
    document.getElementById('h-rating').value=h.rating;
    document.getElementById('h-emoji').value=h.emoji||'';
    document.getElementById('h-photo').value=h.photo||'';
    updatePhotoPreview(h.photo);
    document.getElementById('h-address').value=h.address||'';
    document.getElementById('h-amenities').value=h.amenities||'';
    document.getElementById('h-desc').value=h.desc||'';
  }else{
    ['h-name','h-address','h-amenities','h-desc','h-photo'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('h-rating').value='';
    document.getElementById('h-emoji').value='🏨';
    updatePhotoPreview('');
  }
  document.getElementById('modal-hotel').classList.add('open');
}
function editHotel(id){openHotelModal(id);}
async function saveHotel(){
  const name=document.getElementById('h-name').value.trim();
  if(!name){showToast('Введите название отеля','error');return;}
  const data={name,loc:document.getElementById('h-loc').value,region:document.getElementById('h-region').value,rating:parseFloat(document.getElementById('h-rating').value)||8.0,emoji:document.getElementById('h-emoji').value||'🏨',photo:document.getElementById('h-photo').value||'',address:document.getElementById('h-address').value,amenities:document.getElementById('h-amenities').value,desc:document.getElementById('h-desc').value,status:'active'};
  try{
    const btn=document.getElementById('save-hotel-btn');
    btn.disabled=true;btn.textContent='Сохранение...';
    if(editingId.hotel){await API.put('/api/admin/hotels/'+editingId.hotel,data);showToast('Отель обновлён!','success');}
    else{await API.post('/api/admin/hotels',data);showToast('Отель добавлен!','success');}
    closeModal('modal-hotel');btn.disabled=false;btn.textContent='Сохранить';loadHotels();
  }catch(err){
    document.getElementById('save-hotel-btn').disabled=false;
    document.getElementById('save-hotel-btn').textContent='Сохранить';
    showToast('Ошибка: '+err.message,'error');
  }
}
async function toggleHotel(id){
  try{await API.patch('/api/admin/hotels/'+id+'/toggle');showToast('Статус обновлён','success');loadHotels();}
  catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// ROOMS
// ═══════════════════════════════
async function loadRooms(){
  try{
    roomsCache=await API.get('/api/admin/rooms');
    hotelsCache=await API.get('/api/admin/hotels');
    const sel=document.getElementById('rooms-hotel-filter');
    const prev=sel.value;
    sel.innerHTML='<option value="">Все отели</option>'+hotelsCache.map(h=>\`<option value="\${h.id}">\${escHtml(h.name)}</option>\`).join('');
    if(prev)sel.value=prev;
    roomsFiltered=[...roomsCache];roomsPage=1;filterRooms();
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
function filterRooms(){
  const q=document.getElementById('room-search').value.toLowerCase();
  const hotelFilter=document.getElementById('rooms-hotel-filter').value;
  roomsFiltered=roomsCache.filter(r=>{
    if(hotelFilter&&r.hotelId!==parseInt(hotelFilter))return false;
    const h=hotelById(r.hotelId);
    return r.type.toLowerCase().includes(q)||(h&&h.name.toLowerCase().includes(q));
  });
  roomsPage=1;renderRoomsPage();
}
function goRoomsPage(p){roomsPage=p;renderRoomsPage();}

function parsePrices(r){try{return typeof r.prices==='string'?JSON.parse(r.prices||'{}'):(r.prices||{});}catch(e){return{};}}
function parseFlatPrices(r){
  const p=parsePrices(r);const keys=Object.keys(p);if(!keys.length)return{};
  const first=p[keys[0]];if(typeof first==='object'&&first!==null)return p.BB||p[keys[0]]||{};
  return p;
}
function formatPricesSummary(r){
  const p=parseFlatPrices(r);const keys=Object.keys(p);
  if(!keys.length)return\`<strong style="color:var(--teal)">$\${r.price}</strong>/ночь\`;
  const main=['SGL','DBL','TPL','4PAX'].filter(k=>p[k]);
  const parts=main.map(k=>\`<span style="font-size:11px;color:var(--muted)">\${k}</span> <strong style="color:var(--teal)">$\${p[k]}</strong>\`);
  const extra=keys.length-main.length;if(extra>0)parts.push(\`<span style="font-size:10px;color:var(--muted)">+\${extra}</span>\`);
  return parts.join(' · ');
}

function renderRoomsPage(){
  const start=(roomsPage-1)*PER_PAGE,slice=roomsFiltered.slice(start,start+PER_PAGE);
  document.getElementById('rooms-table').innerHTML=slice.map(r=>{
    const h=hotelById(r.hotelId);
    return\`<tr>
      <td>\${h?escHtml(h.name):'—'}</td>
      <td><strong>\${escHtml(r.type)}</strong></td>
      <td>\${escHtml(r.view)}</td><td>\${r.capacity} чел.</td>
      <td style="font-size:12px">\${formatPricesSummary(r)}</td>
      <td><span class="badge badge-\${r.status==='active'?'green':'amber'}">\${r.status==='active'?'Активен':'Скрыт'}</span></td>
      <td><div class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="editRoom(\${r.id})">Изменить</button>
        <button class="btn btn-red btn-sm" onclick="deleteRoom(\${r.id})">Удалить</button>
      </div></td>
    </tr>\`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Ничего не найдено</td></tr>';
  renderPagination('rooms-pagination',roomsFiltered.length,roomsPage,'goRoomsPage');
  document.getElementById('rm-rooms-count').textContent='('+roomsFiltered.length+')';
}

let rmSeasonsCache=[];
function onRoomsHotelChange(){
  const sel=document.getElementById('rooms-hotel-filter');
  const hid=sel.value;
  const tabsEl=document.getElementById('rooms-tabs');
  if(hid){
    tabsEl.style.display='';
    currentHotelDetailId=parseInt(hid);
    filterRooms();loadRmSeasons(parseInt(hid));loadPriceMatrix(parseInt(hid));switchRoomsTab('matrix');
  }else{
    tabsEl.style.display='none';currentHotelDetailId=null;filterRooms();
    document.getElementById('rm-seasons-count').textContent='';
    document.getElementById('rm-tab-rooms').style.display='';
    document.getElementById('rm-tab-matrix').style.display='none';
    document.getElementById('rm-tab-seasons').style.display='none';
  }
}
function switchRoomsTab(tab){
  ['matrix','rooms','seasons'].forEach(t=>{
    const el=document.getElementById('rm-tab-'+t),btn=document.getElementById('tab-rm-'+t);
    if(el)el.style.display=(t===tab)?'':'none';
    if(btn)btn.classList.toggle('active',t===tab);
  });
  if(tab==='matrix'&&currentHotelDetailId)loadPriceMatrix(currentHotelDetailId);
}
async function loadRmSeasons(hotelId){
  try{
    const all=await API.get('/api/admin/rate-periods');
    rmSeasonsCache=all.filter(s=>s.hotelId===hotelId);renderRmSeasons();
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
function renderRmSeasons(){
  const typeLabels={season:'🌞 Сезон',surcharge:'🎄 Доплата'};
  const typeColors={season:'green',surcharge:'amber'};
  document.getElementById('rm-seasons-count').textContent='('+rmSeasonsCache.length+')';
  document.getElementById('rm-seasons-table').innerHTML=rmSeasonsCache.length?rmSeasonsCache.map(s=>{
    const today=new Date().toISOString().split('T')[0];
    const isActive=s.status==='active'&&s.dateFrom<=today&&s.dateTo>=today;
    return\`<tr>
      <td><strong>\${escHtml(s.name)}</strong></td>
      <td><span class="badge badge-\${typeColors[s.type]||'green'}">\${typeLabels[s.type]||s.type}</span></td>
      <td style="font-size:12px;white-space:nowrap">\${s.dateFrom} → \${s.dateTo}</td>
      <td>\${s.type==='surcharge'?'<strong style="color:var(--coral)">+$'+s.surcharge+'/ночь</strong>':'—'}</td>
      <td><span class="badge badge-\${isActive?'green':s.status==='active'?'amber':'red'}">\${isActive?'Активен':s.status==='active'?'Ожидает':'Откл.'}</span></td>
      <td><div class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="editSeason(\${s.id})">Изменить</button>
        <button class="btn btn-red btn-sm" onclick="deleteSeason(\${s.id})">Удалить</button>
      </div></td>
    </tr>\`;
  }).join(''):'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Нет периодов.</td></tr>';
}

// Base price fields (legacy format)
const PRICE_FIELDS=[
  {id:'r-base-RO-sgl',key:'SGL'},{id:'r-base-RO-dbl',key:'DBL'},{id:'r-base-RO-tpl',key:'TPL'},{id:'r-base-RO-4pax',key:'4PAX'},
  {id:'r-base-RO-dbl-inf',key:'DBL_INF'},{id:'r-base-RO-dbl-inf-eb',key:'DBL_INF_EB'},{id:'r-base-RO-dbl-chd',key:'DBL_CHD'},
  {id:'r-base-RO-dbl-2inf',key:'DBL_2INF'},{id:'r-base-RO-dbl-inf-chd',key:'DBL_INF_CHD'},{id:'r-base-RO-dbl-2chd',key:'DBL_2CHD'},
  {id:'r-base-RO-tpl-inf',key:'TPL_INF'},{id:'r-base-RO-tpl-2inf',key:'TPL_2INF'},
];
function getPricesFromForm(){
  const p={};
  PRICE_FIELDS.forEach(f=>{const el=document.getElementById(f.id);if(el){const v=parseFloat(el.value);if(v>0)p[f.key]=v;}});
  return p;
}
function setPricesInForm(prices){
  let p={};try{p=typeof prices==='string'?JSON.parse(prices||'{}'):(prices||{});}catch(e){}
  const keys=Object.keys(p);
  if(keys.length>0&&typeof p[keys[0]]==='object'&&p[keys[0]]!==null)p=p.RO||p.BB||p[keys[0]]||{};
  PRICE_FIELDS.forEach(f=>{const el=document.getElementById(f.id);if(el)el.value=p[f.key]||'';});
}

function openRoomModal(id=null){
  editingId.room=id;
  const sel=document.getElementById('r-hotel');
  sel.innerHTML=hotelsCache.map(h=>\`<option value="\${h.id}">\${escHtml(h.name)}</option>\`).join('');
  document.getElementById('modal-room-title').textContent=id?'Изменить номер':'Добавить номер';

  // Reset all season tabs to base
  switchRmSeasonTab('base');

  if(id){
    const r=roomsCache.find(x=>x.id===id);
    sel.value=r.hotelId;
    document.getElementById('r-type').value=r.type;
    document.getElementById('r-view').value=r.view;
    document.getElementById('r-capacity').value=r.capacity;
    document.getElementById('r-minnights').value=r.minNights;
    document.getElementById('r-breakfast').value=r.breakfast;
    document.getElementById('r-cancel').value=r.cancel;
    setPricesInForm(r.prices);
    if((!r.prices||r.prices==='{}')&&r.price>0){const el=document.getElementById('r-base-RO-dbl');if(el)el.value=r.price;}

    // Load season prices if they exist for this hotel
    loadRoomSeasonPrices(r.hotelId);
  }else{
    document.getElementById('r-type').value='';
    document.getElementById('r-view').value='';
    document.getElementById('r-capacity').value='2';
    document.getElementById('r-minnights').value='1';
    PRICE_FIELDS.forEach(f=>{const el=document.getElementById(f.id);if(el)el.value='';});
    ['low','mid','high'].forEach(p=>clearSeasonPrices(p));
    ['r-xmas-sgl','r-xmas-dbl','r-xmas-tpl','r-xmas-4pax','r-ny-sgl','r-ny-dbl','r-ny-tpl','r-ny-4pax','r-xmas-from','r-xmas-to','r-ny-from','r-ny-to'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    if(currentHotelDetailId){
      sel.value=currentHotelDetailId;
      loadRoomSeasonPrices(currentHotelDetailId);
    }
  }
  updateRmTabIndicators();
  document.getElementById('modal-room').classList.add('open');
}
function editRoom(id){openRoomModal(id);}

// Загрузить сезонные цены для отеля и заполнить поля
async function loadRoomSeasonPrices(hotelId){
  try{
    const all=await API.get('/api/admin/rate-periods');
    const seasons=all.filter(s=>s.hotelId===hotelId&&s.status==='active');
    // Find Low, Mid, High by name convention
    const findSeason=(keywords)=>seasons.find(s=>s.type==='season'&&keywords.some(kw=>s.name.toLowerCase().includes(kw)));
    const low=findSeason(['low']);
    const mid=findSeason(['mid']);
    const high=findSeason(['high','peak']);
    if(low)setSeasonPrices('low',low.prices);else clearSeasonPrices('low');
    if(mid)setSeasonPrices('mid',mid.prices);else clearSeasonPrices('mid');
    if(high)setSeasonPrices('high',high.prices);else clearSeasonPrices('high');
    // Surcharges
    const xmas=seasons.find(s=>s.type==='surcharge'&&(s.name.toLowerCase().includes('christmas')||s.name.toLowerCase().includes('xmas')||s.name.toLowerCase().includes('рождест')));
    const ny=seasons.find(s=>s.type==='surcharge'&&(s.name.toLowerCase().includes('new year')||s.name.toLowerCase().includes('новый')));
    document.getElementById('r-xmas-surcharge').value=xmas?xmas.surcharge:'';
    document.getElementById('r-ny-surcharge').value=ny?ny.surcharge:'';
    updateRmTabIndicators();
  }catch(e){/* silent */}
}

async function saveRoom(){
  const type=document.getElementById('r-type').value.trim();
  const prices=getPricesFromForm();
  const hasAnyPrice=Object.keys(prices).length>0;
  if(!type){showToast('Заполните тип номера','error');return;}
  if(!hasAnyPrice){showToast('Укажите хотя бы одну базовую цену','error');return;}
  const basePrice=prices.DBL||prices.SGL||Object.values(prices)[0]||0;
  const hotelId=parseInt(document.getElementById('r-hotel').value);
  const data={hotelId,type,view:document.getElementById('r-view').value,beds:'DBL',price:basePrice,prices,capacity:parseInt(document.getElementById('r-capacity').value)||2,minNights:parseInt(document.getElementById('r-minnights').value)||1,breakfast:document.getElementById('r-breakfast').value,cancel:parseInt(document.getElementById('r-cancel').value),status:'active'};
  try{
    const btn=document.getElementById('save-room-btn');
    btn.disabled=true;btn.textContent='Сохранение...';
    let roomId;
    if(editingId.room){await API.put('/api/admin/rooms/'+editingId.room,data);roomId=editingId.room;showToast('Номер обновлён!','success');}
    else{const res=await API.post('/api/admin/rooms',data);roomId=res.id;showToast('Номер добавлен!','success');}

    // Сохранить сезонные цены
    await saveRoomSeasonData(hotelId);

    closeModal('modal-room');btn.disabled=false;btn.textContent='Сохранить';
    await loadRooms();
    if(currentHotelDetailId&&document.getElementById('page-hotel-detail').classList.contains('active'))renderHdRooms(currentHotelDetailId);
  }catch(err){
    document.getElementById('save-room-btn').disabled=false;
    document.getElementById('save-room-btn').textContent='Сохранить';
    showToast('Ошибка: '+err.message,'error');
  }
}

// Сохранить данные сезонов из формы номера
async function saveRoomSeasonData(hotelId){
  try{
    const all=await API.get('/api/admin/rate-periods');
    const existing=all.filter(s=>s.hotelId===hotelId&&s.status==='active');

    const findAndUpdate=async(keywords,type,newPrices,newSurcharge)=>{
      const found=existing.find(s=>s.type===type&&keywords.some(kw=>s.name.toLowerCase().includes(kw)));
      const hasData=type==='season'?Object.keys(newPrices).length>0:(newSurcharge>0);
      if(!hasData)return;
      if(found){
        // update
        await API.put('/api/admin/rate-periods/'+found.id,{...found,prices:newPrices,surcharge:newSurcharge});
      }
      // if not found — don't auto-create seasons without dates (user can do it manually or via "Стандартные сезоны")
    };

    const lowPrices=getSeasonPrices('low');
    const midPrices=getSeasonPrices('mid');
    const highPrices=getSeasonPrices('high');
    const xmas=parseFloat(document.getElementById('r-xmas-surcharge').value)||0;
    const ny=parseFloat(document.getElementById('r-ny-surcharge').value)||0;

    await findAndUpdate(['low'],'season',lowPrices,0);
    await findAndUpdate(['mid'],'season',midPrices,0);
    await findAndUpdate(['high','peak'],'season',highPrices,0);
    await findAndUpdate(['christmas','xmas','рождест'],'surcharge',{},xmas);
    await findAndUpdate(['new year','новый'],'surcharge',{},ny);

    // Reload seasons display
    if(currentHotelDetailId){
      await loadRmSeasons(currentHotelDetailId);
      await loadHdSeasons(currentHotelDetailId);
    }
  }catch(e){/* silent - season save is optional */}
}

async function deleteRoom(id){
  if(!confirm('Удалить номер?'))return;
  try{
    await API.del('/api/admin/rooms/'+id);showToast('Номер удалён','success');
    await loadRooms();
    if(currentHotelDetailId&&document.getElementById('page-hotel-detail').classList.contains('active'))renderHdRooms(currentHotelDetailId);
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// PRICES
// ═══════════════════════════════
async function loadPrices(){
  try{roomsCache=await API.get('/api/admin/rooms');hotelsCache=await API.get('/api/admin/hotels');pricesFiltered=roomsCache.filter(r=>r.status==='active');renderPricesGrid();}
  catch(err){showToast('Ошибка: '+err.message,'error');}
}
function filterPrices(){
  const q=document.getElementById('price-search').value.toLowerCase();
  pricesFiltered=roomsCache.filter(r=>{if(r.status!=='active')return false;const h=hotelById(r.hotelId);return r.type.toLowerCase().includes(q)||(h&&h.name.toLowerCase().includes(q));});
  renderPricesGrid();
}
const PRICE_LABELS={SGL:'SGL',DBL:'DBL',TPL:'TPL','4PAX':'4 PAX',DBL_INF:'DBL+INF',DBL_INF_EB:'DBL+INF(eb)',DBL_CHD:'DBL+CHD',DBL_2INF:'DBL+2INF',DBL_INF_CHD:'DBL+INF+CHD',DBL_2CHD:'DBL+2CHD',TPL_INF:'TPL+INF',TPL_2INF:'TPL+2INF'};
function renderPricesGrid(){
  const show=pricesFiltered.slice(0,60);
  document.getElementById('prices-grid').innerHTML=show.map(r=>{
    const h=hotelById(r.hotelId);const p=parsePrices(r);const pKeys=Object.keys(p);
    const priceRows=pKeys.length?pKeys.map(k=>\`<div class="pc-price-row"><label>\${escHtml(PRICE_LABELS[k]||k)}</label><input class="price-input" type="number" min="0" value="\${p[k]}" data-room="\${r.id}" data-key="\${escHtml(k)}" onkeydown="if(event.key==='Enter')savePrices(\${r.id})"></div>\`).join('')
      :\`<div class="pc-price-row"><label>Цена/ночь</label><input class="price-input" type="number" min="1" value="\${r.price}" data-room="\${r.id}" data-key="_base" onkeydown="if(event.key==='Enter')savePrices(\${r.id})"></div>\`;
    return\`<div class="price-card">
      <div class="pc-hotel">\${h?(h.photo?'<img src="'+escHtml(h.photo)+'" style="width:28px;height:20px;object-fit:cover;border-radius:3px;vertical-align:middle;margin-right:4px">':escHtml(h.emoji)+' ')+escHtml(h.name):'—'}</div>
      <div class="pc-room">\${escHtml(r.type)}</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">\${escHtml(r.view)} · \${r.capacity} чел.</div>
      \${priceRows}
      <button class="pc-save" id="save-btn-\${r.id}" onclick="savePrices(\${r.id})">Сохранить</button>
    </div>\`;
  }).join('')||'<div class="loading-spinner">Ничего не найдено</div>';
  if(pricesFiltered.length>60)document.getElementById('prices-grid').innerHTML+=\`<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:16px;font-size:13px">Показано 60 из \${pricesFiltered.length}.</div>\`;
}
async function savePrices(id){
  const inputs=document.querySelectorAll(\`input[data-room="\${id}"]\`);
  const prices={};let basePrice=0;
  inputs.forEach(inp=>{const k=inp.dataset.key,v=parseFloat(inp.value);if(k==='_base'){basePrice=v;}else if(v>0){prices[k]=v;}});
  if(!basePrice)basePrice=prices.DBL||prices.SGL||Object.values(prices)[0]||0;
  if(!basePrice&&!Object.keys(prices).length){showToast('Укажите хотя бы одну цену','error');return;}
  try{
    await API.put('/api/admin/rooms/'+id,{price:basePrice,prices});
    const btn=document.getElementById('save-btn-'+id);
    btn.textContent='✓ Сохранено!';btn.className='pc-save pc-saved';
    setTimeout(()=>{btn.textContent='Сохранить';btn.className='pc-save';},2000);
    const room=roomsCache.find(r=>r.id===id);
    if(room){room.price=basePrice;room.prices=JSON.stringify(prices);}
    showToast('Цены обновлены','success');
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// API KEYS
// ═══════════════════════════════
async function loadKeys(){
  try{
    const keys=await API.get('/api/admin/keys');
    document.getElementById('keys-table').innerHTML=keys.map(k=>\`
      <tr>
        <td><strong>\${escHtml(k.company)}</strong></td>
        <td style="color:var(--muted)">\${escHtml(k.email)}</td>
        <td><code style="font-family:monospace;font-size:11px;background:var(--sand);padding:2px 8px;border-radius:4px">\${escHtml(k.key.slice(0,24))}...</code></td>
        <td><span class="badge badge-\${k.plan==='business'?'green':k.plan==='enterprise'?'amber':'red'}">\${escHtml(k.plan)}</span></td>
        <td>\${(k.today||0).toLocaleString()} / \${(k.limitReq||0).toLocaleString()}</td>
        <td><span class="badge badge-\${k.status==='active'?'green':'red'}">\${k.status==='active'?'Активен':'Отозван'}</span></td>
        <td>\${k.status==='active'?\`<button class="btn btn-red btn-sm" onclick="revokeKey(\${k.id})">Отозвать</button>\`:''}</td>
      </tr>\`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Нет API-ключей</td></tr>';
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
function openKeyModal(){['k-company','k-email','k-webhook'].forEach(i=>document.getElementById(i).value='');document.getElementById('modal-key').classList.add('open');}
async function saveKey(){
  const company=document.getElementById('k-company').value.trim();
  const email=document.getElementById('k-email').value.trim();
  if(!company||!email){showToast('Заполните компанию и email','error');return;}
  const plan=document.getElementById('k-plan').value;
  const limits={free:1000,business:50000,enterprise:9999999};
  try{
    await API.post('/api/admin/keys',{company,email,key:genKey(),plan,limitReq:limits[plan]||1000,webhook:document.getElementById('k-webhook').value});
    closeModal('modal-key');showToast('API-ключ создан и отправлен на '+email,'success');loadKeys();
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
async function revokeKey(id){
  if(!confirm('Отозвать ключ?'))return;
  try{await API.patch('/api/admin/keys/'+id+'/revoke');showToast('Ключ отозван','success');loadKeys();}
  catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// BOOKINGS
// ═══════════════════════════════
async function loadBookings(){
  try{
    const bookings=await API.get('/api/admin/bookings');
    document.getElementById('bookings-table').innerHTML=bookings.length
      ?bookings.map(b=>\`
        <tr>
          <td><code style="font-size:11px">\${escHtml(b.ref)}</code></td>
          <td>\${escHtml(b.hotelName)}<br><span style="font-size:11px;color:var(--muted)">\${escHtml(b.roomType)}</span></td>
          <td>\${escHtml(b.guestName)}<br><span style="font-size:11px;color:var(--muted)">\${escHtml(b.guestEmail)}</span></td>
          <td>\${escHtml(b.checkin)}</td><td>\${escHtml(b.checkout)}</td><td>\${b.nights}</td>
          <td><strong style="color:var(--teal)">$\${b.totalUsd}</strong></td>
          <td>\${escHtml(b.operator)||'—'}</td>
          <td><span class="badge badge-green">Подтверждено</span></td>
        </tr>\`).join('')
      :'<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:32px">Бронирований пока нет</td></tr>';
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// LOG
// ═══════════════════════════════
async function loadLog(){
  try{
    const[stats,logs]=await Promise.all([API.get('/api/admin/log/stats'),API.get('/api/admin/log')]);
    document.getElementById('log-req').textContent=stats.requests;
    document.getElementById('log-ops').textContent=stats.operators;
    document.getElementById('log-book').textContent=stats.bookings;
    document.getElementById('log-rev').textContent='$'+stats.revenue.toFixed(0);
    document.getElementById('log-table').innerHTML=logs.length
      ?logs.map(l=>\`
        <tr>
          <td style="font-family:monospace;font-size:12px">\${escHtml(l.time)}</td>
          <td>\${escHtml(l.operator)}</td>
          <td><span style="background:var(--teal-l);color:var(--teal);font-size:10px;padding:2px 8px;border-radius:4px;font-family:monospace">\${escHtml(l.method)}</span></td>
          <td style="font-family:monospace;font-size:12px">\${escHtml(l.endpoint)}</td>
          <td><span class="badge badge-\${l.statusCode===200?'green':'red'}">\${l.statusCode} \${l.statusCode===200?'OK':'ERR'}</span></td>
        </tr>\`).join('')
      :'<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Нет запросов</td></tr>';
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// HOTEL DETAIL
// ═══════════════════════════════
let currentHotelDetailId=null,hdSeasonsCache=[],editingSeasonId=null;

function openHotelDetail(hotelId){
  currentHotelDetailId=hotelId;showPage('hotel-detail',null);
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
}
async function loadHotelDetail(hotelId){
  if(!hotelId)return;
  const h=hotelById(hotelId);if(!h){await loadHotels();}
  const hotel=hotelById(hotelId);if(!hotel)return;
  document.getElementById('hd-hotel-name').textContent=hotel.name;
  document.getElementById('hd-hotel-loc').textContent='📍 '+hotel.loc+' · ★ '+hotel.rating;
  document.getElementById('page-title').textContent=hotel.name;
  renderHdRooms(hotelId);await loadHdSeasons(hotelId);
}
function switchHdTab(tab){
  document.getElementById('hd-tab-rooms').style.display=tab==='rooms'?'':'none';
  document.getElementById('hd-tab-seasons').style.display=tab==='seasons'?'':'none';
  document.getElementById('tab-hd-rooms').classList.toggle('active',tab==='rooms');
  document.getElementById('tab-hd-seasons').classList.toggle('active',tab==='seasons');
}
function renderHdRooms(hotelId){
  const rooms=roomsByHotel(hotelId);
  document.getElementById('hd-rooms-count').textContent='('+rooms.length+')';
  const ACCOM_KEYS=['SGL','DBL','TPL','4PAX','DBL_INF','DBL_INF_EB','DBL_CHD','DBL_2INF','DBL_INF_CHD','DBL_2CHD','TPL_INF','TPL_2INF'];
  document.getElementById('hd-rooms-table').innerHTML=rooms.length?rooms.map(r=>{
    const prices=parseFlatPrices(r);
    const pStr=ACCOM_KEYS.filter(k=>prices[k]).map(k=>k+' $'+prices[k]).join(' · ')||(r.price?'$'+r.price:'—');
    const bf=(r.breakfast==='1'||r.breakfast==='1.0')?'BB':(r.breakfast==='0'?'RO':(r.breakfast||'RO'));
    return\`<tr>
      <td><strong>\${escHtml(r.type)}</strong></td>
      <td>\${escHtml(r.view||'—')}</td><td>\${escHtml(bf)}</td><td>\${r.capacity||2}</td>
      <td style="font-size:12px">\${pStr}</td>
      <td><span class="badge badge-\${r.status==='active'?'green':'amber'}">\${r.status==='active'?'Активен':'Скрыт'}</span></td>
      <td><div class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="editRoom(\${r.id})">Изменить</button>
        <button class="btn btn-red btn-sm" onclick="deleteRoom(\${r.id})">Удалить</button>
      </div></td>
    </tr>\`;
  }).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Нет номеров.</td></tr>';
}
async function loadHdSeasons(hotelId){
  try{const all=await API.get('/api/admin/rate-periods');hdSeasonsCache=all.filter(s=>s.hotelId===hotelId);renderHdSeasons();}
  catch(err){showToast('Ошибка: '+err.message,'error');}
}
function renderHdSeasons(){
  const typeLabels={season:'🌞 Сезон',surcharge:'🎄 Доплата'},typeColors={season:'green',surcharge:'amber'};
  document.getElementById('hd-seasons-count').textContent='('+hdSeasonsCache.length+')';
  document.getElementById('hd-seasons-table').innerHTML=hdSeasonsCache.length?hdSeasonsCache.map(s=>{
    const today=new Date().toISOString().split('T')[0];
    const isActive=s.status==='active'&&s.dateFrom<=today&&s.dateTo>=today;
    return\`<tr>
      <td><strong>\${escHtml(s.name)}</strong></td>
      <td><span class="badge badge-\${typeColors[s.type]||'green'}">\${typeLabels[s.type]||s.type}</span></td>
      <td style="font-size:12px;white-space:nowrap">\${s.dateFrom} → \${s.dateTo}</td>
      <td>\${s.type==='surcharge'?'<strong style="color:var(--coral)">+$'+s.surcharge+'/ночь</strong>':'—'}</td>
      <td><span class="badge badge-\${isActive?'green':s.status==='active'?'amber':'red'}">\${isActive?'Активен':s.status==='active'?'Ожидает':'Откл.'}</span></td>
      <td><div class="actions-cell">
        <button class="btn btn-outline btn-sm" onclick="editSeason(\${s.id})">Изменить</button>
        <button class="btn btn-red btn-sm" onclick="deleteSeason(\${s.id})">Удалить</button>
      </div></td>
    </tr>\`;
  }).join(''):'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Нет периодов.</td></tr>';
}

function toggleSurchargeField(){
  const t=document.getElementById('s-type').value;
  document.getElementById('s-surcharge-wrap').style.display=t==='surcharge'?'':'none';
  document.getElementById('s-prices-divider').style.display=t==='season'?'':'none';
  document.querySelectorAll('#modal-season [id^="s-price-"]').forEach(el=>{el.closest('.fg').style.display=t==='season'?'':'none';});
}

const SEASON_PRICE_FIELDS=[
  {id:'s-price-sgl',key:'SGL'},{id:'s-price-dbl',key:'DBL'},{id:'s-price-tpl',key:'TPL'},{id:'s-price-4pax',key:'4PAX'},
  {id:'s-price-dbl-inf',key:'DBL_INF'},{id:'s-price-dbl-inf-eb',key:'DBL_INF_EB'},{id:'s-price-dbl-chd',key:'DBL_CHD'},
  {id:'s-price-dbl-2inf',key:'DBL_2INF'},{id:'s-price-dbl-inf-chd',key:'DBL_INF_CHD'},{id:'s-price-dbl-2chd',key:'DBL_2CHD'},
  {id:'s-price-tpl-inf',key:'TPL_INF'},{id:'s-price-tpl-2inf',key:'TPL_2INF'},
];

function openSeasonModal(id=null){
  editingSeasonId=id;
  document.getElementById('modal-season-title').textContent=id?'Изменить период':'Добавить период';
  document.getElementById('s-hotel').value=currentHotelDetailId;
  if(id){
    const s=hdSeasonsCache.find(x=>x.id===id)||rmSeasonsCache.find(x=>x.id===id);
    document.getElementById('s-name').value=s.name;
    document.getElementById('s-type').value=s.type;
    document.getElementById('s-from').value=s.dateFrom;
    document.getElementById('s-to').value=s.dateTo;
    document.getElementById('s-surcharge').value=s.surcharge||'';
    let p={};try{p=JSON.parse(s.prices||'{}');}catch(e){}
    const pKeys=Object.keys(p);if(pKeys.length>0&&typeof p[pKeys[0]]==='object'&&p[pKeys[0]]!==null)p=p.BB||p[pKeys[0]]||{};
    SEASON_PRICE_FIELDS.forEach(f=>{document.getElementById(f.id).value=p[f.key]||'';});
  }else{
    ['s-name','s-from','s-to','s-surcharge'].forEach(i=>document.getElementById(i).value='');
    SEASON_PRICE_FIELDS.forEach(f=>document.getElementById(f.id).value='');
    document.getElementById('s-type').value='season';
  }
  toggleSurchargeField();
  document.getElementById('modal-season').classList.add('open');
}
function editSeason(id){openSeasonModal(id);}

async function saveSeason(){
  const name=document.getElementById('s-name').value.trim();
  const dateFrom=document.getElementById('s-from').value;
  const dateTo=document.getElementById('s-to').value;
  if(!name||!dateFrom||!dateTo){showToast('Заполните название и даты','error');return;}
  const type=document.getElementById('s-type').value;
  const prices={};
  SEASON_PRICE_FIELDS.forEach(f=>{const v=parseFloat(document.getElementById(f.id).value);if(v>0)prices[f.key]=v;});
  const data={hotelId:currentHotelDetailId,name,type,dateFrom,dateTo,prices,surcharge:parseFloat(document.getElementById('s-surcharge').value)||0,status:'active'};
  try{
    const btn=document.getElementById('save-season-btn');
    btn.disabled=true;btn.textContent='Сохранение...';
    if(editingSeasonId){await API.put('/api/admin/rate-periods/'+editingSeasonId,data);showToast('Период обновлён!','success');}
    else{await API.post('/api/admin/rate-periods',data);showToast('Период добавлен!','success');}
    closeModal('modal-season');btn.disabled=false;btn.textContent='Сохранить';
    await loadHdSeasons(currentHotelDetailId);
    if(currentHotelDetailId)loadRmSeasons(currentHotelDetailId);
  }catch(err){
    document.getElementById('save-season-btn').disabled=false;
    document.getElementById('save-season-btn').textContent='Сохранить';
    showToast('Ошибка: '+err.message,'error');
  }
}
async function deleteSeason(id){
  if(!confirm('Удалить период?'))return;
  try{
    await API.del('/api/admin/rate-periods/'+id);showToast('Период удалён','success');
    await loadHdSeasons(currentHotelDetailId);if(currentHotelDetailId)loadRmSeasons(currentHotelDetailId);
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}
async function seedDefaultSeasons(){
  if(!confirm('Создать 4 стандартных сезона + 2 праздничных доплаты для этого отеля?'))return;
  const hid=currentHotelDetailId;
  const defaults=[
    {name:'Low Season 2026',type:'season',dateFrom:'2026-05-01',dateTo:'2026-09-30',hotelId:hid,prices:{},surcharge:0},
    {name:'Mid Season 2026',type:'season',dateFrom:'2026-10-01',dateTo:'2026-11-30',hotelId:hid,prices:{},surcharge:0},
    {name:'High Season 2026-27',type:'season',dateFrom:'2026-12-01',dateTo:'2027-03-31',hotelId:hid,prices:{},surcharge:0},
    {name:'Peak Season 2027',type:'season',dateFrom:'2027-01-15',dateTo:'2027-02-28',hotelId:hid,prices:{},surcharge:0},
    {name:'Christmas 2026',type:'surcharge',dateFrom:'2026-12-20',dateTo:'2026-12-26',hotelId:hid,prices:{},surcharge:25},
    {name:'New Year 2027',type:'surcharge',dateFrom:'2026-12-27',dateTo:'2027-01-05',hotelId:hid,prices:{},surcharge:35},
  ];
  try{
    for(const d of defaults)await API.post('/api/admin/rate-periods',{...d,status:'active'});
    showToast('6 периодов создано!','success');
    await loadHdSeasons(hid);if(hid)loadRmSeasons(hid);
  }catch(err){showToast('Ошибка: '+err.message,'error');}
}

// ═══════════════════════════════
// PRICE MATRIX
// ═══════════════════════════════
const ALL_ACCOM=[
  {key:'SGL',label:'SGL'},{key:'DBL',label:'DBL'},{key:'TPL',label:'TPL'},{key:'4PAX',label:'4 PAX'},
  {key:'DBL_INF',label:'DBL+INF'},{key:'DBL_INF_EB',label:'DBL+INF(eb)'},
  {key:'DBL_CHD',label:'DBL+CHD'},{key:'DBL_2INF',label:'DBL+2INF'},
  {key:'DBL_INF_CHD',label:'DBL+INF+CHD'},{key:'DBL_2CHD',label:'DBL+2CHD'},
  {key:'TPL_INF',label:'TPL+INF'},{key:'TPL_2INF',label:'TPL+2INF'}
];
const ALL_MEALS=[
  {key:'RO',label:'RO',title:'Room Only'},{key:'BB',label:'BB',title:'Bed & Breakfast'},
  {key:'HB',label:'HB',title:'Half Board'},{key:'FB',label:'FB',title:'Full Board'},
  {key:'AI',label:'AI',title:'All Inclusive'}
];
let pmData=null,pmCurrentMeal='BB';

async function loadPriceMatrix(hotelId){
  const container=document.getElementById('pm-container');
  container.innerHTML='<div class="loading-spinner">Загрузка матрицы цен...</div>';
  try{pmData=await API.get('/api/admin/hotels/'+hotelId+'/price-matrix');pmCurrentMeal='BB';renderPriceMatrix();}
  catch(err){container.innerHTML='<div class="loading-spinner">Ошибка загрузки: '+escHtml(err.message)+'</div>';}
}

function renderPriceMatrix(){
  if(!pmData)return;
  const{rooms,periods}=pmData;
  const seasons=periods.filter(p=>p.type==='season');
  const surcharges=periods.filter(p=>p.type==='surcharge');
  const meal=pmCurrentMeal;
  let mealTabsHtml='<div class="pm-meal-tabs">';
  ALL_MEALS.forEach(m=>{
    const hasData=rooms.some(r=>r.prices[m.key]&&Object.keys(r.prices[m.key]).length>0);
    const active=m.key===meal?' active':'';
    mealTabsHtml+=\`<button class="pm-meal-tab\${active}" onclick="pmSwitchMeal('\${m.key}')" title="\${escHtml(m.title)}">\${m.label}<span class="pm-dot\${hasData?' has-data':''}"></span></button>\`;
  });
  mealTabsHtml+='</div>';
  let roomsHtml='';
  rooms.forEach(room=>{
    const mealPrices=room.prices[meal]||{};
    roomsHtml+=\`<div class="pm-room-section">\`;
    roomsHtml+=\`<div class="pm-room-header">\${escHtml(room.type)} <span class="pm-view">\${escHtml(room.view||'')}</span></div>\`;
    roomsHtml+=\`<table class="pm-table"><thead><tr><th>Размещение</th><th>Базовая</th>\`;
    seasons.forEach(s=>{roomsHtml+=\`<th>\${escHtml(s.name)}</th>\`;});
    roomsHtml+=\`</tr></thead><tbody>\`;
    ALL_ACCOM.forEach(ac=>{
      roomsHtml+=\`<tr><td>\${escHtml(ac.label)}</td>\`;
      const baseVal=mealPrices[ac.key]||'';
      roomsHtml+=\`<td><input class="pm-input" type="number" min="0" placeholder="—" value="\${baseVal}" data-pm-room="\${room.id}" data-pm-meal="\${meal}" data-pm-accom="\${ac.key}" data-pm-col="base"></td>\`;
      seasons.forEach(s=>{
        const sPrices=s.prices[meal]||{};const sVal=sPrices[ac.key]||'';
        roomsHtml+=\`<td><input class="pm-input" type="number" min="0" placeholder="—" value="\${sVal}" data-pm-period="\${s.id}" data-pm-meal="\${meal}" data-pm-accom="\${ac.key}" data-pm-col="season"></td>\`;
      });
      roomsHtml+=\`</tr>\`;
    });
    roomsHtml+=\`</tbody></table></div>\`;
  });
  let surchargeHtml='';
  if(surcharges.length)surchargeHtml='<div class="pm-surcharges"><strong>Праздничные доплаты:</strong> '+surcharges.map(s=>\`\${escHtml(s.name)} <strong>+$\${s.surcharge}/ночь</strong> (\${s.dateFrom} → \${s.dateTo})\`).join(' · ')+'</div>';
  if(!rooms.length)roomsHtml='<div style="text-align:center;color:var(--muted);padding:40px">Нет номеров.</div>';
  const container=document.getElementById('pm-container');
  container.innerHTML=mealTabsHtml+roomsHtml+surchargeHtml+(rooms.length?\`<div class="pm-save-bar"><button class="btn btn-green" id="pm-save-btn" onclick="savePriceMatrix()" style="padding:12px 40px;font-size:15px">💾 Сохранить все цены</button><span id="pm-save-status" style="font-size:13px;color:var(--muted);align-self:center"></span></div>\`:'');
}

function pmSwitchMeal(meal){pmCollectCurrentInputs();pmCurrentMeal=meal;renderPriceMatrix();}

function pmCollectCurrentInputs(){
  if(!pmData)return;
  document.querySelectorAll('input[data-pm-col="base"]').forEach(inp=>{
    const roomId=parseInt(inp.dataset.pmRoom),meal=inp.dataset.pmMeal,accom=inp.dataset.pmAccom,val=parseFloat(inp.value);
    const room=pmData.rooms.find(r=>r.id===roomId);if(!room)return;
    if(!room.prices[meal])room.prices[meal]={};
    if(val>0){room.prices[meal][accom]=val;}else{delete room.prices[meal][accom];}
    if(Object.keys(room.prices[meal]).length===0)delete room.prices[meal];
  });
  document.querySelectorAll('input[data-pm-col="season"]').forEach(inp=>{
    const periodId=parseInt(inp.dataset.pmPeriod),meal=inp.dataset.pmMeal,accom=inp.dataset.pmAccom,val=parseFloat(inp.value);
    const period=pmData.periods.find(p=>p.id===periodId);if(!period)return;
    if(!period.prices[meal])period.prices[meal]={};
    if(val>0){period.prices[meal][accom]=val;}else{delete period.prices[meal][accom];}
    if(Object.keys(period.prices[meal]).length===0)delete period.prices[meal];
  });
}

async function savePriceMatrix(){
  pmCollectCurrentInputs();
  const btn=document.getElementById('pm-save-btn');
  btn.disabled=true;btn.textContent='Сохранение...';
  const payload={rooms:pmData.rooms.map(r=>({id:r.id,prices:r.prices})),periods:pmData.periods.filter(p=>p.type==='season').map(p=>({id:p.id,prices:p.prices}))};
  try{
    await API.put('/api/admin/hotels/'+pmData.hotel.id+'/price-matrix',payload);
    btn.textContent='✓ Сохранено!';btn.style.background='var(--teal-l)';btn.style.color='var(--teal)';
    showToast('Все цены сохранены!','success');
    roomsCache=await API.get('/api/admin/rooms');
    setTimeout(()=>{btn.disabled=false;btn.textContent='💾 Сохранить все цены';btn.style.background='';btn.style.color='';},2000);
  }catch(err){btn.disabled=false;btn.textContent='💾 Сохранить все цены';showToast('Ошибка сохранения: '+err.message,'error');}
}

// ═══════════════════════════════
// MODALS & TOAST
// ═══════════════════════════════
function closeModal(id){document.getElementById(id).classList.remove('open');}
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');}));

let toastTimer;
function showToast(msg,type='success'){
  const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3500);
}

// INIT
document.getElementById('login-pass').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
</script>
</body>
</html>
`;
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML);
});

app.listen(PORT, () => {
  console.log(`StayDirect API running on port ${PORT}`);
});
