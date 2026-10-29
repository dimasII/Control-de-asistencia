# Registro de asistencia docente por geocerca — Zonas rurales

Sistema para verificar que docentes de zonas rurales lleguen a su colegio, usando el GPS del celular y una geocerca de 200 m por colegio. El docente se registra desde su celular y el supervisor ve en vivo quién está dentro del área y saca reportes por colegio y fecha.

Punto de prueba inicial: `94JM+X2M, Av. Inca Garcilaso de la Vega, Abancay 03001` → `-13.6175375, -72.8674531`, radio 200 m.

## Qué hace

- **Docente (`/`):** elige colegio, escribe su nombre, pulsa Iniciar rastreo y Registrar mi ingreso. El navegador pide permiso de GPS y envía su posición cada 3 s. Ve si está DENTRO o fuera del radio.
- **Supervisor (`/monitor.html`):** no necesita GPS. Elige colegio y fecha, ve conectados en vivo, historial guardado con fecha y hora del servidor, mapa con centro y círculo de 200 m, y descarga CSV para Excel. El botón **+ Colegio** abre un formulario para agregar colegios: nombre, coordenadas pegadas de Google Maps (acepta decimal o grados/minutos/segundos) y radio en metros.
- **Servidor (`server.js`):** calcula distancia Haversine, decide dentro/fuera por colegio, guarda registros en SQLite y emite estado en tiempo real por Socket.io.

## Base de datos

SQLite en archivo `tesis.db` (se crea solo al arrancar). Sin instalación, ideal para tesis y trabajo offline en rural.

- `colegios(id, nombre, lat, lon, radioM)`
- `registros(id, colegio_id, deviceId, nombre, lat, lon, distanciaM, dentro, fecha, hora, timestamp, mapsUrl)`

Cuando escale a UGEL o región se migra a PostgreSQL manteniendo las mismas tablas.

## API

- `GET /api/colegios` — lista colegios
- `POST /api/colegios` `{nombre, lat, lon, radioM}` — agrega colegio de prueba
- `GET /api/geocerca?colegio_id=` — centro y radio de un colegio
- `POST /api/checkin` `{deviceId, nombre, colegio_id, lat, lon}` — registro manual con hora del servidor
- `GET /api/dispositivos` — conectados en vivo (memoria)
- `GET /api/registros?colegio_id=&fecha=YYYY-MM-DD&solo_dentro=1` — historial
- `GET /api/reporte.csv?colegio_id=&fecha=` — descarga para Excel

Socket.io: `registro`, `posicion_movil` (móvil → servidor), `geocerca_estado`, `posicion_filtrada`, `lista_dispositivos` (servidor → clientes).

## Cómo correrlo para pruebas

```powershell
npm install
node server.js
```

- Inicio (presentación del sistema): `http://localhost:3000/inicio.html`
- Docente local: `http://localhost:3000/`
- Supervisor local: `http://localhost:3000/monitor.html`

GPS en celular exige HTTPS. El proyecto levanta HTTP (`3000`) y HTTPS (`3443`) con certificado local en `cert/`. En la misma WiFi el celular abre `https://IP-DE-TU-PC:3443`, acepta el aviso una vez y listo.

Si lo despliegas en un hosting (por ejemplo Hostinger, Railway o Render), arranca sin el HTTPS local porque el SSL lo pone el proveedor:

```bash
DISABLE_HTTPS=1 npm start
```

El puerto lo toma de `process.env.PORT`.

Para pruebas con internet real:

```powershell
npm run tunnel
```

Comparte la URL `https://...trycloudflare.com` que genera.

## Simular un registro sin ir al colegio

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/checkin -Method Post -ContentType "application/json" -Body '{"deviceId":"dev-prueba1","nombre":"Profe Prueba","colegio_id":1,"lat":-13.6175375,"lon":-72.867453125}'
```

Luego revisa en el monitor la fecha de hoy.

## Notas importantes

- Ningún celular puede ser rastreado solo por entrar al área con internet. Debe abrir la página y aceptar el GPS. Esto es por privacidad del navegador y debe constar con consentimiento informado en la tesis.
- El autoguardado por tracking solo inserta si está DENTRO y pasó más de 60 s desde el último, para no llenar la BD.
- Pendiente: login/DNI de docentes. Hoy la identidad es nombre + `deviceId` guardado en `localStorage`.
