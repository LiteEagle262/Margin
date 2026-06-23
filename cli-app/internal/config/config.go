package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	DirName  = ".scrapeflow-cli"
	FileName = "config.json"
)

type Config struct {
	WorkspaceRoot string `json:"workspace_root"`
	AuthToken     string `json:"auth_token,omitempty"`
	Port          int    `json:"port"`
	Host          string `json:"host"`
	Mode          string `json:"mode,omitempty"`
	CodexCommand  string `json:"codex_command,omitempty"`
	CodexModel    string `json:"codex_model,omitempty"`
	CodexSandbox  string `json:"codex_sandbox,omitempty"`
	CodexApproval string `json:"codex_approval,omitempty"`
}

func Default() Config {
	return Config{
		Port:          9230,
		Host:          "127.0.0.1",
		Mode:          "workspace",
		CodexCommand:  "codex",
		CodexSandbox:  "workspace-write",
		CodexApproval: "never",
	}
}

func DirFromCWD() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, DirName), nil
}

func PathFromCWD() (string, error) {
	dir, err := DirFromCWD()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, FileName), nil
}

func Load() (Config, error) {
	path, err := PathFromCWD()
	if err != nil {
		return Config{}, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, errors.New("workspace not initialized — run `scrapeflow-cli init` in your project root")
		}
		return Config{}, err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("invalid config: %w", err)
	}
	if cfg.Port == 0 {
		cfg.Port = Default().Port
	}
	if cfg.Host == "" {
		cfg.Host = Default().Host
	}
	if cfg.Mode == "" {
		cfg.Mode = Default().Mode
	}
	if cfg.CodexCommand == "" {
		cfg.CodexCommand = Default().CodexCommand
	}
	if cfg.CodexSandbox == "" {
		cfg.CodexSandbox = Default().CodexSandbox
	}
	if cfg.CodexApproval == "" {
		cfg.CodexApproval = Default().CodexApproval
	}
	return cfg, nil
}

func Save(cfg Config) error {
	dir, err := DirFromCWD()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(dir, FileName)
	return os.WriteFile(path, data, 0o600)
}

func Init(workspaceRoot string) (Config, error) {
	abs, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return Config{}, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return Config{}, fmt.Errorf("workspace path: %w", err)
	}
	if !info.IsDir() {
		return Config{}, errors.New("workspace path must be a directory")
	}

	cfg := Default()
	cfg.WorkspaceRoot = abs
	if err := Save(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func SetAuthToken(token string) error {
	cfg, err := Load()
	if err != nil {
		return err
	}
	cfg.AuthToken = token
	return Save(cfg)
}
