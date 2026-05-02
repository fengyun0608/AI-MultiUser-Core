<p align="center">
  <h1 align="center">🤖 AI-MultiUser-Core</h1>
  <h3 align="center">多用户微信机器人系统</h3>
</p>

<p align="center">
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core">
    <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  </a>
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/MIT_License-007EC6?style=for-the-badge&logo=mit&logoColor=white" alt="MIT License">
  </a>
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core">
    <img src="https://img.shields.io/badge/Version-13.0.0-00ADD8?style=for-the-badge" alt="Version">
  </a>
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core/stargazers">
    <img src="https://img.shields.io/github/stars/fengyun0608/AI-MultiUser-Core?style=for-the-badge&logo=github" alt="GitHub stars">
  </a>
</p>

<p align="center">
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core/issues">
    <img src="https://img.shields.io/github/issues/fengyun0608/AI-MultiUser-Core?style=flat-square" alt="GitHub issues">
  </a>
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core/forks">
    <img src="https://img.shields.io/github/forks/fengyun0608/AI-MultiUser-Core?style=flat-square" alt="GitHub forks">
  </a>
  <a href="https://github.com/fengyun0608/AI-MultiUser-Core">
    <img src="https://img.shields.io/github/release/fengyun0608/AI-MultiUser-Core?style=flat-square" alt="GitHub release">
  </a>
</p>

<p align="center">
  支持多用户独立登录、独立人设配置、独立聊天记忆的微信机器人系统！
</p>

---

## 👥 作者信息

- **陈家锐** - 仙桃二中长虹路校区
  - **项目负责人**
  - 项目设计与测试
  - 功能规划与优化

- **风云科技-风云** - 项目主要开发

---

## 📋 项目信息

- **项目名称**: AI-MultiUser-Core
- **版本**: 13.0.0
- **开源协议**: MIT License
- **项目路径**: core/AI-MultiUser-Core
- **依赖项目**: [XRK-AGT](https://github.com/sunflowermm/XRK-AGT)

---

## 💡 项目简介

支持多用户独立登录、独立人设配置、独立聊天记忆的微信机器人系统。

让每个人都能拥有专属的 AI 聊天伙伴，体验真人般的对话乐趣！

---

## 📁 完整目录结构

```
AI-MultiUser-Core/
├── plugin/                          # 插件目录
│   └── 多用户微信机器人.js      # 主插件 - 处理QQ群命令、登录流程、消息监听、AI对话
│
├── accounts/                        # 用户数据根目录（完全隔离）
│   ├── user-123456789/          # 用户1的数据目录（QQ号123456789）
│   │   ├── config.json          # 用户配置文件（账号信息、token、状态）
│   │   ├── persona.md         # 用户专属人设文件（独立角色设定）
│   │   └── chat-memory.json    # 用户聊天记忆（独立对话记录）
│   └── .gitkeep               # 占位文件（保持目录）
│
├── docs/                           # 文档目录
│   ├── CONFIG.md                # [配置说明文档](docs/CONFIG.md)
│   ├── USAGE.md               # [使用说明文档](docs/USAGE.md)
│   └── API.md                 # [API说明文档](docs/API.md)
│
├── default-persona.md               # 默认人设模板（新用户复制此文件）
├── plugin-config.json               # 插件配置文件（API配置，管理员修改）
├── name-bindings.json               # 名称与QQ号绑定配置
├── masters.json                   # 主人配置文件（QQ号列表）
├── README.md                    # 本说明文件
├── CHANGELOG.md                # [更新日志](CHANGELOG.md)
└── LICENSE                    # [许可证文件](LICENSE)
```

---

## 📖 详细文档

| 文档 | 说明 | 链接 |
|------|------|------|
| **配置说明** | API配置、人设配置、主人配置等 | [CONFIG.md](docs/CONFIG.md) |
| **使用说明** | 详细使用指南、命令说明、使用流程 | [USAGE.md](docs/USAGE.md) |
| **API说明** | 微信API接口、LLMAPI接口说明 | [API.md](docs/API.md) |
| **更新日志** | 版本更新记录 | [CHANGELOG.md](CHANGELOG.md) |
| **开源许可证** | MIT许可证说明 | [LICENSE](LICENSE) |

---

## 🔒 隔离性保证

✅ **每个人设完全隔离** - 每个用户有自己的 `persona.md`
✅ **每个配置完全隔离** - 每个用户有自己的 `config.json`
✅ **每个记忆完全隔离** - 每个用户有自己的 `chat-memory.json`
✅ **数据互不干扰** - 用户之间无法访问对方的数据
✅ **安全日志输出** - 日志中不暴露token、user_id等敏感信息

---

## ✨ 特色功能

### 🎯 真人聊天体验

- **多段发送** - AI回复自动分成短段落（最多10段）
- **模拟打字** - 0.5-1秒的随机延迟
- **真人身份** - 牢记自己是一个人，不是AI或机器造物
- **例句参考** - 发言例句仅供参考，无需按示例格式输出
- **说话限制** - 日常1句话/30字，专业3句话/50字
- **句末句号** - 自动去掉句末句号
- **人设优先** - 严格按照用户人设说话，人设是最高优先级
- **珍惜机会** - AI会精简回复，只说最重要的内容
- **回复丰富** - 在限制下充分表达，回复内容充实
- **自然节奏** - 更像真人打字的感觉
- **智能分段** - 按句子和段落自动拆分

### 📝 便捷管理功能

- **人设实时修改** - 在QQ群中使用 `#更改人设` 命令修改人设
- **完整格式支持** - 支持多行、任意长度、任意格式的人设内容
- **即时生效** - 修改后立即生效，无需重启机器人

### 🧠 超级强化的AI提示词

- **22条重要提醒** - 从14条增加到22条
- **5次以上强调人设** - 反复强调人设是最高优先级，比什么都重要
- **按人设反应AI质疑** - 如果对方说你是AI，完全按人设的性格来反应
- **人设性格优先** - 人设是懦弱就懦弱辩解，人设是傲娇就傲娇反驳
- **按人设情绪走** - 完全按人设的情绪来反应

### 🤖 智能记忆系统

- **独立记忆目录** - 存放在用户目录的 `memories/` 文件夹，与 `chat-memory.json` 同级
- **每条记忆独立文件** - 每个对话保存为单独的JSON文件，像人一样长期记忆
- **AI查看记忆对话** - 每次回复前自动加载最近记忆，帮助产生连贯情绪
- **简单标题生成** - 自动生成简洁的记忆标题
- **北京时间记录** - 每个记忆都带准确的北京时间戳
- **记忆回顾提示** - AI根据记忆更好地理解上下文和产生情绪
- **清除记忆功能** - `#清除记忆` 同时删除聊天记录和所有记忆文件

### 🎉 新增特色功能

- **AI主动发消息** - 支持开启AI主动发消息，两小时内随机时间主动和你聊天
- **名称登录** - 支持通过名称登录微信，自动绑定当前QQ
- **用户查询** - 支持查询名称与QQ号的绑定关系
- **灵活命令** - 所有命令支持大小写不敏感和灵活空格
- **对话式配置** - API配置改为对话式，更简单易用

---

## 📝 快速命令参考

### 🎯 普通用户命令（任何人可用）

| 命令 | 说明 |
|------|------|
| `#登录微信AI` | 开始微信登录流程，获取二维码图片 |
| `#更改人设 人设内容` | 修改自己的人设（需已登录并运行，支持多行） |
| `#当前人设` | 查看当前人设 |
| `#清除记忆` | 清除自己的聊天记忆（需已登录） |
| `#我的信息` | 查看个人信息和统计数据 |

### 📱 微信端命令

| 命令 | 说明 |
|------|------|
| `#清除记忆` | 清除聊天记忆 |
| `#更改人设 人设内容` | 修改人设 |
| `#当前人设` | 查看当前人设 |
| `#我的信息` | 查看个人信息 |
| `#配置API` | 配置自定义API（对话式） |
| `#我的API` | 查看API配置 |
| `#切换官方` | 切换到官方API |
| `#切换自定义` | 切换到自定义API |
| `#开启AI主动发送消息` | 开启AI主动发消息 |
| `#关闭AI主动发送消息` | 关闭AI主动发消息 |

### 👑 主人命令（仅限 masters.json 中配置的QQ号）

| 命令 | 说明 |
|------|------|
| `#微信机器人在线列表` | 查看所有已登录用户和运行状态 |
| `#在线用户` | 查看在线和离线用户 |
| `#停止机器人` | 停止机器人 |
| `#启动机器人` | 启动机器人 |
| `#删除机器人` | 删除账号数据 |
| `#关于` | 查看项目信息 |
| `#推广` | 查看推广文案 |
| `#站点状态` | 查看API站点状态 |
| `#帮助多用户` | 查看帮助信息 |

### 🎉 新增管理员命令

| 命令 | 说明 |
|------|------|
| `#微信机器人登录 名称` | 通过名称登录微信，自动绑定当前QQ |
| `#查询用户 <名称/QQ号>` | 查询用户绑定关系 |

---

详细命令说明查看 [使用说明文档](docs/USAGE.md)

---

## 🚀 快速开始

### 普通用户使用

1. 在QQ群中发送 `#登录微信AI`（或 `#微信机器人登录 <名称>`）
2. 收到二维码图片，用微信扫码登录
3. 登录成功后自动启动机器人
4. 在QQ群中使用 `#更改人设 新的人设内容` 修改人设（可选）
5. 在微信中和机器人对话（体验真人聊天节奏）

### 主人管理

1. 编辑 `masters.json` 配置主人QQ号
2. 在QQ群中使用管理命令查看和控制所有机器人

详细使用说明查看 [使用说明文档](docs/USAGE.md)

---

## 📌 注意事项

- ✅ 每个用户的数据完全隔离
- ✅ 聊天记录自动保留7天，过期清理
- ✅ 二维码有效期5分钟
- ✅ 支持二维码图片直接发送到QQ群（使用Puppeteer截图）
- ✅ 最多发送10段，1-1.7秒随机延迟
- ✅ `#更改人设` 支持任意长度的多行内容
- ✅ 人设是最高优先级，比什么都重要
- ✅ 用户3秒内多条消息会合并处理
- ✅ 多API自动轮询，避免429限流
- ✅ 所有命令支持大小写不敏感和灵活空格
- ✅ 支持名称绑定和通过名称登录微信

## 🛠️ 系统架构说明

### 插件协作方式

- **多用户微信机器人.js**：负责QQ群命令、微信登录、消息监听、AI对话、人设管理、消息回复
- 单插件架构，无需其他插件依赖

### 消息流程

1. 用户在微信发送消息
2. 多用户微信机器人.js监听并接收消息
3. 调用AI生成回复
4. 智能分段成短段落
5. 每段0.5-1秒延迟发送
6. 调用微信API发送回复

---

## 📦 依赖项目

本项目依赖 [XRK-AGT](https://github.com/sunflowermm/XRK-AGT) 框架。

## 📞 交流方式

欢迎加入 QQ 群交流讨论！

- **QQ 群号**: 1040559624

在群里你可以：
- 提出问题和建议
- 分享你的使用体验
- 认识更多志同道合的朋友

---

## 📊 项目统计

本项目持续更新，感谢大家的支持！

### GitHub 统计

[![GitHub stars](https://img.shields.io/github/stars/fengyun0608/AI-MultiUser-Core?style=social)](https://github.com/fengyun0608/AI-MultiUser-Core/stargazers)
[![GitHub downloads](https://img.shields.io/github/downloads/fengyun0608/AI-MultiUser-Core/total?style=flat-square)](https://github.com/fengyun0608/AI-MultiUser-Core/releases)

### 功能特性

- ✅ **多用户支持** - 无限用户独立登录
- 🧠 **智能记忆** - 长期记忆保存
- 🎭 **自定义人设** - 任意角色设定
- 💬 **真人体验** - 多段发送+打字延迟
- 🔒 **数据隔离** - 用户数据完全独立
- 🎉 **主动发消息** - AI主动和你聊天
- 🔍 **名称登录** - 支持通过名称登录微信
- 📱 **灵活命令** - 大小写不敏感和灵活空格支持

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件
