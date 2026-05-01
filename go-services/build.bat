@echo off
REM 编译 Go 服务
REM Windows 使用

echo 正在编译 Go 服务...
go build -o multiuser-wechat.exe cmd/server/main.go

if %errorlevel% equ 0 (
  echo ✅ 编译成功！
  echo 可执行文件：multiuser-wechat.exe
) else (
  echo ❌ 编译失败！
  exit /b 1
)
