# 配置说明文档

本文档详细说明 AI-MultiUser-Core 的所有配置项。

---

## 📋 目录

- [项目信息](#项目信息)
- [插件配置](#插件配置)
- [主人配置](#主人配置)
- [用户配置](#用户配置)
- [人设配置](#人设配置)

---

## 项目信息

- **项目路径**: `d:\葵机器人\XRK-AGT\core\AI-MultiUser-Core
- **项目名称**: AI-MultiUser-Core
- **版本**: 2.0.0
- **开源协议**: MIT License

---

## 插件配置

### 文件位置

`core/AI-MultiUser-Core/plugin-config.json`

### 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `apiUrl` | string | `https://api.minewuer.com/v1/chat/completions` | LLM API 地址 |
| `apiKey` | string | - | API 密钥（必填） |
| `model` | string | `deepseek-v4-pro-chat` | 模型名称 |
| `temperature` | number | 0.7 | 温度参数，控制回复创造性 |
| `maxTokens` | number | 1000 | 最大 Token 数 |

### 配置示例

```json
{
  "apiUrl": "https://api.minewuer.com/v1/chat/completions",
  "apiKey": "sk-f3w2D0MEv43Fc2nZ2I7ljU7xrVa4tgctxAckE3LPWSbG6Le",
  "model": "deepseek-v4-pro-chat",
  "temperature": 0.7,
  "maxTokens": 1000
}
```

### ⚠️ 注意事项

- **此配置文件仅由管理员修改**
- `apiKey` 为敏感信息，请勿泄露
- 修改后需要重启机器人生效

---

## 主人配置

### 文件位置

`core/AI-MultiUser-Core/masters.json`

### 配置说明

此文件包含主人的 QQ 号列表，主人可使用管理命令。

### 配置示例

```json
[
  "123456789",
  "987654321"
]
```

### ⚠️ 注意事项

- **此配置文件仅由管理员修改**
- QQ 号必须为字符串格式
- 修改后立即生效，无需重启

---

## 用户配置

### 文件位置

`core/AI-MultiUser-Core/accounts/user-XXX/config.json`

### 配置说明

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `userId` | string | QQ 用户 ID |
| `accountId` | string | 微信账号 ID |
| `token` | string | 微信登录 Token（敏感） |
| `baseUrl` | string | 微信 API 地址 |
| `userIdFromWeixin` | string | 微信用户 ID |
| `createdAt` | number | 创建时间戳 |
| `enabled` | boolean | 是否启用 |
| `get_updates_buf` | string | 更新缓冲数据 |

### 配置示例

```json
{
  "userId": "123456789",
  "accountId": "wxid_xxx@im.bot",
  "token": "xxx",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "userIdFromWeixin": "xxx",
  "createdAt": 1234567890,
  "enabled": true,
  "get_updates_buf": ""
}
```

### ⚠️ 注意事项

- **此文件由系统自动生成，无需手动编辑**
- `token` 为敏感信息，请勿泄露
- 修改可能导致登录失效

---

## 人设配置

### 默认人设文件位置

`core/AI-MultiUser-Core/default-persona.md`

### 用户人设文件位置

`core/AI-MultiUser-Core/accounts/user-XXX/persona.md`

### 人设说明

人设文件是普通的 Markdown 格式，用于描述角色的性格、说话风格、背景等。

### 人设示例

```markdown
你是一个活泼开朗的二次元少女，喜欢分享日常，说话自然不生硬。

性格特点：
- 活泼开朗，喜欢用表情符号
- 温柔体贴，关心他人感受
- 喜欢分享美食和旅行

说话风格：
- 自然亲切，像朋友聊天一样
- 适当使用表情符号（😊✨❤️）
- 回复长度适中，不要太长
```

### ⚠️ 注意事项

- 每个用户有独立的人设文件
- 新用户登录时自动复制默认人设
- 可随时编辑个人人设文件，立即生效
