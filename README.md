# Microgrid Watch

Microgrid Watch reads two ESP32 voltage and two current inputs using laptop Bluetooth Low Energy (BLE). A laptop-side bridge forwards readings to the local Node API; the dashboard polls that API for four live cards and graphs.

## Run the local dashboard and laptop Bluetooth bridge

1. Install Node.js and Python 3. Make sure Bluetooth is enabled on the laptop.
2. In PowerShell, go to the dashboard folder, install the BLE bridge dependency, and start the app:

   ```powershell
   cd "C:\Users\user\OneDrive\Desktop\EE499\IoT"
   python -m pip install -r requirements-ble.txt
   npm start
   ```

   The two named processes should report the local API and the BLE scan. Keep this terminal open.
3. Power the ESP32 and open `http://localhost:3000` in your browser. The laptop bridge scans for **Microgrid ESP32**, connects using the BLE service, subscribes to its readings, and forwards each packet to the local API. It retries scanning and reconnects automatically.
4. Watch the dashboard for **Laptop Bluetooth bridge connected** and all four live sensor readings. The dashboard polls the local API once per second and saves received points to its browser history.

## Admin login

The dashboard has a single admin account. Opening it redirects to the sign-in page, and the **Sign out** button in the header ends the session. Sessions last 12 hours, and five wrong passwords lock that address out for one minute.

Set the credentials in a `.env` file in the dashboard folder (it is git-ignored), then restart `npm start`:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
```

`ADMIN_USERNAME` defaults to `admin`. If `ADMIN_PASSWORD` is not set, the server generates a password at startup and prints it in the terminal. The ESP32 and Bluetooth bridge upload endpoints do not use this login.

### Open the dashboard from another device or Wi-Fi

Keep `npm start` running, then in a second terminal run:

```powershell
npm run tunnel
```

On the other device, open `https://pasty-tiptoeing-excretory.ngrok-free.dev` and sign in as the admin. ngrok may first show a "You are about to visit" page; choose **Visit Site**. Without the admin login, visitors only see the sign-in page.

Through the tunnel the admin can view live readings, graphs, and the relay state. The server keeps the last 5 minutes of readings in memory, so the graphs are already filled when a new device opens the dashboard; this history clears when the server restarts. Switching the relay, and the Bluetooth bridge uploads, still work only on this PC.

Every relay switch, open (disconnect) or close (connect), asks for the admin username and password again before the command is sent. Wrong passwords count towards the same one-minute lockout as the sign-in page.

If Windows finds the ESP32 but the bridge reports `Unreachable`, Windows may have a stale BLE GATT cache. Stop the bridge, remove **Microgrid ESP32** in **Settings > Bluetooth & devices > Devices** if it is paired, toggle Bluetooth off and back on, power-cycle the ESP32, and restart `npm start`. Close other apps that may be connected to the ESP32 while using the bridge.

The BLE service UUID is `19b10000-e8f2-537e-4f6c-d104768a1214`; its reading characteristic UUID is `19b10001-e8f2-537e-4f6c-d104768a1214`. Each notification contains four little-endian 32-bit floats in dashboard field order: solar voltage (GPIO32), solar current (GPIO33), battery voltage (GPIO35), battery current (GPIO34). The bridge accepts the previous two-float packet during firmware upgrades. Its API upload endpoint accepts connections only from the same laptop. No Render service, ESP32 Wi-Fi credentials, browser Bluetooth permission, or ingest token is required for this BLE path.

For direct ESP32-to-browser BLE, the dashboard no longer opens its own browser Bluetooth connection. Run the laptop bridge with `npm start` so one local process owns the BLE connection and forwards data to the dashboard.

## Send Wi-Fi telemetry to the dashboard

GitHub Pages is static hosting and cannot access this laptop’s local API. For the laptop bridge flow, use `http://localhost:3000`.

The firmware uploads every five seconds and the dashboard polls every second. An available voltage can be uploaded while current is unavailable; missing sensor values use JSON `null`.

1. Start the local API and BLE bridge together with `npm start`.
2. In the PlatformIO `esp32_bt` project, copy `include/secrets.example.h` to `include/secrets.h` and fill in the Wi-Fi name/password, API ingest URL, and a token of at least 32 characters. Set the same value as `ESP32_INGEST_TOKEN` in the environment before starting the server. For the local server, use `http://<computer-LAN-IP>:3000/api/ingest`. The ESP32 sends JSON every five seconds with `Content-Type: application/json` and an Authorization bearer token.
3. Open the dashboard at `http://localhost:3000`; it polls the local API every second.

The local BLE endpoint accepts uploads only from loopback. The older authenticated `/api/ingest` endpoint remains available if you configure ESP32 Wi-Fi telemetry separately.

Bluetooth and Wi-Fi telemetry are separate options; the local laptop bridge is the recommended route when you want the ESP32’s BLE readings graphed on this computer without cloud hosting.

## Sensors

The ESP32 monitors battery current on GPIO34, battery voltage on GPIO35, solar voltage on GPIO32, and solar current on GPIO33. Both ACS712 channels use the shared 0.100 V/A sensitivity and 2.32 V zero-current offset, the 500–3300 mV input cutoff, 10 averaged ADC samples, and separate Kalman filters. Both voltage channels use the shared calibration formula `(sensor mV / 1000 * 4.8) * 0.93 + 0.95`. Calibrated values are sent over BLE and Wi-Fi and printed with V/A units on the serial monitor. The BLE float order and Wi-Fi field names remain the dashboard order: solar voltage/current, then battery voltage/current. Current polarity follows each ACS712's wiring direction; orient its marked current arrow with the intended positive current flow. Do not infer polarity from readings when a sensor is disconnected, because a floating ESP32 input can produce plausible but meaningless values. Verify the shared calibration against a multimeter and a known current reference before relying on the reported accuracy. Each voltage input is sampled 20 times using `analogReadMilliVolts`. The dashboard graphs each sensor separately; current readings within ±5.5 A, including small values, are plotted with an auto-scaled axis. Use a voltage divider or other appropriate conditioning to keep ESP32 ADC pins within 0–3.3 V; the ADC pins are not 12 V tolerant.
