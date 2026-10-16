#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include "secrets.h"

const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;

WebServer server(80);
float latestVoltage = 0;
float latestCurrent = 0;
BLECharacteristic* readingCharacteristic;
const char* BLE_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const char* BLE_READING_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";

const int CURRENT_SENSOR_PIN = 34;
const int BATTERY_VOLTAGE_SENSOR_PIN = 35;
const float CURRENT_SENSOR_SENSITIVITY = 0.100;
const float CURRENT_SENSOR_OFFSET = 2.32;
const float BATTERY_VOLTAGE_SLOPE = 0.93;
const float BATTERY_VOLTAGE_OFFSET = 0.95;
const float BATTERY_VOLTAGE_DIVIDER_RATIO = 4.8;
float currentEstimate = 0.0;
float kalmanError = 1.0;
const float KALMAN_PROCESS_NOISE = 0.005;
const float KALMAN_MEASUREMENT_NOISE = 0.02;
const char* LETS_ENCRYPT_ROOT_CA = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";
unsigned long lastTelemetryUpload = 0;

float readCalibratedCurrent() {
  const int samples = 10;
  float voltageSum = 0.0;
  for (int i = 0; i < samples; i++) {
    voltageSum += (analogRead(CURRENT_SENSOR_PIN) / 4095.0) * 3.3;
    delay(5);
  }

  const float sensorVoltage = voltageSum / samples;
  const float measuredCurrent = (sensorVoltage - CURRENT_SENSOR_OFFSET) / CURRENT_SENSOR_SENSITIVITY;

  kalmanError += KALMAN_PROCESS_NOISE;
  const float gain = kalmanError / (kalmanError + KALMAN_MEASUREMENT_NOISE);
  currentEstimate += gain * (measuredCurrent - currentEstimate);
  kalmanError *= 1.0 - gain;
  return currentEstimate;
}

float readCalibratedBatteryVoltage() {
  const int samples = 20;
  long rawSum = 0;
  for (int i = 0; i < samples; i++) {
    rawSum += analogRead(BATTERY_VOLTAGE_SENSOR_PIN);
    delay(5);
  }

  const int rawAverage = rawSum / samples;
  const float adcVoltage = (rawAverage / 4095.0) * 3.3;
  const float inputVoltage = adcVoltage * BATTERY_VOLTAGE_DIVIDER_RATIO;
  return BATTERY_VOLTAGE_SLOPE * inputVoltage + BATTERY_VOLTAGE_OFFSET;
}

void setup_bluetooth() {
  BLEDevice::init("Microgrid ESP32");
  BLEServer* bleServer = BLEDevice::createServer();
  BLEService* service = bleServer->createService(BLE_SERVICE_UUID);
  readingCharacteristic = service->createCharacteristic(
    BLE_READING_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  readingCharacteristic->addDescriptor(new BLE2902());
  String telemetry = "{\"voltage\":" + String(latestVoltage, 2);
  telemetry += ",\"current\":" + String(latestCurrent, 2) + "}";
  readingCharacteristic->setValue(telemetry.c_str());
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// Connect WiFi
void setup_wifi() {
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}

void handleData() {
  String response = "{\"voltage\":" + String(latestVoltage, 2);
  response += ",\"current\":" + String(latestCurrent, 2) + "}";
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", response);
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

void uploadTelemetry() {
  WiFiClientSecure client;
  client.setCACert(LETS_ENCRYPT_ROOT_CA);

  HTTPClient http;
  if (!http.begin(client, TELEMETRY_API_URL)) {
    Serial.println("Could not start telemetry HTTPS request");
    return;
  }

  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + TELEMETRY_TOKEN);
  String telemetry = "{\"voltage\":" + String(latestVoltage, 2);
  telemetry += ",\"current\":" + String(latestCurrent, 2) + "}";
  const int status = http.POST(telemetry);
  if (status < 200 || status >= 300) {
    Serial.printf("Telemetry upload failed with status %d\n", status);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(CURRENT_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(BATTERY_VOLTAGE_SENSOR_PIN, ADC_11db);
  pinMode(CURRENT_SENSOR_PIN, INPUT);
  pinMode(BATTERY_VOLTAGE_SENSOR_PIN, INPUT);
  latestVoltage = readCalibratedBatteryVoltage();
  latestCurrent = readCalibratedCurrent();

  setup_wifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  time_t currentTime = time(nullptr);
  for (int attempts = 0; currentTime < 1710000000 && attempts < 30; attempts++) {
    delay(500);
    currentTime = time(nullptr);
  }
  if (currentTime < 1710000000) {
    Serial.println("Could not synchronize time; HTTPS certificate validation may fail");
  }
  setup_bluetooth();

  MDNS.begin("esp32-microgrid");

  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.begin();
}

void loop() {
  server.handleClient();

  latestVoltage = readCalibratedBatteryVoltage();
  latestCurrent = readCalibratedCurrent();
  String telemetry = "{\"voltage\":" + String(latestVoltage, 2);
  telemetry += ",\"current\":" + String(latestCurrent, 2) + "}";

  readingCharacteristic->setValue(telemetry.c_str());
  readingCharacteristic->notify();

  const unsigned long now = millis();
  if (now - lastTelemetryUpload >= 2000) {
    lastTelemetryUpload = now;
    uploadTelemetry();
  }

  delay(500);
}
