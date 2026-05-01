package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
	"xrk-ai-multiuser-core/internal/config"

	"github.com/gin-gonic/gin"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Prompt   string `json:"prompt"`
	Messages []Message `json:"messages"`
}

type ChatResponse struct {
	Success bool `json:"success"`
	Content string `json:"content"`
	Error string `json:"error,omitempty"`
}

type OpenAIRequest struct {
	Model    string `json:"model"`
	Messages []Message `json:"messages"`
}

type OpenAIResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// 微信相关类型
type WeixinSendRequest struct {
	BaseUrl      string `json:"baseUrl"`
	Token        string `json:"token"`
	ToUserId     string `json:"toUserId"`
	Text         string `json:"text"`
	ContextToken string `json:"contextToken"`
	ChannelVersion string `json:"channelVersion"`
}

type WeixinQRRequest struct {
	BaseUrl string `json:"baseUrl"`
	BotType string `json:"botType"`
}

type WeixinQRStatusRequest struct {
	BaseUrl string `json:"baseUrl"`
	Qrcode string `json:"qrcode"`
}

type WeixinQRResponse struct {
	Success bool `json:"success"`
	Qrcode string `json:"qrcode,omitempty"`
	Status string `json:"status"`
	Data interface{} `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

var (
	currentAPIIndex int
	apiMutex        sync.Mutex
)

func HandleChat(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ChatRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ChatResponse{
				Success: false,
				Error: err.Error(),
			})
			return
		}

		content, err := callAPIs(cfg, req.Messages)
		if err != nil {
			c.JSON(http.StatusInternalServerError, ChatResponse{
				Success: false,
				Error: err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, ChatResponse{
			Success: true,
			Content: content,
		})
	}
}

func callAPIs(cfg *config.Config, messages []Message) (string, error) {
	apiMutex.Lock()
	startIndex := currentAPIIndex
	apiMutex.Unlock()

	for i := 0; i < len(cfg.APIs); i++ {
		apiIndex := (startIndex + i) % len(cfg.APIs)
		api := cfg.APIs[apiIndex]

		fmt.Printf("Trying API %d: %s\n", apiIndex, api.URL)

		content, err := callSingleAPI(api, messages)
		if err == nil {
			apiMutex.Lock()
			currentAPIIndex = (apiIndex + 1) % len(cfg.APIs)
			apiMutex.Unlock()
			return content, nil
		}
		fmt.Printf("API %d failed: %v\n", apiIndex, err)
	}

	return "", fmt.Errorf("all APIs failed")
}

func callSingleAPI(api config.APIConfig, messages []Message) (string, error) {
	reqBody := OpenAIRequest{
		Model:    api.Model,
		Messages: messages,
	}
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequest("POST", api.URL, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+api.Key)

	client := &http.Client{
		Timeout: 60 * time.Second,
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("API error: %d - %s", resp.StatusCode, string(bodyBytes))
	}

	var openAIResp OpenAIResponse
	if err := json.Unmarshal(bodyBytes, &openAIResp); err != nil {
		return "", err
	}

	if openAIResp.Error != nil {
		return "", fmt.Errorf("API error: %s", openAIResp.Error.Message)
	}

	if len(openAIResp.Choices) == 0 {
		return "", fmt.Errorf("no choices in response")
	}

	return openAIResp.Choices[0].Message.Content, nil
}

// 微信 API 处理器
func HandleGetQRCode(c *gin.Context) {
	var req WeixinQRRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	endpoint := fmt.Sprintf("%s/ilink/bot/get_bot_qrcode?bot_type=%s", req.BaseUrl, url.QueryEscape(req.BotType))
	
	resp, err := http.Get(endpoint)
	if err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	var result map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, WeixinQRResponse{
		Success: true,
		Data: result,
	})
}

func HandlePollQRStatus(c *gin.Context) {
	var req WeixinQRStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	endpoint := fmt.Sprintf("%s/ilink/bot/get_qrcode_status?qrcode=%s", req.BaseUrl, url.QueryEscape(req.Qrcode))
	
	client := &http.Client{
		Timeout: 35 * time.Second,
	}
	
	resp, err := client.Get(endpoint)
	if err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	var result map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		c.JSON(http.StatusInternalServerError, WeixinQRResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	status := "wait"
	if s, ok := result["status"].(string); ok {
		status = s
	}

	c.JSON(http.StatusOK, WeixinQRResponse{
		Success: true,
		Status: status,
		Data: result,
	})
}

func HandleWeixinSend(c *gin.Context) {
	var req WeixinSendRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ChatResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	// 生成 client_id
	clientId := fmt.Sprintf("%d", time.Now().UnixNano())

	// 构造请求体
	itemList := []map[string]interface{}{
		{
			"type": 1,
			"text_item": map[string]string{
				"text": req.Text,
			},
		},
	}

	body := map[string]interface{}{
		"msg": map[string]interface{}{
			"from_user_id": "",
			"to_user_id": req.ToUserId,
			"client_id": clientId,
			"message_type": 2,
			"message_state": 2,
			"item_list": itemList,
			"context_token": req.ContextToken,
		},
		"base_info": map[string]string{
			"channel_version": req.ChannelVersion,
		},
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ChatResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	httpReq, err := http.NewRequest("POST", req.BaseUrl+"/ilink/bot/sendmessage", bytes.NewBuffer(jsonBody))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ChatResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+req.Token)

	client := &http.Client{
		Timeout: 15 * time.Second,
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ChatResponse{
			Success: false,
			Error: err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		c.JSON(http.StatusInternalServerError, ChatResponse{
			Success: false,
			Error: string(bodyBytes),
		})
		return
	}

	c.JSON(http.StatusOK, ChatResponse{
		Success: true,
		Content: "ok",
	})
}

func HandleGetUpdates(c *gin.Context) {
  var req struct {
    BaseUrl        string `json:"baseUrl"`
    Token          string `json:"token"`
    GetUpdatesBuf  string `json:"getUpdatesBuf"`
    TimeoutMs      int    `json:"timeoutMs"`
  }
  if err := c.ShouldBindJSON(&req); err != nil {
    c.JSON(http.StatusBadRequest, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }

  // 构造请求
  body := map[string]interface{}{
    "get_updates_buf": req.GetUpdatesBuf,
    "base_info": map[string]string{
      "channel_version": "2.1.10",
    },
  }
  jsonBody, err := json.Marshal(body)
  if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }

  // 发送请求
  httpReq, err := http.NewRequest("POST", req.BaseUrl+"/ilink/bot/getupdates", bytes.NewBuffer(jsonBody))
  if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }

  httpReq.Header.Set("Content-Type", "application/json")
  httpReq.Header.Set("Authorization", "Bearer "+req.Token)

  client := &http.Client{
    Timeout: time.Duration(req.TimeoutMs) * time.Millisecond,
  }

  resp, err := client.Do(httpReq)
  if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }
  defer resp.Body.Close()

  if resp.StatusCode >= 400 {
    bodyBytes, _ := io.ReadAll(resp.Body)
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": string(bodyBytes),
    })
    return
  }

  bodyBytes, err := io.ReadAll(resp.Body)
  if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }

  var result map[string]interface{}
  if err := json.Unmarshal(bodyBytes, &result); err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
      "success": false,
      "error": err.Error(),
    })
    return
  }

  c.JSON(http.StatusOK, gin.H{
    "success": true,
    "data": result,
  })
}

func HandleHealth(c *gin.Context) {
  c.JSON(http.StatusOK, gin.H{
    "status": "ok",
  })
}
