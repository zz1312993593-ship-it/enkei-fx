//+------------------------------------------------------------------+
//| EnkeiQuotePublisher.mq4                                         |
//| Read-only MT4 quote and multi-period history publisher.         |
//| No trading, account, order, or position functions are used.     |
//+------------------------------------------------------------------+
#property strict
#property version   "1.70"

input int PublishSeconds = 1;
input int HistoryRefreshMinutes = 2;
input string WatchSymbols = "USDJPY,EURUSD,EURJPY,GBPUSD,GBPJPY,AUDJPY";
// 高频执行周期只需要足够稳健的研究窗口。反复重写 20,000 根分钟线
// 会阻塞 MT4 定时器，使最新 M5 文件在一轮导出中反而过期。
input int HistoryBarsM1 = 5000;
input int HistoryBarsM5 = 6000;
input int HistoryBarsM15 = 6000;
input int HistoryBarsH1 = 8000;
input int HistoryBarsH4 = 5000;
input int HistoryBarsD1 = 3000;
input int HistoryBarsW1 = 1500;
input int HistoryBarsMN1 = 600;

string SnapshotFile = "enkei\\market-snapshot.json";
string HistorySymbols[];
int HistorySymbolCount = 0;
int HistoryJobIndex = 0;
datetime HistoryCycleFinishedAt = 0;

int OnInit() {
  EventSetTimer(MathMax(1, PublishSeconds));
  Print("Enkei quote publisher started (read-only). Auto trading is not required.");
  HistorySymbolCount = StringSplit(WatchSymbols, ',', HistorySymbols);
  for (int index = 0; index < HistorySymbolCount; index++) {
    StringTrimLeft(HistorySymbols[index]);
    StringTrimRight(HistorySymbols[index]);
  }
  PublishSnapshot();
  PublishNextHistory();
  return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
  EventKillTimer();
}

void OnTimer() {
  PublishSnapshot();
  if (HistoryJobIndex >= HistorySymbolCount * 8 && TimeCurrent() - HistoryCycleFinishedAt >= MathMax(1, HistoryRefreshMinutes) * 60) {
    HistoryJobIndex = 0;
    Print("Enkei history refresh cycle started (read-only).");
  }
  PublishNextHistory();
}

void AppendQuote(string symbolName, string &json, int &count) {
  SymbolSelect(symbolName, true);
  double bid = MarketInfo(symbolName, MODE_BID);
  double ask = MarketInfo(symbolName, MODE_ASK);
  int symbolDigits = (int)MarketInfo(symbolName, MODE_DIGITS);
  datetime tickTime = (datetime)MarketInfo(symbolName, MODE_TIME);
  if (bid <= 0 || ask <= 0 || symbolDigits < 0) return;
  if (count > 0) json += ",";
  json += "{\"symbol\":\"" + symbolName + "\",";
  json += "\"bid\":" + DoubleToString(bid, symbolDigits) + ",";
  json += "\"ask\":" + DoubleToString(ask, symbolDigits) + ",";
  json += "\"digits\":" + IntegerToString(symbolDigits) + ",";
  json += "\"tick_time\":" + IntegerToString((int)tickTime) + "}";
  count++;
}

void PublishSnapshot() {
  RefreshRates();
  string json = "{\"quotes\":[";
  int count = 0;
  AppendQuote(Symbol(), json, count);

  string symbols[];
  int total = StringSplit(WatchSymbols, ',', symbols);
  for (int index = 0; index < total; index++) {
    StringTrimLeft(symbols[index]);
    StringTrimRight(symbols[index]);
    if (symbols[index] != "" && symbols[index] != Symbol()) AppendQuote(symbols[index], json, count);
  }
  if (count == 0) return;
  datetime serverNow = TimeCurrent();
  datetime gmtNow = TimeGMT();
  datetime localNow = TimeLocal();
  json += "],\"server_time\":\"" + TimeToString(serverNow, TIME_DATE|TIME_SECONDS) + "\",";
  json += "\"server_epoch\":" + IntegerToString((int)serverNow) + ",";
  json += "\"gmt_epoch\":" + IntegerToString((int)gmtNow) + ",";
  json += "\"local_epoch\":" + IntegerToString((int)localNow) + ",";
  json += "\"server_gmt_offset_seconds\":" + IntegerToString((int)(serverNow - gmtNow)) + "}";

  int handle = FileOpen(SnapshotFile, FILE_WRITE|FILE_TXT|FILE_COMMON);
  if (handle == INVALID_HANDLE) {
    Print("Enkei quote publisher cannot open common file. Error: ", GetLastError());
    return;
  }
  FileWrite(handle, json);
  FileClose(handle);
}

void PublishOneHistory(string symbolName, int period, string timeframeName, int requested) {
  SymbolSelect(symbolName, true);
  int available = iBars(symbolName, period);
  requested = MathMax(0, requested);
  int count = MathMin(available, requested);
  if (count < 100) {
    Print("Enkei history skipped for ", symbolName, " ", timeframeName, ": fewer than 100 bars are available.");
    return;
  }

  string historyFile = "enkei\\history\\" + symbolName + "-" + timeframeName + ".csv";
  int handle = FileOpen(historyFile, FILE_WRITE|FILE_CSV|FILE_COMMON, ',');
  if (handle == INVALID_HANDLE) {
    Print("Enkei history cannot open file for ", symbolName, " ", timeframeName, ". Error: ", GetLastError());
    return;
  }
  FileWrite(handle, "time", "open", "high", "low", "close");
  for (int shift = count - 1; shift >= 0; shift--) {
    datetime barTime = iTime(symbolName, period, shift);
    if (barTime <= 0) continue;
    int symbolDigits = (int)MarketInfo(symbolName, MODE_DIGITS);
    FileWrite(handle,
      IntegerToString((int)barTime),
      DoubleToString(iOpen(symbolName, period, shift), symbolDigits),
      DoubleToString(iHigh(symbolName, period, shift), symbolDigits),
      DoubleToString(iLow(symbolName, period, shift), symbolDigits),
      DoubleToString(iClose(symbolName, period, shift), symbolDigits)
    );
  }
  FileClose(handle);
  Print("Enkei read-only history exported for ", symbolName, " ", timeframeName, ": ", count, " bars.");
}

void PublishNextHistory() {
  if (HistorySymbolCount <= 0) return;
  if (HistoryJobIndex >= HistorySymbolCount * 8) return;
  // 先为全部品种刷新 M1，再刷新全部 M5/M15。旧顺序会先写完一个
  // 品种的八个周期，导致 USDJPY M5 在其他大文件写完前已超过安全门时限。
  int periodIndex = (HistoryJobIndex / HistorySymbolCount) % 8;
  int symbolIndex = HistoryJobIndex % HistorySymbolCount;
  string symbolName = HistorySymbols[symbolIndex];
  if (symbolName != "") {
    // Saved EA inputs from an older installation may still request 20,000 bars.
    // Inputs can request less, but cannot exceed these runtime safety caps.
    if (periodIndex == 0) PublishOneHistory(symbolName, PERIOD_M1, "M1", MathMin(HistoryBarsM1, 5000));
    if (periodIndex == 1) PublishOneHistory(symbolName, PERIOD_M5, "M5", MathMin(HistoryBarsM5, 6000));
    if (periodIndex == 2) PublishOneHistory(symbolName, PERIOD_M15, "M15", MathMin(HistoryBarsM15, 6000));
    if (periodIndex == 3) PublishOneHistory(symbolName, PERIOD_H1, "H1", MathMin(HistoryBarsH1, 8000));
    if (periodIndex == 4) PublishOneHistory(symbolName, PERIOD_H4, "H4", MathMin(HistoryBarsH4, 5000));
    if (periodIndex == 5) PublishOneHistory(symbolName, PERIOD_D1, "D1", MathMin(HistoryBarsD1, 3000));
    if (periodIndex == 6) PublishOneHistory(symbolName, PERIOD_W1, "W1", MathMin(HistoryBarsW1, 1500));
    if (periodIndex == 7) PublishOneHistory(symbolName, PERIOD_MN1, "MN1", MathMin(HistoryBarsMN1, 600));
  }
  HistoryJobIndex++;
  if (HistoryJobIndex >= HistorySymbolCount * 8) {
    HistoryCycleFinishedAt = TimeCurrent();
    Print("Enkei history refresh cycle complete (read-only).");
  }
}
