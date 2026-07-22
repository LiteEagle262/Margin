package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testAuthToken = "0123456789abcdef0123456789abcdef"

func chdirForTest(t *testing.T, dir string) {
	t.Helper()
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(original); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})
}

func writeTestConfig(t *testing.T, root, dirName string, cfg Config) {
	t.Helper()
	dir := filepath.Join(root, dirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, FileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestInitGeneratesAndPersistsStrongAuthToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)

	cfg, err := Init(root)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.AuthToken, "mrg_") || len(cfg.AuthToken) < 47 {
		t.Fatalf("expected generated auth token, got %q", cfg.AuthToken)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AuthToken != cfg.AuthToken {
		t.Fatal("generated auth token was not persisted")
	}
}

func TestLoadReplacesAndPersistsBlankAuthToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)
	writeTestConfig(t, root, DirName, Config{WorkspaceRoot: root, AuthToken: "  ", Port: 9411})

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.AuthToken, "mrg_") {
		t.Fatalf("expected migrated generated token, got %q", cfg.AuthToken)
	}

	data, err := os.ReadFile(filepath.Join(root, DirName, FileName))
	if err != nil {
		t.Fatal(err)
	}
	var persisted Config
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.AuthToken != cfg.AuthToken {
		t.Fatal("generated token was not persisted to the Margin config")
	}
}

func TestSetAuthTokenRejectsBlankToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	if err := SetAuthToken("   "); err == nil {
		t.Fatal("expected blank auth token to be rejected")
	}
}

func TestSetAuthTokenRejectsShortToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)
	if _, err := Init(root); err != nil {
		t.Fatal(err)
	}
	if err := SetAuthToken("short-token"); err == nil {
		t.Fatal("expected short auth token to be rejected")
	}
}

func TestLoadRejectsShortConfiguredToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)
	writeTestConfig(t, root, DirName, Config{WorkspaceRoot: root, AuthToken: "short-token", Port: 9411})

	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "at least 32 bytes") {
		t.Fatalf("expected weak configured token error, got %v", err)
	}
}

func TestSetAuthTokenCanReplaceShortConfiguredToken(t *testing.T) {
	root := t.TempDir()
	chdirForTest(t, root)
	writeTestConfig(t, root, DirName, Config{WorkspaceRoot: root, AuthToken: "short-token", Port: 9411})

	if err := SetAuthToken(testAuthToken); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AuthToken != testAuthToken {
		t.Fatalf("expected replacement token, got %q", loaded.AuthToken)
	}
}
