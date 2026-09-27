// AMB82-MINI 語音控制 LED 韌體 v3
// 協定：<請求編號> <指令>\n，例如 1 BLUE_ON
// 閃爍由 millis() 排程，可隨時處理 STOP。HIGH 亮、LOW 滅。
#include <Arduino.h>
#include <string.h>
#include <stdlib.h>

#if !defined(BOARD_AMB82_MINI)
#error "Select AMB82-MINI."
#endif
static_assert(LED_B == 23 && LED_G == 24, "Check LED mapping.");
struct Lamp {
  int pin;
  bool on;
  bool blinking;
  uint8_t edges;
  unsigned long next;
  unsigned long requestId;
};
Lamp blue = {LED_B, false, false, 0, 0, 0};
Lamp green = {LED_G, false, false, 0, 0, 0};
char line[80];
size_t used = 0;
bool discard = false;
unsigned long lastHost = 0;
const unsigned long BLINK_MS = 400;
const unsigned long LINK_TIMEOUT_MS = 3000;

void writeLamp(Lamp &lamp, bool on) {
  lamp.on = on;
  digitalWrite(lamp.pin, on ? HIGH : LOW);
}
void emit(unsigned long id, const char *event, const char *command, const char *error) {
  Serial.print("{\"v\":3,\"id\":"); Serial.print(id);
  Serial.print(",\"event\":\""); Serial.print(event);
  Serial.print("\",\"command\":\""); Serial.print(command);
  Serial.print("\",\"blue\":"); Serial.print(blue.on ? "true" : "false");
  Serial.print(",\"green\":"); Serial.print(green.on ? "true" : "false");
  Serial.print(",\"blueBlinking\":"); Serial.print(blue.blinking ? "true" : "false");
  Serial.print(",\"greenBlinking\":"); Serial.print(green.blinking ? "true" : "false");
  Serial.print(",\"error\":\""); Serial.print(error); Serial.println("\"}");
}
void stopBlinking() {
  blue.blinking = false;
  green.blinking = false; // 保持停止當下輸出，並非關燈指令。
}
void setLamp(Lamp &lamp, bool on) {
  lamp.blinking = false;
  writeLamp(lamp, on);
}
void startBlink(Lamp &lamp, unsigned long id) {
  lamp.blinking = true;
  lamp.edges = 0;
  lamp.requestId = id;
  writeLamp(lamp, false); // 先熄滅，再做三次完整亮／滅，最後保持滅。
  lamp.next = millis() + BLINK_MS;
}
void tickLamp(Lamp &lamp, const char *command) {
  if (!lamp.blinking || static_cast<long>(millis() - lamp.next) < 0) return;
  writeLamp(lamp, !lamp.on);
  ++lamp.edges;
  lamp.next = millis() + BLINK_MS;
  if (lamp.edges == 6) lamp.blinking = false;
  emit(lamp.requestId, lamp.blinking ? "state" : "done", command, "");
}
void handleLine(char *input) {
  char *separator = strchr(input, ' ');
  if (!separator || separator == input) { emit(0, "error", "", "BAD_FRAME"); return; }
  *separator = '\0';
  if (strlen(input) > 9) { emit(0, "error", "", "BAD_ID"); return; }
  for (char *p = input; *p; ++p) {
    if (*p < '0' || *p > '9') { emit(0, "error", "", "BAD_ID"); return; }
  }
  unsigned long id = strtoul(input, nullptr, 10);
  if (!id) { emit(0, "error", "", "BAD_ID"); return; }
  const char *command = separator + 1;
  if (strcmp(command, "BLUE_ON") == 0) setLamp(blue, true);
  else if (strcmp(command, "GREEN_ON") == 0) setLamp(green, true);
  else if (strcmp(command, "BLUE_OFF") == 0) setLamp(blue, false);
  else if (strcmp(command, "GREEN_OFF") == 0) setLamp(green, false);
  else if (strcmp(command, "BLUE_BLINK3") == 0) startBlink(blue, id);
  else if (strcmp(command, "GREEN_BLINK3") == 0) startBlink(green, id);
  else if (strcmp(command, "ALL_OFF") == 0) { setLamp(blue, false); setLamp(green, false); }
  else if (strcmp(command, "STOP") == 0) stopBlinking();
  else if (strcmp(command, "STATUS") != 0) { emit(id, "error", "", "UNKNOWN_COMMAND"); return; }
  lastHost = millis();
  emit(id, "ack", command, "");
}
void setup() {
  Serial.begin(115200);
  pinMode(LED_B, OUTPUT); pinMode(LED_G, OUTPUT);
  writeLamp(blue, false); writeLamp(green, false);
  lastHost = millis();
  delay(500);
  emit(0, "ready", "BOOT", "");
}
void loop() {
  // 每輪讀取有上限，避免大量輸入讓定時工作無法執行。
  for (int n = 0; n < 128 && Serial.available() > 0; ++n) {
    int value = Serial.read();
    if (value < 0) break;
    char c = static_cast<char>(value);
    if (c == '\r' || c == '\n') {
      if (discard) emit(0, "error", "", "INVALID_OR_TOO_LONG");
      else if (used) { line[used] = '\0'; handleLine(line); }
      used = 0; discard = false;
    } else if (!discard) {
      if (value < 32 || value > 126 || used >= sizeof(line) - 1) discard = true;
      else line[used++] = c;
    }
  }
  if ((blue.blinking || green.blinking) && millis() - lastHost >= LINK_TIMEOUT_MS) {
    stopBlinking(); emit(0, "stopped", "STOP", "HOST_TIMEOUT");
  }
  tickLamp(blue, "BLUE_BLINK3"); tickLamp(green, "GREEN_BLINK3");
  delay(1);
}
