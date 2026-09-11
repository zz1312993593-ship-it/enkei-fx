"""批B：直连路由 API 单测（GET 合并回显 / PUT 白名单校验 / 私有文件持久化）。"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import config, main


class RoutingApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.private = Path(self.tmp.name) / "providers.json"
        patcher = patch.object(config, "PRIVATE_PROVIDERS_FILE", self.private)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)

    def test_get_returns_merged_defaults(self):
        response = self.client.get("/v1/routing")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("M5", data["routing"])
        self.assertIn("M15", data["routing"])
        self.assertIn("zhipu", data["providers"])

    def test_put_valid_routing_persists_to_private_file(self):
        response = self.client.put("/v1/routing", json={
            "routing": {"M5": {"provider": "deepseek", "model_role": "fast"}},
            "models": {"deepseek": {"fast": "deepseek-chat"}},
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["routing"]["M5"]["provider"], "deepseek")
        raw = json.loads(self.private.read_text(encoding="utf-8"))
        self.assertEqual(raw["routing"]["M5"]["provider"], "deepseek")
        self.assertEqual(raw["providers"]["deepseek"]["models"]["fast"], "deepseek-chat")
        # 回读合并生效
        again = self.client.get("/v1/routing").json()
        self.assertEqual(again["routing"]["M5"]["provider"], "deepseek")
        self.assertEqual(again["models"]["deepseek"]["fast"], "deepseek-chat")

    def test_put_rejects_unknown_provider(self):
        response = self.client.put("/v1/routing", json={
            "routing": {"M5": {"provider": "someone-else", "model_role": "fast"}},
        })
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["error"], "routing_invalid")

    def test_put_rejects_bad_role(self):
        response = self.client.put("/v1/routing", json={
            "routing": {"M15": {"provider": "zhipu", "model_role": "mega"}},
        })
        self.assertEqual(response.status_code, 422)

    def test_put_requires_routing(self):
        response = self.client.put("/v1/routing", json={"models": {"zhipu": {"fast": "x"}}})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
