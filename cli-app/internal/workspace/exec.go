package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"
)

const (
	DefaultExecTimeout = 120 * time.Second
	MaxOutputBytes     = 1 << 20 // 1 MiB
)

type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func (w *Workspace) RunCommand(command string, cwdRel string, timeout time.Duration, extraEnv []string) (ExecResult, error) {
	if command == "" {
		return ExecResult{}, errors.New("command is required")
	}
	if timeout <= 0 {
		timeout = DefaultExecTimeout
	}

	cwd, err := w.Resolve(cwdRel)
	if err != nil {
		return ExecResult{}, err
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return ExecResult{}, fmt.Errorf("cwd: %w", err)
	}
	if !info.IsDir() {
		return ExecResult{}, errors.New("cwd must be a directory")
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), extraEnv...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if errors.Is(runErr, context.DeadlineExceeded) {
			return ExecResult{
				Stdout:   truncate(stdout.String(), MaxOutputBytes),
				Stderr:   truncate(stderr.String(), MaxOutputBytes) + "\ncommand timed out",
				ExitCode: -1,
			}, nil
		} else {
			return ExecResult{}, runErr
		}
	}

	return ExecResult{
		Stdout:   truncate(stdout.String(), MaxOutputBytes),
		Stderr:   truncate(stderr.String(), MaxOutputBytes),
		ExitCode: exitCode,
	}, nil
}

func truncate(s string, max int64) string {
	if int64(len(s)) <= max {
		return s
	}
	return s[:max] + "\n... (output truncated)"
}
