//+------------------------------------------------------------------+
//| EnkeiDemoExecutionGate.mq4                                      |
//| DEMO-ONLY, manually paired local ticket executor.               |
//| Never attach this EA to a live account.                         |
//+------------------------------------------------------------------+
#property strict
#property version   "1.30"

input int    MagicNumber = 826090;
input double HardMaxLots = 1.00;
input int    MaxOpenDemoPositions = 10;
input bool   AllowDemoExecution = false;
input bool   EnableDynamicProfitProtection = false;
input double BreakevenTriggerPips = 8.0;
input double TrailStartPips = 12.0;
input double TrailDistancePips = 6.0;

string TicketFile = "enkei\\demo-execution\\pending-ticket.csv";
string CloseFile = "enkei\\demo-execution\\pending-close.csv";
string KillFile = "enkei\\demo-execution\\KILL.switch";
string AuditFile = "enkei\\demo-execution\\demo-execution-audit.csv";
string PositionSnapshotFile = "enkei\\demo-execution\\demo-position-snapshot.json";
string PolicyMapFile = "enkei\\demo-execution\\demo-policy-map.csv";

void SavePolicyMap(int ticket, string policyId, string requestId, string timeframe, double spreadPips, double requestedPrice, double actualPrice) {
   int handle = FileOpen(PolicyMapFile, FILE_CSV|FILE_READ|FILE_WRITE|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   FileSeek(handle, 0, SEEK_END);
   FileWrite(handle, ticket, policyId, requestId, timeframe, spreadPips, MathAbs(actualPrice-requestedPrice)/PipSize(OrderSymbol()));
   FileClose(handle);
}

void ReadPolicyMap(int ticket, string &policyId, string &requestId, string &timeframe, double &spreadPips, double &slippagePips) {
   policyId=""; requestId=""; timeframe=""; spreadPips=0; slippagePips=0;
   int handle = FileOpen(PolicyMapFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   while(!FileIsEnding(handle)) {
      int mappedTicket=(int)FileReadNumber(handle); string mappedPolicy=FileReadString(handle); string mappedRequest=FileReadString(handle); string mappedTimeframe=FileReadString(handle); double mappedSpread=FileReadNumber(handle); double mappedSlippage=FileReadNumber(handle);
      if(mappedTicket==ticket) { policyId=mappedPolicy; requestId=mappedRequest; timeframe=mappedTimeframe; spreadPips=mappedSpread; slippagePips=mappedSlippage; }
   }
   FileClose(handle);
}

bool IsDemoAccount() {
   string server = AccountServer();
   StringToLower(server);
   return StringFind(server, "demo") >= 0;
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

int OpenDemoPositions() {
   int total = 0;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(OrderSelect(index, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber) total++;
   }
   return total;
}

double OpenDemoLots() {
   double total = 0.0;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(OrderSelect(index, SELECT_BY_POS, MODE_TRADES) && OrderMagicNumber() == MagicNumber) total += OrderLots();
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
      if(profitPips>=BreakevenTriggerPips) desired=type==OP_BUY ? MathMax(desired, OrderOpenPrice()) : (desired<=0 ? OrderOpenPrice() : MathMin(desired, OrderOpenPrice()));
      if(profitPips>=TrailStartPips) desired=type==OP_BUY ? MathMax(desired, bid-TrailDistancePips*pip) : (desired<=0 ? ask+TrailDistancePips*pip : MathMin(desired, ask+TrailDistancePips*pip));
      desired=NormalizeDouble(desired,digits);
      bool improves=type==OP_BUY ? desired>OrderStopLoss()+pip*.1 : (OrderStopLoss()<=0 || desired<OrderStopLoss()-pip*.1);
      if(improves && !OrderModify(OrderTicket(),OrderOpenPrice(),desired,OrderTakeProfit(),0,clrGreen)) Audit("dynamic-protection-failed", IntegerToString(OrderTicket())+" error="+IntegerToString(GetLastError()));
      else if(improves) Audit("dynamic-protection-updated", IntegerToString(OrderTicket())+" stop="+DoubleToString(desired,digits));
   }
}

// Publishes positions created by this Demo EA plus read-only account capacity.
// No password or non-Demo position is exposed. The web panel uses this for
// a one-second display refresh; MT4 remains the execution authority. The most
// recent closed Demo records are retained so a browser restart does not erase
// the experiment ledger.
void PublishDemoPositions() {
   int handle = FileOpen(PositionSnapshotFile, FILE_TXT|FILE_WRITE|FILE_COMMON|FILE_ANSI);
   if(handle == INVALID_HANDLE) return;
   // The snapshot is published after every processing pass.  This makes a
   // just-filled order visible to the local dashboard in the same one-second
   // timer cycle instead of leaving it on the previous, empty snapshot.
   string body = "{\"mode\":\"demo-only\",\"updated_at\":\"" + TimeToString(TimeLocal(), TIME_DATE|TIME_SECONDS) + "\",\"updated_at_epoch\":" + IntegerToString((int)TimeLocal()) + ",\"account\":{\"balance\":%.2f,\"equity\":%.2f,\"free_margin\":%.2f,\"margin\":%.2f,\"leverage\":" + IntegerToString(AccountLeverage()) + ",\"currency\":\"" + AccountCurrency() + "\"},\"positions\":[";
   body = StringFormat(body, AccountBalance(), AccountEquity(), AccountFreeMargin(), AccountMargin());
   bool first = true;
   for(int index = OrdersTotal() - 1; index >= 0; index--) {
      if(!OrderSelect(index, SELECT_BY_POS, MODE_TRADES) || OrderMagicNumber() != MagicNumber) continue;
      string symbol = OrderSymbol();
      string policyId, requestId, timeframe; double entrySpread, slippage;
      ReadPolicyMap(OrderTicket(), policyId, requestId, timeframe, entrySpread, slippage);
      double currentPrice = OrderType() == OP_BUY ? MarketInfo(symbol, MODE_BID) : MarketInfo(symbol, MODE_ASK);
      if(!first) body += ",";
      first = false;
      body += StringFormat("{\"ticket\":%d,\"policy_id\":\"%s\",\"request_id\":\"%s\",\"timeframe\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"lots\":%.2f,\"open_price\":%.5f,\"current_price\":%.5f,\"stop_loss\":%.5f,\"take_profit\":%.5f,\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"spread_pips\":%.3f,\"slippage_pips\":%.3f}", OrderTicket(), policyId, requestId, timeframe, symbol, SideName(OrderType()), OrderLots(), OrderOpenPrice(), currentPrice, OrderStopLoss(), OrderTakeProfit(), OrderProfit(), OrderSwap(), OrderCommission(), entrySpread, slippage);
   }
   body += "],\"closed_positions\":[";
   first = true;
   int written = 0;
   for(int historyIndex = OrdersHistoryTotal() - 1; historyIndex >= 0 && written < 50; historyIndex--) {
      if(!OrderSelect(historyIndex, SELECT_BY_POS, MODE_HISTORY) || OrderMagicNumber() != MagicNumber || OrderCloseTime() <= 0) continue;
      string closedPolicy, closedRequest, closedTimeframe; double closedSpread, closedSlippage;
      ReadPolicyMap(OrderTicket(), closedPolicy, closedRequest, closedTimeframe, closedSpread, closedSlippage);
      if(StringLen(closedPolicy) < 8) continue;
      if(!first) body += ",";
      first = false;
      body += StringFormat("{\"ticket\":%d,\"policy_id\":\"%s\",\"request_id\":\"%s\",\"timeframe\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"lots\":%.2f,\"open_price\":%.5f,\"close_price\":%.5f,\"opened_at\":\"%s\",\"closed_at\":\"%s\",\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"spread_pips\":%.3f,\"slippage_pips\":%.3f}", OrderTicket(), closedPolicy, closedRequest, closedTimeframe, OrderSymbol(), SideName(OrderType()), OrderLots(), OrderOpenPrice(), OrderClosePrice(), TimeToString(OrderOpenTime(), TIME_DATE|TIME_SECONDS), TimeToString(OrderCloseTime(), TIME_DATE|TIME_SECONDS), OrderProfit(), OrderSwap(), OrderCommission(), closedSpread, closedSlippage);
      written++;
   }
   body += "]}";
   FileWriteString(handle, body);
   FileClose(handle);
}

void RejectAndDelete(string id, string reason) {
   Audit("ticket-rejected", id + " " + reason);
   FileDelete(TicketFile, FILE_COMMON);
}

void CloseRejectAndDelete(string id, string reason) {
   Audit("close-rejected", id + " " + reason);
   FileDelete(CloseFile, FILE_COMMON);
}

// ticket=0 means close every currently open position made by this Demo EA.
// It can never close a manual order or an order created by another EA because
// every selection is filtered by MagicNumber and the terminal must be Demo.
void ProcessCloseAction() {
   // 急停阻止新开仓，但不能阻止降低风险的一键平仓。
   if(!FileIsExist(CloseFile, FILE_COMMON)) return;
   if(!AllowDemoExecution) { CloseRejectAndDelete("disabled", "execution-disabled"); return; }
   if(!IsDemoAccount()) { CloseRejectAndDelete("unknown", "non-demo-account"); return; }
   if(!IsTradeAllowed() || !IsConnected()) { CloseRejectAndDelete("terminal", "terminal-not-ready"); return; }

   int handle = FileOpen(CloseFile, FILE_CSV|FILE_READ|FILE_COMMON|FILE_ANSI, ',');
   if(handle == INVALID_HANDLE) return;
   string id = FileReadString(handle);
   int createdAt = (int)FileReadNumber(handle);
   int expiresAt = (int)FileReadNumber(handle);
   int requestedTicket = (int)FileReadNumber(handle);
   FileClose(handle);
   if(StringLen(id) < 8 || expiresAt <= createdAt || expiresAt - createdAt > 95) { CloseRejectAndDelete(id, "invalid-close-time"); return; }

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
   Audit(failed > 0 ? "close-partial" : "close-success", id + " closed=" + IntegerToString(closed) + " failed=" + IntegerToString(failed));
   FileDelete(CloseFile, FILE_COMMON);
}

void ProcessTicket() {
   if(FileIsExist(KillFile, FILE_COMMON)) return;
   if(!FileIsExist(TicketFile, FILE_COMMON)) return;
   if(!AllowDemoExecution) { RejectAndDelete("disabled", "execution-disabled"); return; }
   if(!IsDemoAccount()) { if(FileIsExist(TicketFile, FILE_COMMON)) RejectAndDelete("unknown", "non-demo-account"); return; }
   if(!IsTradeAllowed() || !IsConnected()) { RejectAndDelete("terminal", "terminal-not-ready"); return; }

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
   string policyId = FileReadString(handle);
   string requestId = FileReadString(handle);
   string timeframe = FileReadString(handle);
   FileClose(handle);

   // Ticket expiry is enforced by the local Node gate. MT4 terminal clocks can
   // differ from Windows time, so only reject malformed timestamps here.
   if(StringLen(id) < 8 || StringLen(policyId) < 8 || StringLen(requestId) < 8 || (timeframe != "M5" && timeframe != "M15") || expiresAt <= createdAt || expiresAt - createdAt > 95) { RejectAndDelete(id, "invalid-ticket-identity-or-time"); return; }
   if(lots < 0.01 || lots > HardMaxLots || lots > 1.00) { RejectAndDelete(id, "lot-limit"); return; }
   if(OpenDemoPositions() >= MaxOpenDemoPositions) { RejectAndDelete(id, "open-position-limit"); return; }
   if(OpenDemoLots() + lots > HardMaxLots + 0.000001) { RejectAndDelete(id, "total-lot-limit"); return; }
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
   double marginAfter = AccountFreeMarginCheck(symbol, command, lots);
   if(marginAfter < 0 || marginAfter < AccountEquity() * 0.20) { RejectAndDelete(id, "insufficient-margin-or-reserve"); return; }

   int orderTicket = OrderSend(symbol, command, lots, openPrice, 3, stopLoss, takeProfit, "Enkei DEMO confirmation", MagicNumber, 0, command == OP_BUY ? clrGreen : clrRed);
   if(orderTicket < 0) Audit("execution-failed", id + " error=" + IntegerToString(GetLastError()));
   else {
      if(OrderSelect(orderTicket, SELECT_BY_TICKET)) SavePolicyMap(orderTicket, policyId, requestId, timeframe, spreadPips, openPrice, OrderOpenPrice());
      Audit("execution-success", id + " policy=" + policyId + " request=" + requestId + " order=" + IntegerToString(orderTicket));
   }
   FileDelete(TicketFile, FILE_COMMON);
}

int OnInit() {
   EventSetTimer(1);
   Print("Enkei Demo Execution Gate ready. DEMO ONLY; AllowDemoExecution defaults to false.");
   if(!IsDemoAccount()) Print("Blocked: this EA must only run on an account server containing Demo.");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() {
   // Execute a locally confirmed Demo action first, then immediately publish
   // the resulting MT4 state.  MT4 remains the sole authority for positions.
   ProcessCloseAction();
   ProcessTicket();
   ManageOpenPositions();
   PublishDemoPositions();
}
