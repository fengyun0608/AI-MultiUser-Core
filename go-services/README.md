# Go 服务

这是 AI-MultiUser-Core 项目的高性能 Go 微服务！

---

## 📋 功能

- ✅ LLM API 调用（多 API 轮询、故障切换）
- ✅ 微信 API 调用（二维码、消息、更新）
- ✅ 低内存占用、高并发性能

---

## 🚀 使用方法

### 方法 1：预编译（推荐）

**Linux/Mac**:
```bash
cd core/AI-MultiUser-Core/go-services
./build.sh
```

**Windows**:
```cmd
cd core\AI-MultiUser-Core\go-services
build.bat
```

插件会自动检测并使用预编译的可执行文件！

---

### 方法 2：go run（需要安装 Go）

1. 安装 Go：访问 https://go.dev/dl/
2. 插件会自动使用 go run 启动

---

## 📦 目录结构

```
go-services/
├── cmd/server/main.go  # 服务入口
├── internal/api/llm.go  # API 处理
├── internal/config/config.go  # 配置加载
├── build.sh  # Linux/Mac 编译脚本
├── build.bat  # Windows 编译脚本
└── README.md  # 本文档
```

---

## 📄 许可证

MIT License
