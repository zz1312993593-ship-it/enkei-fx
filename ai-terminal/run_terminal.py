"""圆衡 Enkei 外部 AI 终端 - 启动入口"""
import uvicorn

from app import config

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="info")
