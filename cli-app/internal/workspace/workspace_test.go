package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRejectsTraversal(t *testing.T) {
	ws, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.Resolve("../outside.txt"); err != ErrOutsideWorkspace {
		t.Fatalf("expected ErrOutsideWorkspace, got %v", err)
	}
}

func TestResolveRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}

	ws, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.ReadFile("escape/secret.txt"); err != ErrOutsideWorkspace {
		t.Fatalf("expected ErrOutsideWorkspace, got %v", err)
	}
	if err := ws.WriteFile("escape/new.txt", "nope"); err != ErrOutsideWorkspace {
		t.Fatalf("expected ErrOutsideWorkspace, got %v", err)
	}
}

func TestWorkspaceFileLifecycle(t *testing.T) {
	ws, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.WriteFile("src/a.txt", "hello"); err != nil {
		t.Fatal(err)
	}
	if err := ws.RenameFile("src/a.txt", "src/b.txt"); err != nil {
		t.Fatal(err)
	}
	content, err := ws.ReadFile("src/b.txt")
	if err != nil {
		t.Fatal(err)
	}
	if content != "hello" {
		t.Fatalf("unexpected content %q", content)
	}
	matches, err := ws.SearchFiles("b.txt", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].Path != "src/b.txt" {
		t.Fatalf("unexpected matches: %#v", matches)
	}
}

func TestListFilesExcludesMarginConfigDirectory(t *testing.T) {
	root := t.TempDir()
	for _, dirName := range []string{".margin-cli"} {
		if err := os.MkdirAll(filepath.Join(root, dirName), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, dirName, "config.json"), []byte("secret"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "visible.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}

	ws, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := ws.ListFiles(".", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "visible.txt" {
		t.Fatalf("unexpected entries: %#v", entries)
	}
}
