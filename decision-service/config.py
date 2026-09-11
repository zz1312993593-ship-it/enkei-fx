# -*- coding: utf-8 -*-
"""圆衡 Enkei 决策服务 - 配置

本地私有配置经 gateway.json 提供（LibreChat 统一分析体凭据）。
所有服务仅监听 127.0.0.1，无任何对外暴露。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class BridgeConfig:
    base_url: str = "http://127.0.0.1:8788"
    timeout_s: float = 5.0


@dataclass(frozen=True)
class GatewayConfig:
    librechat_base_url: str
    librechat_api_key: str
    unified_agent_id: str


@dataclass(frozen=True)
class ServiceConfig:
    port: int = 8792  # 决策服务端口（隔离于 8710 终端 / 8791 网关 / 8788 桥）
    decision_store_dir: Path = None  # 决策结果落盘目录（审计）
    max_concurrent: int = 1  # 同一时刻仅允许 1 个深度分析在跑（算力约束）
    default_limit: int = 120
    max_decision_ttl_s: int = 3600  # 决策有效期上限（M15 为一个周期，这里给宽松上限）


def _gateway_candidates() -> list[Path]:
    """按优先级收集 gateway.json 候选位置：
    1. 环境变量 ENKEI_PRIVATE_CONFIG_DIR（发布包/容器显式指定私有配置目录）
    2. 本机开发基线固定路径（保持既有运行不回退）
    3. 分发包内相对结构：<包根>/../私有配置（安装器在解压目录旁创建）
    私有 API Key 只存在于这些目录内，绝不进入发布包或 Git。
    """
    candidates: list[Path] = []
    env_dir = os.environ.get("ENKEI_PRIVATE_CONFIG_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "gateway.json")
    # 相对包根：decision-service → 项目根 → 上一级（含 私有配置/）
    service_root = Path(__file__).resolve().parent
    for ancestor in (service_root, service_root.parent, service_root.parent.parent):
        candidates.append(ancestor / "私有配置" / "gateway.json")
    return candidates


def load_gateway() -> GatewayConfig:
    for cand in _gateway_candidates():
        if cand.exists():
            raw = json.loads(cand.read_text(encoding="utf-8"))
            return GatewayConfig(
                librechat_base_url=str(raw["librechat_base_url"]).rstrip("/"),
                librechat_api_key=str(raw["librechat_api_key"]),
                unified_agent_id=str(raw["unified_agent_id"]),
            )
    return GatewayConfig(librechat_base_url="", librechat_api_key="", unified_agent_id="")


def load_service(store_dir: Path | None = None) -> ServiceConfig:
    cfg = ServiceConfig()
    if store_dir is not None:
        return ServiceConfig(decision_store_dir=Path(store_dir))
    if cfg.decision_store_dir is None:
        cfg = ServiceConfig(
            decision_store_dir=Path(__file__).resolve().parent / "data" / "decisions"
        )
    return cfg
