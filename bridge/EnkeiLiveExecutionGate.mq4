//+------------------------------------------------------------------+
//| EnkeiLiveExecutionGate.mq4                                      |
//| LIVE-ONLY, manually paired local intent executor.               |
//| This EA touches REAL money. Never attach to a demo terminal.    |
//| It stays inert unless BOTH the local gate enablement is armed   |
//| AND AllowLiveSpeculativeExecution is set to true.               |
//+------------------------------------------------------------------+
#property strict
#property version   "1.70"

input int    MagicNumber = 826091;
input double HardMaxLots = 1.00;
input int    MaxOpenLivePositions = 10;
input double DailyLossLimit = 50.0;
input bool   AllowLiveSpeculativeExecution = false;
input bool   EnableDynamicProfitProtection = false;
input double BreakevenTriggerPips = 8.0;
input double TrailStartPips = 12.0;
input double TrailDistancePips = 6.0;

string TicketFile = "enkei\\live-execution\\pending-live-ticket.csv";
string CloseFile = "enkei\\live-execution\\pending-live-close.csv";
string KillFile = "enkei\\live-execution\\KILL.switch";
string AuditFile = "enkei\\live-execution\\live-execution-audit.csv";
string EnablementFile = "enkei\\live-execution\\live-enablement.flat";
string AccountSnapshotFile = "enkei\\live-execution\\live-account-snapshot.json";
string PolicyMapFile = "enkei\\live-execution\\live-policy-map.csv";

bool ReadEnablement(string &envMarker, string &brokerName, string &accountNumber) {
   if(!FileIsExist(EnablementFile, FILE_COMMON)) return false;
   int handle = FileOpen(EnablementFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return false;
   string liveFlag = FileReadString(handle);
   envMarker = FileReadString(handle);
   brokerName = FileReadString(handle);
   accountNumber = FileReadString(handle);
   FileClose(handle);
   return liveFlag == "1" && StringLen(envMarker) >= 10;
}

bool IsLiveAccount() {
   string server = AccountServer();
   string company = AccountCompany();
   StringToLower(server);
   StringToLower(company);
   return StringFind(server, "demo") < 0 && StringFind(company, "demo") < 0;
}

bool BrokerMatches(string requiredBroker) {
   if(StringLen(requiredBroker) < 2) return false;
   string server = AccountServer();
   string company = AccountCompany();
   StringToUpper(server);
   StringToUpper(company);
   StringToUpper(requiredBroker);
   return StringFind(server, requiredBroker) >= 0 || StringFind(company, requiredBroker) >= 0
       || StringFind(requiredBroker, server) >= 0 || StringFind(requiredBroker, company) >= 0;
}

double PipSize(string symbol) {
   return StringFind(symbol, "JPY") >= 0 ? 0.01 : 0.0001;
}

void Audit(string eventName, string detail) {
   int handle = FileOpen(AuditFile, FILE_CSV|FILE_READ|FILE_WRITE|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   FileSeek(handle, 0, SEEK_END);
   FileWrite(handle, TimeToString(TimeLocal(), TIME_DATE|TIME_SECONDS), "EA", eventName, detail);
   FileClose(handle);
}

int OpenLivePositions() {
   int total = 0;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(OrderSelect(index, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber) total++;
   }
   return total;
}

string SideName(int command) { return command == OP_BUY ? "long" : "short"; }

void ManageOpenPositions() {
   if(!EnableDynamicProfitProtection) return;
   for(int i=OrdersTotal()-1; i>=0; i--) {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES) || OrderMagicNumber()!=MagicNumber) continue;
      int type=OrderType(); if(type!=OP_BUY && type!=OP_SELL) continue;
      string symbol=OrderSymbol(); double pip=PipSize(symbol); int digits=(int)MarketInfo(symbol, MODE_DIGITS);
      double bid=MarketInfo(symbol, MODE_BID), ask=MarketInfo(symbol, MODE_ASK);
      double profitPips=type==OP_BUY ? (bid-OrderOpenPrice())/pip : (OrderOpenPrice()-ask)/pip;
      double desired=OrderStopLoss();
      if(profitPips>=BreakevenTriggerPips) desired=type==OP_BUY ? MathMax(desired,OrderOpenPrice()) : (desired<=0 ? OrderOpenPrice() : MathMin(desired,OrderOpenPrice()));
      if(profitPips>=TrailStartPips) desired=type==OP_BUY ? MathMax(desired,bid-TrailDistancePips*pip) : (desired<=0 ? ask+TrailDistancePips*pip : MathMin(desired,ask+TrailDistancePips*pip));
      desired=NormalizeDouble(desired,digits);
      bool improves=type==OP_BUY ? desired>OrderStopLoss()+pip*.1 : (OrderStopLoss()<=0 || desired<OrderStopLoss()-pip*.1);
      if(improves && !OrderModify(OrderTicket(),OrderOpenPrice(),desired,OrderTakeProfit(),0,clrGreen)) Audit("dynamic-protection-failed",IntegerToString(OrderTicket())+" error="+IntegerToString(GetLastError()));
      else if(improves) Audit("dynamic-protection-updated",IntegerToString(OrderTicket())+" stop="+DoubleToString(desired,digits));
   }
}

void SavePolicyMap(int ticket, string policyId, string requestId, string timeframe, double spreadPips, double requestedPrice, double actualPrice) {
   int handle = FileOpen(PolicyMapFile, FILE_CSV|FILE_READ|FILE_WRITE|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   FileSeek(handle, 0, SEEK_END);
   FileWrite(handle, ticket, policyId, requestId, timeframe, spreadPips, MathAbs(actualPrice-requestedPrice)/PipSize(OrderSymbol()));
   FileClose(handle);
}

void ReadPolicyMap(int ticket, string &policyId, string &requestId, string &timeframe, double &spreadPips, double &slippagePips) {
   policyId = ""; requestId = ""; timeframe = ""; spreadPips = 0; slippagePips = 0;
   int handle = FileOpen(PolicyMapFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   while(!FileIsEnding(handle)) {
      int mappedTicket = (int)FileReadNumber(handle);
      string mappedPolicy = FileReadString(handle);
      string mappedRequest = FileReadString(handle);
      string mappedTimeframe = FileReadString(handle);
      double mappedSpread = FileReadNumber(handle);
      double mappedSlippage = FileReadNumber(handle);
      if(mappedTicket == ticket) { policyId = mappedPolicy; requestId = mappedRequest; timeframe = mappedTimeframe; spreadPips = mappedSpread; slippagePips = mappedSlippage; }
   }
   FileClose(handle);
}

// Realized loss of this EA's positions closed on the current broker day.
// The gate's local mirror is advisory; this MT4-side count is authoritative.
double TodayRealizedLoss() {
   double loss = 0;
   for(int index = OrdersHistoryTotal() - 1; index >= 0; index--) {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_HISTORY)) continue;
      if(OrderMagicNumber() != MagicNumber) continue;
      if(OrderCloseTime() <= 0) continue;
      if(TimeDay(OrderCloseTime()) != TimeDay(TimeCurrent())) continue;
      double profit = OrderProfit() + OrderSwap() + OrderCommission();
      if(profit < 0) loss += -profit;
   }
   return loss;
}

int TodayEntries() {
   int count = 0;
   for(int index = OrdersHistoryTotal() - 1; index >= 0; index--) {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_HISTORY)) continue;
      if(OrderMagicNumber() != MagicNumber) continue;
      if(OrderOpenTime() <= 0) continue;
      if(TimeDay(OrderOpenTime()) != TimeDay(TimeCurrent())) continue;
      count++;
   }
   return count;
}

// Publishes read-only account state plus this EA's own live positions.
// Never writes a password, API key or untrusted position from another EA.
void PublishLiveAccount() {
   int handle = FileOpen(AccountSnapshotFile, FILE_TXT|FILE_WRITE|FILE_COMMON|FILE_ANSI);
   if(handle == INVALID_HANDLE) return;
   string body = "{\"mode\":\"live-only\",\"updated_at\":\"" + TimeToString(TimeLocal(), TIME_DATE|TIME_SECONDS) + "\",\"updated_at_epoch\":" + IntegerToString((int)TimeLocal()) + ",\"account\":{\"login\":" + IntegerToString((int)AccountNumber()) + ",\"balance\":%.2f,\"equity\":%.2f,\"free_margin\":%.2f,\"margin\":%.2f,\"leverage\":" + IntegerToString(AccountLeverage()) + ",\"server\":\"" + AccountServer() + "\",\"currency\":\"" + AccountCurrency() + "\"},\"today\":{\"date\":\"" + TimeToString(TimeCurrent(), TIME_DATE) + "\",\"realized_loss\":%.2f,\"entries\":" + IntegerToString(TodayEntries()) + "},\"positions\":[";
   body = StringFormat(body, AccountBalance(), AccountEquity(), AccountFreeMargin(), AccountMargin(), TodayRealizedLoss());
   bool first = true;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES) || OrderMagicNumber() != MagicNumber) continue;
      string symbol = OrderSymbol();
      double currentPrice = OrderType() == OP_BUY ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
      string policyId, requestId, timeframe; double entrySpread, slippage;
      ReadPolicyMap(OrderTicket(), policyId, requestId, timeframe, entrySpread, slippage);
      if(!first) body += ",";
      first = false;
      body += StringFormat("{\"ticket\":%d,\"policy_id\":\"%s\",\"request_id\":\"%s\",\"timeframe\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"lots\":%.2f,\"open_price\":%.5f,\"current_price\":%.5f,\"stop_loss\":%.5f,\"take_profit\":%.5f,\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"spread_pips\":%.3f,\"slippage_pips\":%.3f}", OrderTicket(), policyId, requestId, timeframe, symbol, SideName(OrderType()), OrderLots(), OrderOpenPrice(), currentPrice, OrderStopLoss(), OrderTakeProfit(), OrderProfit(), OrderSwap(), OrderCommission(), entrySpread, slippage);
   }
   body += "],\"closed_positions\":[";
   first = true;
   int emitted = 0;
   for(int historyIndex = OrdersHistoryTotal() - 1; historyIndex >= 0 && emitted < 50; historyIndex--) {
      if(!OrderSelect(historyIndex, SELECT_BY_POS, MODE_HISTORY) || OrderMagicNumber() != MagicNumber || OrderCloseTime() <= 0) continue;
      string closedPolicy, closedRequest, closedTimeframe; double closedSpread, closedSlippage;
      ReadPolicyMap(OrderTicket(), closedPolicy, closedRequest, closedTimeframe, closedSpread, closedSlippage);
      if(StringLen(closedPolicy) < 8) continue;
      if(!first) body += ",";
      first = false; emitted++;
      body += StringFormat("{\"ticket\":%d,\"policy_id\":\"%s\",\"request_id\":\"%s\",\"timeframe\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"lots\":%.2f,\"open_price\":%.5f,\"close_price\":%.5f,\"opened_at\":\"%s\",\"closed_at\":\"%s\",\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"spread_pips\":%.3f,\"slippage_pips\":%.3f}", OrderTicket(), closedPolicy, closedRequest, closedTimeframe, OrderSymbol(), SideName(OrderType()), OrderLots(), OrderOpenPrice(), OrderClosePrice(), TimeToString(OrderOpenTime(), TIME_DATE|TIME_SECONDS), TimeToString(OrderCloseTime(), TIME_DATE|TIME_SECONDS), OrderProfit(), OrderSwap(), OrderCommission(), closedSpread, closedSlippage);
   }
   body += "]}";
   FileWriteString(handle, body);
   FileClose(handle);
}

void RejectAndDelete(string id, string reason) {
   Audit("live-ticket-rejected", id + " " + reason);
   FileDelete(TicketFile, FILE_COMMON);
}

void CloseRejectAndDelete(string id, string reason) {
   Audit("live-close-rejected", id + " " + reason);
   FileDelete(CloseFile, FILE_COMMON);
}

// ticket=0 closes every live position created by THIS EA (MagicNumber filter).
void ProcessCloseAction() {
   // Emergency stop blocks risk-increasing entries, never a risk-reducing close.
   if(!FileIsExist(CloseFile, FILE_COMMON)) return;
   if(!AllowLiveSpeculativeExecution) { CloseRejectAndDelete("disabled", "execution-disabled"); return; }
   if(!IsLiveAccount()) { CloseRejectAndDelete("unknown", "non-live-account"); return; }
   if(!IsTradeAllowed() || !IsConnected()) { CloseRejectAndDelete("terminal", "terminal-not-ready"); return; }

   string envMarker, brokerName, accountNumber;
   if(!ReadEnablement(envMarker, brokerName, accountNumber)) { CloseRejectAndDelete("unknown", "enablement-not-armed"); return; }
   string expectedAccount = IntegerToString((int)AccountNumber());
   if(accountNumber != expectedAccount || !BrokerMatches(brokerName)) { CloseRejectAndDelete("unknown", "account-mismatch"); return; }

   int handle = FileOpen(CloseFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   string id = FileReadString(handle);
   int createdAt = (int)FileReadNumber(handle);
   int expiresAt = (int)FileReadNumber(handle);
   int requestedTicket = (int)FileReadNumber(handle);
   string closeMarker = FileReadString(handle);
   FileClose(handle);
   if(StringLen(id) < 8 || expiresAt <= createdAt || expiresAt - createdAt > 95) { CloseRejectAndDelete(id, "invalid-close-time"); return; }
   if(closeMarker != envMarker) { CloseRejectAndDelete(id, "env-marker-mismatch"); return; }

   int closed = 0;
   int failed = 0;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES)) continue;
      if(OrderMagicNumber() != MagicNumber) continue;
      if(requestedTicket > 0 && OrderTicket() != requestedTicket) continue;
      int type = OrderType();
      if(type != OP_BUY && type != OP_SELL) continue;
      string symbol = OrderSymbol();
      double price = type == OP_BUY ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
      if(price <= 0 || !OrderClose(OrderTicket(), OrderLots(), price, 3, clrSilver)) failed++;
      else closed++;
   }
   Audit(failed > 0 ? "live-close-partial" : "live-close-success", id + " closed=" + IntegerToString(closed) + " failed=" + IntegerToString(failed));
   FileDelete(CloseFile, FILE_COMMON);
}

void ProcessTicket() {
   if(FileIsExist(KillFile, FILE_COMMON)) return;
   if(!FileIsExist(TicketFile, FILE_COMMON)) return;
   if(!AllowLiveSpeculativeExecution) { RejectAndDelete("disabled", "execution-disabled"); return; }
   if(!IsLiveAccount()) { if(FileIsExist(TicketFile, FILE_COMMON)) RejectAndDelete("unknown", "non-live-account"); return; }
   if(!IsTradeAllowed() || !IsConnected()) { RejectAndDelete("terminal", "terminal-not-ready"); return; }

   string envMarker, brokerName, accountNumber;
   if(!ReadEnablement(envMarker, brokerName, accountNumber)) { RejectAndDelete("unknown", "enablement-not-armed"); return; }
   string expectedAccount = IntegerToString((int)AccountNumber());
   if(accountNumber != expectedAccount || !BrokerMatches(brokerName)) { RejectAndDelete("unknown", "account-mismatch"); return; }
   if(DailyLossLimit <= 0) { RejectAndDelete("unknown", "daily-loss-limit-not-configured"); return; }

   int handle = FileOpen(TicketFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   string id = FileReadString(handle);
   int createdAt = (int)FileReadNumber(handle);
   int expiresAt = (int)FileReadNumber(handle);
   string symbol = FileReadString(handle);
   string side = FileReadString(handle);
   double lots = FileReadNumber(handle);
   double stopLoss = FileReadNumber(handle);
   double takeProfit = FileReadNumber(handle);
   double maxSpreadPips = FileReadNumber(handle);
   string ticketMarker = FileReadString(handle);
   int    ticketVersion = (int)FileReadNumber(handle);
   double ticketDailyLimit = FileReadNumber(handle);
   string policyId = FileReadString(handle);
   string requestId = FileReadString(handle);
   string timeframe = FileReadString(handle);
   FileClose(handle);

   if(StringLen(id) < 8 || StringLen(policyId) < 8 || StringLen(requestId) < 8 || (timeframe != "M5" && timeframe != "M15") || expiresAt <= createdAt || expiresAt - createdAt > 95) { RejectAndDelete(id, "invalid-ticket-identity-or-time"); return; }
   if(ticketMarker != envMarker) { RejectAndDelete(id, "env-marker-mismatch"); return; }
   if(lots < 0.01 || lots > HardMaxLots || lots > 1.00) { RejectAndDelete(id, "lot-limit"); return; }
   if(OpenLivePositions() >= MaxOpenLivePositions) { RejectAndDelete(id, "open-position-limit"); return; }
   double effectiveDailyLimit = ticketDailyLimit > 0 ? MathMin(ticketDailyLimit, DailyLossLimit) : DailyLossLimit;
   if(TodayRealizedLoss() >= effectiveDailyLimit) { RejectAndDelete(id, "daily-loss-limit"); return; }
   if(!SymbolSelect(symbol, true)) { RejectAndDelete(id, "symbol-unavailable"); return; }

   double ask = MarketInfo(symbol, MODE_ASK);
   double bid = MarketInfo(symbol, MODE_BID);
   int digits = (int)MarketInfo(symbol, MODE_DIGITS);
   double point = MarketInfo(symbol, MODE_POINT);
   double stopLevel = MarketInfo(symbol, MODE_STOPLEVEL) * point;
   if(ask <= 0 || bid <= 0) { RejectAndDelete(id, "missing-price"); return; }
   double spreadPips = (ask - bid) / PipSize(symbol);
   if(maxSpreadPips > 0 && spreadPips > maxSpreadPips) { RejectAndDelete(id, "spread-limit actual=" + DoubleToString(spreadPips, 2) + " limit=" + DoubleToString(maxSpreadPips, 2)); return; }

   int command = side == "long" ? OP_BUY : side == "short" ? OP_SELL : -1;
   if(command < 0) { RejectAndDelete(id, "invalid-side"); return; }
   double openPrice = command == OP_BUY ? ask : bid;
   stopLoss = NormalizeDouble(stopLoss, digits);
   takeProfit = NormalizeDouble(takeProfit, digits);
   bool levelsValid = command == OP_BUY
      ? stopLoss < bid - stopLevel && takeProfit > ask + stopLevel
      : stopLoss > ask + stopLevel && takeProfit < bid - stopLevel;
   if(!levelsValid) { RejectAndDelete(id, "invalid-stop-or-target"); return; }
   // Live-only margin guard: refuse instead of relying on a broker requote.
   double marginRequired = AccountFreeMarginCheck(symbol, command, lots);
   if(marginRequired < 0 || marginRequired < AccountEquity() * 0.20) { RejectAndDelete(id, "insufficient-margin-or-reserve"); return; }

   int orderTicket = OrderSend(symbol, command, lots, openPrice, 3, stopLoss, takeProfit, "Enkei LIVE intent " + id, MagicNumber, 0, command == OP_BUY ? clrGreen : clrRed);
   if(orderTicket < 0) Audit("live-execution-failed", id + " policy=" + policyId + " request=" + requestId + " error=" + IntegerToString(GetLastError()));
   else { if(OrderSelect(orderTicket, SELECT_BY_TICKET)) SavePolicyMap(orderTicket, policyId, requestId, timeframe, spreadPips, openPrice, OrderOpenPrice()); Audit("live-execution-success", id + " policy=" + policyId + " request=" + requestId + " timeframe=" + timeframe + " order=" + IntegerToString(orderTicket)); }
   FileDelete(TicketFile, FILE_COMMON);
}

int OnInit() {
   EventSetTimer(1);
   Print("Enkei LIVE Execution Gate. REAL MONEY. AllowLiveSpeculativeExecution defaults to false. Account locked to one broker/account.");
   if(IsLiveAccount()) Print("Live account detected: ", AccountServer(), " #", IntegerToString((int)AccountNumber()));
   else Print("Blocked: this EA must run on a non-Demo (live) account.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() {
   ProcessCloseAction();
   ProcessTicket();
   ManageOpenPositions();
   PublishLiveAccount();
}
