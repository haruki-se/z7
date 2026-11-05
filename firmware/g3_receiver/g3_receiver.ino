/* Guitar Motion Lab / ESP32 receive-only prototype.
 * NO MOTOR OUTPUT. ACK mode DRY means packet accepted, not movement verified.
 * Arduino-ESP32 core with WiFi.h / WiFiUdp.h; no extra libraries required.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <math.h>
#include <errno.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

WiFiUDP udp;
char currentSession[9] = "";
uint32_t lastSeq = 0, lastPacketAt = 0;
bool haveSession = false, expired = true, udpReady = false;
float speedCommand = 0, turnCommand = 0;
const uint32_t WATCHDOG_MS = 350;

void stopMotion() {
  speedCommand = turnCommand = 0;
  // No GPIO is driven. Add a board-specific motor adapter only after hardware selection.
}

void watchdog() {
  if (haveSession && millis() - lastPacketAt > WATCHDOG_MS) {
    stopMotion(); expired = true;
  }
}

bool receiveCommand(char *line, char *ack, size_t ackSize) {
  watchdog();
  char *parts[7], *save = nullptr;
  char *part = strtok_r(line, ",", &save);
  int count = 0;
  while (part && count < 7) { parts[count++] = part; part = strtok_r(nullptr, ",", &save); }
  if (part || count != 7 || strcmp(parts[0], "G3") || strcmp(parts[1], "1")) return false;
  if (strlen(parts[2]) != 8 || strspn(parts[2], "0123456789abcdef") != 8) return false;
  if (!strlen(parts[3]) || strspn(parts[3], "0123456789") != strlen(parts[3])) return false;
  char *end = nullptr;
  errno = 0;
  unsigned long seqLong = strtoul(parts[3], &end, 10);
  if (errno || *end || seqLong > UINT32_MAX) return false;
  uint32_t seq = (uint32_t)seqLong;
  if (strcmp(parts[4], "0") && strcmp(parts[4], "1")) return false;
  bool enabled = !strcmp(parts[4], "1");
  float speed = strtof(parts[5], &end);
  if (end == parts[5] || *end || !isfinite(speed) || speed < 0 || speed > .6f) return false;
  float turn = strtof(parts[6], &end);
  if (end == parts[6] || *end || !isfinite(turn) || turn < -.6f || turn > .6f) return false;
  if (!enabled && (speed != 0 || turn != 0)) return false;
  if (!haveSession || strcmp(currentSession, parts[2])) {
    if (enabled) return false;
    strcpy(currentSession, parts[2]); haveSession = true; expired = false;
    lastSeq = seq;  // The first packet establishes the zero-command session.
  } else {
    if (seq <= lastSeq || (enabled && expired)) return false;
    lastSeq = seq;
  }
  lastPacketAt = millis();
  if (enabled) { speedCommand = speed; turnCommand = turn; } else stopMotion();
  snprintf(ack, ackSize, "G3ACK,1,%s,%lu,DRY\n", currentSession, (unsigned long)lastSeq);
  return true;
}

void setup() {
  Serial.begin(115200);
  stopMotion();
  Serial.println("Guitar Motion Lab: DRY receiver; no motor GPIO output.");
  if (strlen(WIFI_SSID)) { WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); }
}

void loop() {
  watchdog();
  if (WiFi.status() == WL_CONNECTED && !udpReady) {
    udpReady = udp.begin(UDP_PORT);
    Serial.print("UDP receiver IP: "); Serial.println(WiFi.localIP());
  } else if (WiFi.status() != WL_CONNECTED && udpReady) {
    udp.stop(); udpReady = false; stopMotion(); expired = true;
  }
  char packet[192], ack[80];
  if (udpReady) {
    int size = udp.parsePacket();
    if (size > 0) {
      if (size >= (int)sizeof(packet)) { while (udp.available()) udp.read(); }
      else {
        int length = udp.read(packet, sizeof(packet) - 1); packet[max(0, length)] = 0;
        while (length > 0 && (packet[length - 1] == '\n' || packet[length - 1] == '\r')) packet[--length] = 0;
        if (length > 0 && receiveCommand(packet, ack, sizeof(ack))) {
          udp.beginPacket(udp.remoteIP(), udp.remotePort()); udp.write((const uint8_t *)ack, strlen(ack)); udp.endPacket();
        }
      }
    }
  }
  // Same protocol can be checked manually over USB serial at 115200 baud.
  static char serialLine[192]; static size_t used = 0; static bool overflow = false;
  int budget = 256;
  while (Serial.available() && budget-- > 0) {
    char c = Serial.read();
    if (c == '\n') {
      serialLine[used] = 0;
      if (!overflow && used && receiveCommand(serialLine, ack, sizeof(ack))) Serial.print(ack);
      used = 0; overflow = false;
    } else if (c != '\r') {
      if (used < sizeof(serialLine) - 1) serialLine[used++] = c; else overflow = true;
    }
  }
  static uint32_t lastReport = 0;
  if (millis() - lastReport > 500) {
    Serial.printf("DRY speed=%.3f turn=%.3f watchdog=%s\n", speedCommand, turnCommand, expired ? "STOP" : "OK");
    lastReport = millis();
  }
  delay(1);
}
