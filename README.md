# Microgrid Watch

The GitHub Pages dashboard reads voltage and current directly from the ESP32 over Bluetooth Low Energy (BLE). It does not need a Wi-Fi connection, cloud API, login, or credentials.

## Connect the ESP32 to the dashboard

1. In Arduino IDE, create a sketch, copy the contents of [`Bluetooth.cpp`](./Bluetooth.cpp) into its `.ino` file, select your ESP32 board and port, then upload. The BLE libraries are included with the ESP32 Arduino core.
2. Power the ESP32 and open [the dashboard](https://lusemaivugalei-oss.github.io/IoT/iot.html) on the PC in Chrome or Edge. Web Bluetooth requires a supported browser and a secure HTTPS page.
3. The first time, click **Connect Bluetooth**, choose **Microgrid ESP32** in the browser's device picker, and approve the connection. This one-time browser permission is required; a website cannot silently pair with a new Bluetooth device.
4. The dashboard receives voltage/current notifications roughly 1.5 times per second and plots them in the browser. After the first approval, it reconnects automatically when reopened and retries while the authorized ESP32 is powered on and in range. Click **Disconnect Bluetooth** to end the connection.

The BLE service UUID is `19b10000-e8f2-537e-4f6c-d104768a1214`; its read/notify characteristic UUID is `19b10001-e8f2-537e-4f6c-d104768a1214`. The characteristic sends voltage and current as two little-endian 32-bit floats, fitting within the default BLE MTU.

The connection is direct from the PC browser to the ESP32. Each PC that needs readings must connect to the ESP32 over BLE; GitHub Pages does not relay sensor data.

## Sensors

The ESP32 firmware reads an ACS712-20A current sensor on GPIO34 and a battery voltage sensor on GPIO35. Current uses 0.100 V/A sensitivity, a 2.32 V zero-current offset, 10 averaged ADC samples, and a Kalman filter. Battery voltage uses a 0.93 slope, 0.95 V regression offset, a 4.8 divider ratio, and 20 averaged ADC samples. Verify calibration against the hardware and keep ADC inputs within 0–3.3 V.
