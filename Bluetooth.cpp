#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <cstring>

const char* BLE_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const char* BLE_READING_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";

const int CURRENT_SENSOR_PIN = 34;
const int BATTERY_VOLTAGE_SENSOR_PIN = 35;
const float CURRENT_SENSOR_SENSITIVITY = 0.100;
const float CURRENT_SENSOR_OFFSET = 2.32;
const float BATTERY_VOLTAGE_SLOPE = 0.93;
const float BATTERY_VOLTAGE_OFFSET = 0.95;
const float BATTERY_VOLTAGE_DIVIDER_RATIO = 4.8;
const float KALMAN_PROCESS_NOISE = 0.005;
const float KALMAN_MEASUREMENT_NOISE = 0.02;

float latestVoltage = 0;
float latestCurrent = 0;
float currentEstimate = 0;
float kalmanError = 1.0;
BLECharacteristic* readingCharacteristic;

float readCalibratedCurrent() {
  const int samples = 10;
  float voltageSum = 0;
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

void updateBluetoothReading(bool notify) {
  uint8_t payload[sizeof(float) * 2];
  memcpy(payload, &latestVoltage, sizeof(latestVoltage));
  memcpy(payload + sizeof(latestVoltage), &latestCurrent, sizeof(latestCurrent));
  readingCharacteristic->setValue(payload, sizeof(payload));
  if (notify) readingCharacteristic->notify();
}

void setupBluetooth() {
  BLEDevice::init("Microgrid ESP32");
  BLEServer* bleServer = BLEDevice::createServer();
  BLEService* service = bleServer->createService(BLE_SERVICE_UUID);
  readingCharacteristic = service->createCharacteristic(
    BLE_READING_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  readingCharacteristic->addDescriptor(new BLE2902());
  updateBluetoothReading(false);
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
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
  setupBluetooth();
}

void loop() {
  latestVoltage = readCalibratedBatteryVoltage();
  latestCurrent = readCalibratedCurrent();
  updateBluetoothReading(true);
  delay(500);
}
