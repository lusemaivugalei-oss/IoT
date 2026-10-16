# Microgrid Watch

The dashboard and its login/API must be served together by the Render Node.js service. GitHub Pages cannot protect the dashboard or run the login API; its deployment now publishes only a notice and no dashboard assets or sensor readings.

## Deploy the private dashboard to Render

1. Push the repository to GitHub, then create a Render Blueprint from it using [`render.yaml`](./render.yaml).
2. In the Render service's Environment settings, add `MICROGRID_USERS_JSON` with a JSON object containing the authorized username/password pairs, for example `{"operator":"use-a-strong-unique-password"}`. Set a strong, unique password and keep it private.
3. Render generates `ESP32_INGEST_TOKEN` automatically. Keep this token private too. Render supplies `PORT`; do not create that variable yourself.
4. Open the HTTPS service URL shown by Render. The dashboard is served at `/` and prompts for the configured account. Both sign-in and readings use the same origin, with an HTTP-only, secure session cookie.

The sensor endpoint requires a valid signed-in session. The ESP32 upload endpoint separately requires the private bearer token. Do not put either credential in the dashboard HTML or commit credentials to GitHub.

## Configure and flash the ESP32

1. Copy [`secrets.example.h`](./secrets.example.h) to `secrets.h` in the same directory as `Bluetooth.cpp`.
2. Set `WIFI_SSID`, `WIFI_PASSWORD`, `TELEMETRY_API_URL` (the Render service URL followed by `/api/ingest`), and `TELEMETRY_TOKEN` (the same value as Render's `ESP32_INGEST_TOKEN`) in `secrets.h`.
3. Compile and flash `Bluetooth.cpp` with the ESP32 Arduino platform. The firmware uploads readings over certificate-validated HTTPS every two seconds while keeping the local HTTP and Bluetooth sensor interfaces.

`secrets.h` is excluded from Git. The firmware uses the public ISRG Root X1 CA certificate to verify the Render HTTPS connection.

## GitHub Pages

The existing GitHub Pages URL is not the private dashboard URL. It displays a notice directing users to the Render service. Use the Render HTTPS URL to sign in; that is the only site configured to show dashboard readings.

## Sensors

The ESP32 firmware reads an ACS712-20A current sensor on GPIO34 and a battery voltage sensor on GPIO35. The current calibration uses 0.100 V/A sensitivity, a 2.32 V zero-current offset, 10 averaged ADC samples, and a Kalman filter. Battery voltage uses a 0.93 slope, 0.95 V regression offset, a 4.8 divider ratio, and 20 averaged ADC samples. Verify the calibration against your hardware and keep ADC inputs within 0–3.3 V.
