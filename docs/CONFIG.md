# 配置说明文档

本文档详细说明 AI-MultiUser-Core 的所有配置项。

---

## 📋 目录

- [项目信息](#项目信息)
- [插件配置](#插件配置)
- [主人配置](#主人配置)
- [名称绑定配置](#名称绑定配置)
- [用户配置](#用户配置)
- [人设配置](#人设配置)

---

## 项目信息

- **项目路径**: core/AI-MultiUser-Core
- **项目名称**: AI-MultiUser-Core
- **版本**: 13.0.0
- **开源协议**: MIT License
- **依赖项目**: [XRK-AGT](https://github.com/sunflowermm/XRK-AGT)

---

## 插件配置

### 文件位置

`core/AI-MultiUser-Core/plugin-config.json`

### 配置说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `apis` | array | - | 多API配置数组 |
| `apis[0].url` | string | - | API地址 |
| `apis[0].key` | string | - | API密钥 |
| `apis[0].model` | string | - | 模型名称 |
| `temperature` | number | 0.7 | 温度参数，控制回复创造性 |
| `maxTokens` | number | 1000 | 最大 Token 数 |

### 配置示例

```json
{
  "apis": [
    {
      "url": "https://api.example.com/v1/chat/completions",
      "key": "sk-xxx",
      "model": "deepseek-v4-pro-chat"
    },
    {
      "url": "https://api.another.com/v1/chat/completions",
      "key": "sk-yyy",
      "model": "deepseek-v4-pro"
    }
  ],
  "temperature": 0.7,
  "maxTokens": 1000
}
```

### ⚠️ 注意事项

- **此配置文件仅由管理员修改**
- `apiKey` 为敏感信息，请勿泄露
- 修改后需要重启机器人生效
- 多API配置支持自动轮询，避免限流

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

## 名称绑定配置

### 文件位置

`core/AI-MultiUser-Core/name-bindings.json`

### 配置说明

此文件存储名称与QQ号的绑定关系，支持通过名称登录微信。

### 配置示例

```json
{
  "我的专属机器人": "123456789",
  "小可爱": "987654321"
}
```

### ⚠️ 注意事项

- **此文件由系统自动生成，无需手动编辑**
- 使用 `#微信机器人登录 名称` 命令时自动生成
- 使用 `#查询用户` 命令可查看绑定关系

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
| `lastActiveAt` | number | 最后活跃时间戳 |
| `enabled` | boolean | 是否启用 |
| `get_updates_buf` | string | 更新缓冲数据 |

### 用户API配置

用户可以在微信端配置自定义API，配置文件位置：

`core/AI-MultiUser-Core/accounts/user-XXX/api-config.json`

用户API配置示例：

```json
{
  "enabled": false,
  "apis": [
    {
      "url": "https://api.user.com/v1/chat/completions",
      "key": "sk-user-xxx",
      "model": "deepseek-v4-pro"
    }
  ]
}
```

### ⚠️ 注意事项

- **此文件由系统自动生成，无需手动编辑**
- `token` 为敏感信息，请勿泄露
- 修改可能导致登录失效
- 用户API配置在微信端使用 `#配置API` 命令生成

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

### 动作描述说明

现在系统会自动清理所有括号内容，避免AI使用不自然的动作描述。

### ⚠️ 注意事项

- 每个用户有独立的人设文件
- 新用户登录时自动复制默认人设
- 可随时编辑个人人设文件，立即生效
- 可在QQ群中使用 `#更改人设` 命令直接修改人设
