package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	ErrOutsideWorkspace = errors.New("path is outside the workspace")
	ErrNotFound         = errors.New("path not found")
)

type Workspace struct {
	Root string
}

func New(root string) (*Workspace, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("workspace root is not a directory")
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &Workspace{Root: resolved}, nil
}

func (w *Workspace) Resolve(rel string) (string, error) {
	if rel == "" {
		rel = "."
	}
	if filepath.IsAbs(rel) {
		return "", ErrOutsideWorkspace
	}

	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", ErrOutsideWorkspace
	}

	joined := filepath.Join(w.Root, clean)
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}

	root := w.Root + string(os.PathSeparator)
	if abs != w.Root && !strings.HasPrefix(abs, root) {
		return "", ErrOutsideWorkspace
	}

	// Resolve the nearest existing path so symlinks cannot redirect reads,
	// writes, deletes, commands, or renames outside the configured workspace.
	existing := abs
	for {
		if _, statErr := os.Lstat(existing); statErr == nil {
			break
		} else if !os.IsNotExist(statErr) {
			return "", statErr
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", ErrOutsideWorkspace
		}
		existing = parent
	}
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	if resolved != w.Root && !strings.HasPrefix(resolved, root) {
		return "", ErrOutsideWorkspace
	}
	return abs, nil
}

type FileEntry struct {
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

func (w *Workspace) ReadFile(rel string) (string, error) {
	abs, err := w.Resolve(rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("path is a directory")
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (w *Workspace) WriteFile(rel string, content string) error {
	abs, err := w.Resolve(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, []byte(content), 0o644)
}

func (w *Workspace) ListFiles(rel string, recursive bool) ([]FileEntry, error) {
	abs, err := w.Resolve(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !info.IsDir() {
		return []FileEntry{{
			Path:  rel,
			IsDir: false,
			Size:  info.Size(),
		}}, nil
	}

	var entries []FileEntry
	walkFn := func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == abs {
			return nil
		}
		relPath, err := filepath.Rel(w.Root, path)
		if err != nil {
			return err
		}
		relPath = filepath.ToSlash(relPath)
		if d.IsDir() && strings.HasPrefix(filepath.Base(path), ".") && path != abs {
			if filepath.Base(path) == ".scrapeflow-cli" {
				return filepath.SkipDir
			}
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		entries = append(entries, FileEntry{
			Path:  relPath,
			IsDir: d.IsDir(),
			Size:  info.Size(),
		})
		if !recursive && d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	}

	if recursive {
		err = filepath.WalkDir(abs, walkFn)
	} else {
		dirEntries, readErr := os.ReadDir(abs)
		if readErr != nil {
			return nil, readErr
		}
		for _, d := range dirEntries {
			if strings.HasPrefix(d.Name(), ".") {
				continue
			}
			info, infoErr := d.Info()
			if infoErr != nil {
				return nil, infoErr
			}
			relPath, relErr := filepath.Rel(w.Root, filepath.Join(abs, d.Name()))
			if relErr != nil {
				return nil, relErr
			}
			entries = append(entries, FileEntry{
				Path:  filepath.ToSlash(relPath),
				IsDir: d.IsDir(),
				Size:  info.Size(),
			})
		}
	}
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func (w *Workspace) DeleteFile(rel string) error {
	abs, err := w.Resolve(rel)
	if err != nil {
		return err
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	if info.IsDir() {
		return errors.New("cannot delete a directory with delete_file")
	}
	return os.Remove(abs)
}

func (w *Workspace) RenameFile(oldRel, newRel string) error {
	oldAbs, err := w.Resolve(oldRel)
	if err != nil {
		return err
	}
	newAbs, err := w.Resolve(newRel)
	if err != nil {
		return err
	}
	if _, err := os.Stat(oldAbs); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	if _, err := os.Stat(newAbs); err == nil {
		return errors.New("destination already exists")
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		return err
	}
	return os.Rename(oldAbs, newAbs)
}

func (w *Workspace) SearchFiles(query string, limit int) ([]FileEntry, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil, errors.New("query is required")
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	var matches []FileEntry
	err := filepath.WalkDir(w.Root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == w.Root {
			return nil
		}
		if d.IsDir() && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(w.Root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() || !strings.Contains(strings.ToLower(rel), query) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		matches = append(matches, FileEntry{Path: rel, Size: info.Size()})
		return nil
	})
	sort.Slice(matches, func(i, j int) bool { return matches[i].Path < matches[j].Path })
	if len(matches) > limit {
		matches = matches[:limit]
	}
	return matches, err
}
