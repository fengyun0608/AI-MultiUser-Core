#!/bin/bash
# 编译 Go 服务
# Linux/Mac 使用

echo "正在编译 Go 服务..."
go build -o multiuser-wechat cmd/server/main.go

if [ $? -eq 0 ]; then
  echo "✅ 编译成功！"
  echo "可执行文件：multiuser-wechat"
else
  echo "❌ 编译失败！"
  exit 1
fi
