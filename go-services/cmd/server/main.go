package main

import (
	"log"
	"xrk-ai-multiuser-core/internal/api"
	"xrk-ai-multiuser-core/internal/config"

	"github.com/gin-gonic/gin"
)

func main() {
	cfg, err := config.Load("../../plugin-config.json")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	r := gin.Default()

	// LLM API 路由
	llmGroup := r.Group("/api/v1/llm")
	{
		llmGroup.POST("/chat", api.HandleChat(cfg))
		llmGroup.GET("/health", api.HandleHealth)
	}

	// 微信 API 路由
  wxGroup := r.Group("/api/v1/wx")
  {
    wxGroup.POST("/qrcode", api.HandleGetQRCode)
    wxGroup.POST("/qrcode/status", api.HandlePollQRStatus)
    wxGroup.POST("/send", api.HandleWeixinSend)
    wxGroup.POST("/getupdates", api.HandleGetUpdates)
  }

	log.Println("Starting server on :8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
