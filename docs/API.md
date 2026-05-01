# API说明文档

本文档详细说明 AI-MultiUser-Core 使用的 API 接口。

---

## 📋 目录

- [项目信息](#项目信息)
- [微信API接口](#微信api接口)
- [LLM API接口](#llm-api接口)
- [消息枚举值](#消息枚举值)

---

## 项目信息

- **项目路径**: core/AI-MultiUser-Core
- **项目名称**: AI-MultiUser-Core
- **版本**: 15.0.0
- **架构**: Node.js + Go 混合架构
- **开源协议**: MIT License
- **依赖项目**: [XRK-AGT](https://github.com/sunflowermm/XRK-AGT)

---

## Go 微服务 API

本项目使用 Node.js + Go 混合架构，Go 微服务负责高性能模块（LLM API、微信 API）。

**服务地址**: `http://localhost:8080`

---

### LLM API

#### 聊天接口

**接口**: `POST /api/v1/llm/chat`

**请求体**:
```json
{
  "messages": [
    {
      "role": "system",
      "content": "你是一个助手..."
    },
    {
      "role": "user",
      "content": "你好"
    }
  ]
}
```

**响应**:
```json
{
  "success": true,
  "content": "你好！"
}
```

**功能**:
- 多 API 自动轮询
- 自动故障切换
- 负载均衡

---

### 微信 API

#### 获取二维码

**接口**: `POST /api/v1/wx/qrcode`

**请求体**:
```json
{
  "baseUrl": "https://xxx",
  "botType": "xxx"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "qrcode": "xxx",
    "qrcode_img_content": "https://xxx"
  }
}
```

---

#### 查询二维码状态

**接口**: `POST /api/v1/wx/qrcode/status`

**请求体**:
```json
{
  "baseUrl": "https://xxx",
  "qrcode": "xxx"
}
```

**响应**:
```json
{
  "success": true,
  "status": "wait",
  "data": {
    "status": "wait",
    "redirect_host": "xxx",
    "ilink_bot_id": "xxx",
    "bot_token": "xxx",
    "base_url": "https://xxx",
    "ilink_user_id": "xxx"
  }
}
```

---

#### 获取微信更新

**接口**: `POST /api/v1/wx/getupdates`

**请求体**:
```json
{
  "baseUrl": "https://xxx",
  "token": "xxx",
  "getUpdatesBuf": "",
  "timeoutMs": 35000
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "get_updates_buf": "xxx",
    "msgs": [
      {
        "seq": 1,
        "from_user_id": "xxx",
        "to_user_id": "xxx",
        "message_type": 1,
        "message_state": 2,
        "item_list": [...],
        "context_token": "xxx"
      }
    ]
  }
}
```

---

#### 发送微信消息

**接口**: `POST /api/v1/wx/send`

**请求体**:
```json
{
  "baseUrl": "https://xxx",
  "token": "xxx",
  "toUserId": "xxx",
  "text": "你好",
  "contextToken": "xxx",
  "channelVersion": "2.1.10"
}
```

**响应**:
```json
{
  "success": true,
  "content": "ok"
}
```

---

## 微信API接口

### 获取二维码

**接口**: `GET /ilink/bot/get_bot_qrcode`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bot_type` | string | 是 | 机器人类型，固定值 |

**响应示例**:
```json
{
  "qrcode": "xxx",
  "qrcode_img_content": "https://xxx"
}
```

---

### 查询二维码状态

**接口**: `GET /ilink/bot/get_qrcode_status`

**参数**:
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `qrcode` | string | 是 | 二维码字符串 |

**响应示例**:
```json
{
  "status": "scaned",
  "redirect_host": "xxx",
  "ilink_bot_id": "xxx",
  "bot_token": "xxx",
  "base_url": "https://xxx",
  "ilink_user_id": "xxx"
}
```

**状态说明**:
- `wait`: 等待扫码
- `scaned`: 已扫码，等待确认
- `expired`: 二维码已过期
- `confirmed`: 已确认登录

---

### 获取消息更新

**接口**: `POST /ilink/bot/getupdates`

**请求头**:
| 头名称 | 值 |
|--------|-----|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer xxx` |

**请求体**:
```json
{
  "get_updates_buf": "",
  "base_info": {
    "channel_version": "xxx"
  }
}
```

**响应示例**:
```json
{
  "get_updates_buf": "xxx",
  "msgs": [
    {
      "seq": 1,
      "message_id": "xxx",
      "from_user_id": "xxx",
      "to_user_id": "xxx",
      "message_type": 1,
      "message_state": 2,
      "item_list": [
        {
          "type": 1,
          "text_item": {
            "text": "你好"
          }
        }
      ],
      "context_token": "xxx"
    }
  ]
}
```

---

### 发送消息

**接口**: `POST /ilink/bot/sendmessage`

**请求头**:
| 头名称 | 值 |
|--------|-----|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer xxx` |

**请求体**:
```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "xxx",
    "client_id": "xxx",
    "message_type": 2,
    "message_state": 2,
    "item_list": [
      {
        "type": 1,
        "text_item": {
          "text": "你好"
        }
      }
    ],
    "context_token": "xxx"
  },
  "base_info": {
    "channel_version": "xxx"
  }
}
```

---

## LLM API接口

### 多API配置

系统支持配置多个API源，自动轮询使用，避免429限流。

配置方法见 [CONFIG.md](CONFIG.md)。

### 聊天补全

**接口**: `POST /v1/chat/completions`

**请求头**:
| 头名称 | 值 |
|--------|-----|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer sk-xxx` |

**请求体**:
```json
{
  "model": "deepseek-v4-pro-chat",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**响应示例**:
```json
{
  "id": "xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek-v4-pro-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！有什么我可以帮你的吗？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

---

## 消息枚举值

### MessageType

| 值 | 说明 |
|----|------|
| 0 | NONE |
| 1 | USER（用户消息） |
| 2 | BOT（机器人消息） |

### MessageState

| 值 | 说明 |
|----|------|
| 0 | NEW |
| 1 | GENERATING |
| 2 | FINISH（完成） |

### ItemType

| 值 | 说明 |
|----|------|
| 1 | TEXT（文本） |
