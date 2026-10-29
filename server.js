const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

// 1. Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// === BD: SQLite local (ideal tesis / zonas rurales sin internet) ===
// Por qué SQLite y no otra: archivo único tesis.db, cero instalación,
// funciona offline, se respalda copiando el archivo, y migra fácil a
// Postgres/MySQL cuando escale a UGEL/Región. Node 22 la trae integrada.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, 'tesis.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS colegios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radioM INTEGER NOT NULL DEFAULT 200
);
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  colegio_id INTEGER NOT NULL REFERENCES colegios(id),
  deviceId TEXT NOT NULL,
  nombre TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  distanciaM INTEGER NOT NULL,
  dentro INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  mapsUrl TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_col_fecha ON registros(colegio_id, fecha);
`);
const nColegios = db.prepare('SELECT COUNT(*) AS n FROM colegios').get().n;
if (nColegios === 0) {
  db.prepare('INSERT INTO colegios (nombre, lat, lon, radioM) VALUES (?,?,?,?)')
    .run('I.E. Prueba - Av. Inca Garcilaso (94JM+X2M)', -13.6175375, -72.867453125, 200);
}
function listaColegios() { return db.prepare('SELECT * FROM colegios ORDER BY id').all(); }
function getColegio(id) {
  if (id == null) return listaColegios()[0];
  return db.prepare('SELECT * FROM colegios WHERE id = ?').get(Number(id)) || listaColegios()[0];
}

// Ruta de salud (útil para monitoreo)
app.get('/health', (req, res) => res.json({ ok: true, secure: req.secure || false }));

// API colegios
app.get('/api/colegios', (req, res) => res.json(listaColegios()));
app.post('/api/colegios', (req, res) => {
  const { nombre, lat, lon, radioM } = req.body || {};
  if (!nombre || !esCoordenadaValida(Number(lat), Number(lon))) return res.status(400).json({ error: 'nombre/lat/lon inválidos' });
  const r = db.prepare('INSERT INTO colegios (nombre, lat, lon, radioM) VALUES (?,?,?,?)')
    .run(String(nombre).slice(0, 80), Number(lat), Number(lon), Number(radioM) || 200);
  res.json({ id: Number(r.lastInsertRowid) });
});

// === GEOCERCA por defecto (compatibilidad): primer colegio ===
function geocercaDefault() {
  const c = listaColegios()[0];
  return { lat: c.lat, lon: c.lon, radioM: c.radioM, nombre: c.nombre, id: c.id };
}
app.get('/api/geocerca', (req, res) => {
  const c = req.query.colegio_id ? getColegio(req.query.colegio_id) : geocercaDefault();
  res.json({ lat: c.lat, lon: c.lon, radioM: c.radioM, nombre: c.nombre, id: c.id });
});
app.get('/api/dispositivos', (req, res) => res.json(Array.from(dispositivos.values())));

// Posición por HTTP: la usa el celular al cerrar/minimizar la pestaña (sendBeacon),
// o cuando el socket está caído. Misma validación y misma geocerca que por Socket.io.
app.post('/api/posicion', (req, res) => {
  const { deviceId, nombre, colegio_id, lat, lon } = req.body || {};
  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!deviceId || !esCoordenadaValida(nLat, nLon)) return res.status(400).json({ error: 'deviceId/lat/lon inválidos' });
  const id = String(deviceId).slice(0, 64);
  const nom = String(nombre || 'Sin nombre').slice(0, 40);
  const col = getColegio(colegio_id);
  const dist = distanciaMetros(nLat, nLon, col.lat, col.lon);
  const dentro = dist <= col.radioM;
  const ahora = new Date();
  const prev = dispositivos.get(id) || {};

  dispositivos.set(id, {
    deviceId: id, nombre: nom, socketId: prev.socketId ?? null, lat: nLat, lon: nLon,
    colegio_id: col.id, colegio: col.nombre,
    distanciaM: Math.round(dist), dentro,
    fecha: ahora.toLocaleDateString('es-ES'),
    hora: ahora.toLocaleTimeString('es-ES', { hour12: false }),
    mapsUrl: `https://www.google.com/maps?q=${nLat},${nLon}`,
    conectado: prev.conectado ?? false, ultimaVez: Date.now()
  });

  // Mismo autoguardado que el socket: dentro del radio y máx. 1 registro por minuto
  if (dentro) {
    const key = id + ':' + col.id;
    const last = ultimoGuardado.get(key) || 0;
    if (Date.now() - last > 60000) {
      ultimoGuardado.set(key, Date.now());
      guardarRegistro({ colegio_id: col.id, deviceId: id, nombre: nom, lat: nLat, lon: nLon });
    }
  }

  if (ioRef) {
    ioRef.emit('posicion_filtrada', { ...dispositivos.get(id), id });
    ioRef.emit('lista_dispositivos', Array.from(dispositivos.values()));
  }
  res.json({ ok: true, dentro, distanciaM: Math.round(dist) });
});

// Guardar registro de ingreso (docente -> colegio), con fecha/hora del servidor
function guardarRegistro({ colegio_id, deviceId, nombre, lat, lon }) {
  const col = getColegio(colegio_id);
  const dist = distanciaMetros(lat, lon, col.lat, col.lon);
  const dentro = dist <= col.radioM ? 1 : 0;
  const ahora = new Date();
  const yyyy = ahora.getFullYear();
  const mm = String(ahora.getMonth() + 1).padStart(2, '0');
  const dd = String(ahora.getDate()).padStart(2, '0');
  const fechaISO = `${yyyy}-${mm}-${dd}`;
  const fecha = ahora.toLocaleDateString('es-ES');
  const hora = ahora.toLocaleTimeString('es-ES', { hour12: false });
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
  db.prepare(`INSERT INTO registros (colegio_id, deviceId, nombre, lat, lon, distanciaM, dentro, fecha, hora, timestamp, mapsUrl)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(col.id, deviceId, nombre, lat, lon, Math.round(dist), dentro, fechaISO, hora, Date.now(), mapsUrl);
  return { colegio: col, distanciaM: Math.round(dist), dentro: !!dentro, fecha, fechaISO, hora, mapsUrl };
}
app.post('/api/checkin', (req, res) => {
  const { deviceId, nombre, colegio_id, lat, lon } = req.body || {};
  if (!deviceId || !esCoordenadaValida(Number(lat), Number(lon))) return res.status(400).json({ error: 'deviceId/lat/lon inválidos' });
  const r = guardarRegistro({ colegio_id, deviceId: String(deviceId).slice(0, 64), nombre: String(nombre || 'Sin nombre').slice(0, 40), lat: Number(lat), lon: Number(lon) });
  res.json({ ok: true, ...r });
});
app.get('/api/registros', (req, res) => {
  const { colegio_id, fecha, solo_dentro } = req.query;
  let sql = 'SELECT r.*, c.nombre AS colegio FROM registros r JOIN colegios c ON c.id = r.colegio_id WHERE 1=1';
  const params = [];
  if (colegio_id) { sql += ' AND r.colegio_id = ?'; params.push(Number(colegio_id)); }
  if (fecha) { sql += ' AND r.fecha = ?'; params.push(String(fecha)); }
  if (solo_dentro === '1') { sql += ' AND r.dentro = 1'; }
  sql += ' ORDER BY r.id DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});
app.get('/api/reporte.csv', (req, res) => {
  const { colegio_id, fecha } = req.query;
  let sql = 'SELECT r.*, c.nombre AS colegio FROM registros r JOIN colegios c ON c.id = r.colegio_id WHERE 1=1';
  const params = [];
  if (colegio_id) { sql += ' AND r.colegio_id = ?'; params.push(Number(colegio_id)); }
  if (fecha) { sql += ' AND r.fecha = ?'; params.push(String(fecha)); }
  sql += ' ORDER BY r.id DESC LIMIT 2000';
  const rows = db.prepare(sql).all(...params);
  const head = 'id,colegio,fecha,hora,nombre,deviceId,lat,lon,distanciaM,dentro,mapsUrl\n';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) => [r.id, esc(r.colegio), r.fecha, r.hora, esc(r.nombre), r.deviceId, r.lat, r.lon, r.distanciaM, r.dentro, r.mapsUrl].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reporte.csv"');
  res.send('\ufeff' + head + body);
});

// Distancia Haversine en metros
function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 2. Validación de coordenadas
function esCoordenadaValida(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

// 3. Lógica Socket.io compartida (misma para HTTP y HTTPS)
// Roles: móvil (/) envía GPS, supervisor (/monitor.html) solo observa
const dispositivos = new Map(); // deviceId -> { deviceId, nombre, socketId, lat, lon, distanciaM, dentro, fecha, hora, mapsUrl, conectado, ultimaVez }
let ioRef = null; // referencia para las rutas HTTP que también actualizan presencia

function broadcastLista(io) {
  io.emit('lista_dispositivos', Array.from(dispositivos.values()));
}
const ultimoGuardado = new Map(); // deviceId+colegio -> timestamp (evita llenar BD cada 3s)
function configurarSockets(io) {
  io.on('connection', (socket) => {
    console.log(`\x1b[32m[+] Cliente conectado\x1b[0m | ID: ${socket.id}`);
    // Enviar estado actual al recién conectado (para el supervisor)
    socket.emit('lista_dispositivos', Array.from(dispositivos.values()));

    socket.on('registro', (data) => {
      const deviceId = String((data && data.deviceId) || socket.id).slice(0, 64);
      const nombre = String((data && data.nombre) || 'Sin nombre').slice(0, 40);
      socket.deviceId = deviceId;
      const prev = dispositivos.get(deviceId) || {};
      dispositivos.set(deviceId, {
        deviceId, nombre, socketId: socket.id,
        lat: prev.lat ?? null, lon: prev.lon ?? null,
        distanciaM: prev.distanciaM ?? null, dentro: prev.dentro ?? false,
        fecha: prev.fecha ?? null, hora: prev.hora ?? null, mapsUrl: prev.mapsUrl ?? null,
        conectado: true, ultimaVez: Date.now()
      });
      console.log(`  📱 Registro: ${nombre} | deviceId: ${deviceId} | socket: ${socket.id}`);
      broadcastLista(io);
    });

    socket.on('posicion_movil', (data) => {
      // Validación en servidor: lat y lon deben ser números válidos
      if (!data || !esCoordenadaValida(data.lat, data.lon)) {
        console.warn(
          `\x1b[33m[!] Datos inválidos descartados\x1b[0m | ID: ${socket.id} | Recibido: ${JSON.stringify(data)}`
        );
        return;
      }

      const { lat, lon } = data;
      const deviceId = String(data.deviceId || socket.deviceId || socket.id).slice(0, 64);
      const nombre = String(data.nombre || (dispositivos.get(deviceId) || {}).nombre || 'Sin nombre').slice(0, 40);
      socket.deviceId = deviceId;
      const col = getColegio(data.colegio_id);
      const dist = distanciaMetros(lat, lon, col.lat, col.lon);
      const dentro = dist <= col.radioM;
      const ahora = new Date();
      const fecha = ahora.toLocaleDateString('es-ES');
      const hora = ahora.toLocaleTimeString('es-ES', { hour12: false });
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;

      dispositivos.set(deviceId, {
        deviceId, nombre, socketId: socket.id, lat, lon, colegio_id: col.id, colegio: col.nombre,
        distanciaM: Math.round(dist), dentro, fecha, hora, mapsUrl,
        conectado: true, ultimaVez: Date.now()
      });

      // Avisar al propio dispositivo si está dentro/fuera
      socket.emit('geocerca_estado', { dentro, distanciaM: Math.round(dist), radioM: col.radioM, colegio: col.nombre, colegio_id: col.id });
      // Avisar a monitores (dashboard): punto + lista completa
      io.emit('posicion_filtrada', { deviceId, nombre, id: socket.id, lat, lon, distanciaM: Math.round(dist), dentro, fecha, hora, mapsUrl, colegio_id: col.id, colegio: col.nombre });
      broadcastLista(io);

      // Autoguardado: solo si está DENTRO y pasaron >60s desde el último guardado (no inunda la BD)
      if (dentro) {
        const key = deviceId + ':' + col.id;
        const last = ultimoGuardado.get(key) || 0;
        if (Date.now() - last > 60000) {
          ultimoGuardado.set(key, Date.now());
          guardarRegistro({ colegio_id: col.id, deviceId, nombre, lat, lon });
        }
      }
      // Solo se considera "captura válida" si está dentro del radio
      if (!dentro) {
        console.log(`\x1b[90m[·] Fuera del radio ${col.nombre} (${Math.round(dist)} m) | ${nombre} | ${lat},${lon}\x1b[0m`);
        return;
      }

      // Impresión estilizada en consola — SOLO los que están dentro
      console.log(`
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1m📍 DENTRO ${col.nombre} ✅\x1b[0m
  \x1b[90mFecha:\x1b[0m      ${fecha}
  \x1b[90mHora:\x1b[0m       ${hora}
  \x1b[90mDocente:\x1b[0m    ${nombre} (${deviceId})
  \x1b[90mLatitud:\x1b[0m    ${lat}
  \x1b[90mLongitud:\x1b[0m   ${lon}
  \x1b[90mDistancia:\x1b[0m  ${Math.round(dist)} m del centro
  \x1b[90mMaps:\x1b[0m       \x1b[34m${mapsUrl}\x1b[0m
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
      `);
    });

    socket.on('disconnect', (reason) => {
      console.log(`\x1b[31m[-] Cliente desconectado\x1b[0m | ID: ${socket.id} | Motivo: ${reason}`);
      if (socket.deviceId && dispositivos.has(socket.deviceId)) {
        const d = dispositivos.get(socket.deviceId);
        // Marcar desconectado solo si era su socket activo
        if (d.socketId === socket.id) {
          d.conectado = false;
          dispositivos.set(socket.deviceId, d);
          broadcastLista(io);
        }
      }
    });
  });
}

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const PORT = process.env.PORT || 3000;
const PORT_HTTPS = process.env.PORT_HTTPS || 3443;

const ioOpts = {
  pingInterval: 10000,
  pingTimeout: 15000,
  maxHttpBufferSize: 1e5
};

// Servidor HTTP (laptop / compatibilidad)
const httpServer = http.createServer(app);
const io = new Server(httpServer, ioOpts);
ioRef = io;
configurarSockets(io);

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIps().join(', ');
  console.log(`\x1b[32m✔ HTTP  corriendo\x1b[0m  → http://localhost:${PORT}  (LAN: ${ips} → puerto ${PORT})`);
  console.log(`  \x1b[33m⚠ En celular el GPS se bloquea en HTTP. Usa la URL HTTPS de abajo.\x1b[0m`);
});

// Servidor HTTPS (CELULAR — esto desbloquea el GPS en LAN)
// En hosting (Hostinger, Railway, etc.) el SSL lo pone el proveedor y no se pueden
// abrir puertos propios: ahí se arranca con DISABLE_HTTPS=1.
if (process.env.DISABLE_HTTPS === '1') {
  console.log('\x1b[90m[i] HTTPS local desactivado (DISABLE_HTTPS=1). Usa el certificado del hosting.\x1b[0m');
} else
try {
  const key = fs.readFileSync(path.join(__dirname, 'cert', 'key.pem'));
  const cert = fs.readFileSync(path.join(__dirname, 'cert', 'cert.pem'));
  const httpsServer = https.createServer({ key, cert }, app);
  io.attach(httpsServer); // mismo Socket.io en ambos
  httpsServer.on('error', (err) => {
    console.error(`\x1b[31m✖ HTTPS no pudo abrir el puerto ${PORT_HTTPS}\x1b[0m`, err.code || err.message, '— el HTTP sigue funcionando.');
  });
  httpsServer.listen(PORT_HTTPS, '0.0.0.0', () => {
    const ips = getLanIps();
    console.log(`\x1b[32m✔ HTTPS corriendo\x1b[0m → https://localhost:${PORT_HTTPS}`);
    ips.forEach((ip) => {
      console.log(`  \x1b[1m📱 En el celular abre: https://${ip}:${PORT_HTTPS}\x1b[0m`);
    });
    console.log(`\n  Primera vez verás advertencia "No es privado" → Avanzado → Continuar a ${ips[0] || 'tu-IP'} (es tu certificado local, normal).`);
  });
} catch (e) {
  console.error('\x1b[31m✖ No se pudo iniciar HTTPS. Falta cert/key.pem. Regenera con openssl.\x1b[0m', e.message);
}
