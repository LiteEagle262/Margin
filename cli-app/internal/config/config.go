package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	DirName           = ".margin-cli"
	FileName          = "config.json"
	MinAuthTokenBytes = 32
	authTokenBytes    = 32
)

type Config struct {
	WorkspaceRoot string `json:"workspace_root"`
	AuthToken     string `json:"auth_token,omitempty"`
	Port          int    `json:"port"`
	Host          string `json:"host"`
}

func Default() Config {
	return Config{
		Port: 9230,
		Host: "127.0.0.1",
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

func configPathsFromCWD() ([]string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(cwd, DirName, FileName),
	}, nil
}

func Load() (Config, error) {
	return load(true)
}

func load(validateAuthToken bool) (Config, error) {
	paths, err := configPathsFromCWD()
	if err != nil {
		return Config{}, err
	}

	var data []byte
	for _, path := range paths {
		data, err = os.ReadFile(path)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return Config{}, err
		}
	}
	if err != nil {
		return Config{}, errors.New("workspace not initialized — run `margin-cli init` in your project root")
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
	cfg.AuthToken = strings.TrimSpace(cfg.AuthToken)
	if cfg.AuthToken == "" {
		cfg.AuthToken, err = generateAuthToken()
		if err != nil {
			return Config{}, err
		}
		// Persist a generated token so legacy blank-token configs cannot reopen the bridge.
		if err := Save(cfg); err != nil {
			return Config{}, fmt.Errorf("persist generated auth token: %w", err)
		}
	} else if validateAuthToken {
		if err := ValidateAuthToken(cfg.AuthToken); err != nil {
			return Config{}, fmt.Errorf("invalid auth token in config: %w; replace it with `margin-cli auth <token>`", err)
		}
	}
	return cfg, nil
}

func Save(cfg Config) error {
	cfg.AuthToken = strings.TrimSpace(cfg.AuthToken)
	if err := ValidateAuthToken(cfg.AuthToken); err != nil {
		return err
	}
	dir, err := DirFromCWD()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("config directory must be a real directory, not a symlink")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(dir, FileName)
	temporary, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
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
	cfg.AuthToken, err = generateAuthToken()
	if err != nil {
		return Config{}, err
	}
	if err := Save(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func SetAuthToken(token string) error {
	token = strings.TrimSpace(token)
	if err := ValidateAuthToken(token); err != nil {
		return err
	}
	// Skip old-value validation so `auth` can recover legacy weak-token configs.
	cfg, err := load(false)
	if err != nil {
		return err
	}
	cfg.AuthToken = token
	return Save(cfg)
}

func ValidateAuthToken(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("auth token must not be empty")
	}
	if len(token) < MinAuthTokenBytes {
		return fmt.Errorf("auth token must be at least %d bytes", MinAuthTokenBytes)
	}
	return nil
}

func generateAuthToken() (string, error) {
	random := make([]byte, authTokenBytes)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate auth token: %w", err)
	}
	return "mrg_" + base64.RawURLEncoding.EncodeToString(random), nil
}
