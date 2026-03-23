'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/' || pathname === '/index.html') {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(fs.readFileSync(f, 'utf8'));
    } else {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({service:'StayDirect API',status:'ok',docs:'/api/v1'}));
    }
    return;
  }

  if (pathname === '/admin') {
    const f = path.join(__dirname, 'admin.html');
    if (fs.existsSync(f)) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(fs.readFileSync(f, 'utf8'));
    } else {
      res.writeHead(404); res.end('Admin not found');
    }
    return;
  }

  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({service:'StayDirect API',version:'1.0.0',status:'ok',docs:'/api/v1'}));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('StayDirect started on port ' + PORT);
});
