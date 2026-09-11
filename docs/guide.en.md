# Enkei English User Guide

[日本語](./guide.ja.md) | [Home](../README.en.md) | [中文](./guide.zh.md)

![Installation and runtime flow](./assets/flow-en.svg)

## Install and start

Fully extract the release to a short path such as `C:\Enkei`, then run `Start-Enkei.cmd`. First launch checks Node.js, Python, dependencies, and local ports. Open the Operations Centre after `http://127.0.0.1:3000` appears. To upgrade, drag the existing Enkei folder onto the new `Update-Enkei.cmd`, or replace application files with a fully extracted release.

## Install MT4 EAs

Open MT4 → File → Open Data Folder → `MQL4\Experts`. Copy and compile `EnkeiQuotePublisher.mq4` (read-only), `EnkeiDemoExecutionGate.mq4` (Demo only, disabled by default), and `EnkeiLiveExecutionGate.mq4` (real accounts only, globally locked by default). Press `F4`, compile each with `F7`, and require `0 errors, 0 warnings`. Refresh Navigator and reattach updated EAs. Do not attach the same execution EA to several charts.

## Configure AI

For online models, select the exact provider/model and keep the key only in local environment/settings. For LibreChat, start Docker Desktop and local LibreChat, then select Agents API; ordinary web chats remain separate. For Ollama, install it, pull the model, and select its exact local name. Enkei reports unavailable models or explicitly falls back to rules; it never fabricates AI output.

## Demo validation

Attach the quote EA and pass quote, history, and clock checks. Attach the Demo EA and manually permit Demo execution in its parameters. Start and pair the Demo service, release startup protection, and enter the confirmation phrase. The position ceiling defaults to 2 and is user-editable from 1 to 10; it is a ceiling, not an AI target. MT4 rechecks real equity/free margin before each order and preserves a 20% equity margin reserve. A submitted intent is not a fill; only a real MT4 position counts.

## Decisions, learning, and live use

A complete decision records regime, timeframe, session, news/research, local-rule agreement, spread/slippage, confidence, and invalidation. AI parameters show time and rationale and apply only after confirmation or explicit auto-apply. Learning uses real decisions, executions, and outcomes with versioning and rollback. Live use requires completed Demo validation, account confirmation, pairing, and manual live-EA authorization. Emergency stop never auto-resets; disconnect blocks new risk while controlled closing remains available.

## Troubleshooting and privacy

For `terminal-unreachable`, check AI Terminal and ports, then restart the local control centre. For stale history, keep MT4 online and download the timeframe. If an EA is stale, copy `.mq4`, compile, refresh Navigator, and reattach. Read the execution audit for rejected intents. Before opening an issue, remove accounts, servers, keys, personal paths, and order identifiers. Never upload `.env`, `ai-terminal/data`, databases, MT4 history CSVs, learning data, or runtime logs.
