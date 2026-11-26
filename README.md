<img src="assets/icon.svg" width="64" height="64" alt="">

# VexFront.io — 2D Multiplayer .io Real-Time Strategy

**VexFront.io** verschmilzt die taktische Echtzeit-Schwarm-Kampfdynamik von *War of Dots* mit der makroökonomischen Territoriums-, Seehandels- und Diplomatie-Simulation von *OpenFront.io* — inklusive **OpenFront-Style Multi-Lobby-System**.

---

## Features

- **OpenFront-Style Multi-Lobby & Instant-Join:**
  - Mehrere parallele Lobbys (`Archipel`, `Kontinente`, `Pangäa`) sowie eigene öffentliche oder private Lobbys mit 6-stelligem Raum-Code (z. B. `VEX101`).
  - Jede Runde unterstützt bis zu **15 Fraktionen** gleichzeitig. Solange weniger als 15 menschliche Spieler in einer Lobby sind, füllt der Server die Partie automatisch mit eigenständigen **KI-Bots** auf (und ersetzt Bots nahtlos, sobald echte Spieler beitreten).
- **Makro-Ökonomie (*OpenFront.io*-Mechanik):**
  - **Logistisches Bevölkerungswachstum** skaliert durch kontrollierte Landesfläche und gebaute **Städte**.
  - **Arbeiter-vs.-Truppen-Slider (0 % – 100 %)** zur Echtzeit-Allokation zwischen kontinuierlichem Gold-Einkommen und rekrutierbarer Truppen-Reserve.
  - **Infrastruktur:** Städte (`250g`), Küsten-Häfen (`300g`) mit automatischen Handelsschiffen & Distanz-Goldbonus, Verteidigungsposten (`200g`) mit Kampfbonus-/Slow-Radius sowie Front-Sammelpunkte (`100g`).
  - **Diplomatie & Verrat:** Schnelle Allianzen (sicherer Seehandel, kein Friendly Fire) und 60-sekündiger **Verräter-Debuff** (`-35%` Gold & Verteidigung) bei Bündnisbruch.
- **Taktische Schwarm-Kämpfe (*War of Dots*-Mechanik):**
  - Physische Dot-Schwärme mit Boids-/Flocking-Verhalten, Terrain-Modifikatoren (Ebene, Gebirge, Wasser-Transfer über Häfen/Transportschiffe), Box-Select, Entsende-Prozentsatz (`25 % / 50 % / 100 %`) und `Shift + Rechtsklick` Wegpunkt-Ketten.
  - Live-Territoriumsfärbung beim Durchmarsch sowie Nachschub-/Einkesselungs-Berechnung (abgeschnittene Gebiete verlieren Moral und stoppen Produktion).
- **Coolify Production-Ready:**
  - Single-Container & Single-Port (`express` + `ws` auf `process.env.PORT || 3000`, gebunden an `0.0.0.0`).
  - Traefik / Reverse-Proxy SSL-kompatibler WebSocket-Client (`ws:` / `wss:`).
  - `GET /health` Endpunkt und sauberes Graceful Shutdown (`SIGTERM` / `SIGINT`).

---

## Lokale Entwicklung & Start

```bash
npm install
npm run build
npm start
```

Der Server läuft anschließend auf `http://0.0.0.0:3000` (Healthcheck unter `http://localhost:3000/health`).
