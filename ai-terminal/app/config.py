"""圆衡 Enkei 外部 AI 终端 - 配置"""
from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path

# 项目根目录
BASE_DIR = Path(__file__).resolve().parent.parent
# Tests and diagnostics may run while the real terminal owns terminal.log on
# Windows.  A process-scoped override keeps those runs isolated from live
# policies, audit records and file locks without changing production defaults.
DATA_DIR = Path(os.environ.get("ENKEI_DATA_DIR", str(BASE_DIR / "data")))
POLICY_DIR = DATA_DIR / "policies"
LOG_DIR = DATA_DIR / "logs"
REPORT_DIR = DATA_DIR / "reports"
MODEL_DIR = DATA_DIR / "models"
CONFIG_DIR = DATA_DIR / "config"
LEDGER_DIR = DATA_DIR / "ledger"      # 评估回环台账（decision/outcome 事件落盘）
AUDIT_DIR = DATA_DIR / "audit"        # 统一分析体请求的本地可审计记录（不含密钥）
PROVIDERS_FILE = CONFIG_DIR / "providers.json"

# 私有配置目录（M1 约定：固定位置，本机阶段不做 AES 加密，但密钥严禁进日志/包/Git）
# 圆衡侧仅保存：LibreChat 地址 / 圆衡专用 LibreChat API Key / M5、M15 Agent ID /
# 本地直连 Ollama 的可选备用地址。供应商原始 API Key 由 LibreChat 管理，不落此处。
_local_app_data = Path(os.environ.get("LOCALAPPDATA", str(BASE_DIR.parent)))
PRIVATE_CONFIG_DIR = Path(os.environ.get("ENKEI_PRIVATE_CONFIG_DIR", str(_local_app_data / "Enkei" / "private-config")))
# v1.7 及此前将配置放在项目目录的上一层；升级时仅作读取兼容。
LEGACY_PRIVATE_CONFIG_DIR = BASE_DIR.parent.parent / "私有配置"
# 提供方的密钥与本机路由覆盖也放在私有目录。公开的 providers.json 只可
# 保存不敏感默认值，打包或开源时不会携带本机 API Key。
PRIVATE_PROVIDERS_FILE = PRIVATE_CONFIG_DIR / "providers.json"

for _d in (POLICY_DIR, LOG_DIR, REPORT_DIR, MODEL_DIR, CONFIG_DIR, LEDGER_DIR, AUDIT_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# 服务监听（仅本机）
HOST = "127.0.0.1"
PORT = int(os.environ.get("ENKEI_AI_TERMINAL_PORT", "8710"))

# 政策默认有效期（秒），见架构决定 D5
DEFAULT_TTL_SECONDS = {
    "M1": 90,
    "M5": 360,   # 6 分钟
    "M15": 1080, # 18 分钟
}

# 调度路由默认值（可用 data/config/providers.json 覆盖）
DEFAULT_PROVIDERS = {
    "providers": {
        "ollama": {
            "enabled": True,
            "base_url": "http://127.0.0.1:11434",
            "models": {
                "fast": "deepseek-r1:7b",
                "deep": "deepseek-r1:7b",
            },
            "timeout_seconds": {"fast": 90, "deep": 300},
        },
        "deepseek": {
            # 云端仅供用户手动选用；默认路由仍是本机 Ollama。密钥由
            # LibreChat 的私有 .env 管理，不能写入项目 providers.json。
            "enabled": False,
            "base_url": "https://api.deepseek.com",
            "api_key": "",
            "models": {"fast": "deepseek-v4-flash", "deep": "deepseek-v4-flash"},
            "timeout_seconds": {"fast": 60, "deep": 180},
        },
        "openai": {
            "enabled": False,
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "models": {"fast": "gpt-4o-mini", "deep": "gpt-4o"},
            "timeout_seconds": {"fast": 60, "deep": 180},
        },
        "qwen": {
            "enabled": False,
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "api_key": "",
            "models": {"fast": "qwen-plus", "deep": "qwen-max"},
            "timeout_seconds": {"fast": 60, "deep": 180},
        },
        "zhipu": {
            # 智谱 OpenAI 兼容端点；实际 API Key 仅从私有配置合并。
            "enabled": False,
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "api_key": "",
            "models": {"fast": "glm-4.5-air", "deep": "glm-4.5-air"},
            "timeout_seconds": {"fast": 60, "deep": 90},
        },
    },
    "routing": {
        "M5": {"provider": "ollama", "model_role": "fast"},
        "M15": {"provider": "ollama", "model_role": "deep"},
    },
}

# 日志
LOG_FILE = LOG_DIR / "terminal.log"
SENSITIVE_KEYS = (
    "api_key", "apikey", "key", "token", "secret", "password", "passwd",
    "credential", "credentials", "paicode", "pair_code", "mt4_account",
    "mt4_password", "authorization", "cookie", "session",
)
SENSITIVE_PATTERNS = (  # 形如 sk-xxx / Bearer xxx 的密钥串
    (r"(sk-[A-Za-z0-9_-]{8,})", r"sk-***"),
    (r"(Bearer\s+[A-Za-z0-9._~+/=-]{8,})", r"Bearer ***"),
)


def _merge_provider_overrides(merged: dict, raw: dict) -> None:
    """将公开或私有覆盖合并进默认值，且保留未覆盖的嵌套字段。"""
    providers = raw.get("providers") if isinstance(raw, dict) else None
    if isinstance(providers, dict):
        for name, override in providers.items():
            if not isinstance(override, dict):
                continue
            current = deepcopy(merged["providers"].get(name, {}))
            for key, value in override.items():
                if key in {"models", "timeout_seconds"} and isinstance(value, dict):
                    nested = dict(current.get(key) or {})
                    nested.update(value)
                    current[key] = nested
                else:
                    current[key] = value
            merged["providers"][name] = current
    routing = raw.get("routing") if isinstance(raw, dict) else None
    if isinstance(routing, dict):
        merged["routing"].update(routing)


def load_provider_config() -> dict:
    """读取公开默认与本机私有覆盖；私有密钥绝不回写到项目目录。"""
    merged = deepcopy(DEFAULT_PROVIDERS)
    legacy = LEGACY_PRIVATE_CONFIG_DIR / "providers.json"
    # 旧项目目录仅用于兼容读取；Windows 用户目录具有最终覆盖权。
    private_paths = [path for path in (legacy, PRIVATE_PROVIDERS_FILE) if path != PROVIDERS_FILE]
    for path in (PROVIDERS_FILE, *private_paths):
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            _merge_provider_overrides(merged, raw)
        except Exception:
            # 任一覆盖损坏时仍保留其余有效来源和安全默认值。
            continue
    return merged
