# Microgrid Watch

The dashboard is published at `https://lusemaivugalei-oss.github.io/IoT/iot.html`. GitHub Pages serves the page only; a separate Node.js API receives readings from the ESP32 and serves them publicly to the dashboard.

## Deploy the API to Render

1. Push this repository to GitHub, then create a Render Blueprint from the repository. Render uses [`render.yaml`](./render.yaml) to deploy `server.js` and generate the `ESP32_INGEST_TOKEN` environment variable.
2. In the Render service settings, copy the generated `ESP32_INGEST_TOKEN` value. Keep it private.
3. Copy the service's HTTPS origin (for example, `https://microgrid-watch-api.onrender.com`). In [`iot.html`](./iot.html), replace `https://YOUR-RENDER-SERVICE.onrender.com` in `API_BASE_URL` with that origin, then push the change so GitHub Pages redeploys.
4. In Render, check `/api/health` on the service URL. It should return JSON with `"status":"ok"`.

## Configure and flash the ESP32

1. Copy [`secrets.example.h`](./secrets.example.h) to `secrets.h` in the same directory as `Bluetooth.cpp`.
2. Set `WIFI_SSID`, `WIFI_PASSWORD`, `TELEMETRY_API_URL` (the Render origin followed by `/api/ingest`), and `TELEMETRY_TOKEN` (the same value as Render's `ESP32_INGEST_TOKEN`) in `secrets.h`.
3. Compile and flash `Bluetooth.cpp` with the ESP32 Arduino platform. The firmware uploads readings over certificate-validated HTTPS every two seconds while keeping the local HTTP and Bluetooth sensor interfaces.

`secrets.h` is excluded from Git. Do not commit it or put the Render token in `iot.html`; the browser only reads public sensor data. The firmware uses the public ISRG Root X1 CA certificate to verify the Render HTTPS connection.

## Public access and data flow

The page polls `GET /api/data` every two seconds. Anyone can read the live voltage and current values from the dashboard/API; the ingest endpoint requires the private bearer token so the public cannot submit readings. The API keeps the latest reading in memory, so it will return “no sensor reading” until the ESP32 next uploads after a service restart.

Do not publish readings if they are sensitive. The ingest token is a write credential, not a way to make public readings private.

## Sensors

The ESP32 firmware reads an ACS712-20A current sensor on GPIO34 and a battery voltage sensor on GPIO35. The current calibration uses 0.100 V/A sensitivity, a 2.32 V zero-current offset, 10 averaged ADC samples, and a Kalman filter. Battery voltage uses a 0.93 slope, 0.95 V regression offset, a 4.8 divider ratio, and 20 averaged ADC samples. Verify the calibration against your hardware and keep ADC inputs within 0–3.3 V.
