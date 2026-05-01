package config

import (
	"encoding/json"
	"os"
)

type APIConfig struct {
	URL    string `json:"url"`
	Key    string `json:"key"`
	Model  string `json:"model"`
}

type Config struct {
	APIs     []APIConfig `json:"apis"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}
