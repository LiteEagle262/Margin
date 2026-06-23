package cmd

import (
	"errors"
	"fmt"
	"os"

	"cli-app/internal/config"
	"cli-app/internal/server"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "scrapeflow-cli",
	Short: "ScrapeFlow CLI bridge for AI terminal and file access",
	Long: `scrapeflow-cli runs a local WebSocket bridge so the ScrapeFlow extension
can read, write, and execute commands within a bounded workspace directory.

Initialize in your project root, optionally authenticate with the token shown by the extension,
then run serve to start the bridge.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(authCmd)
	rootCmd.AddCommand(serveCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(toolsCmd)
}

var initCmd = &cobra.Command{
	Use:   "init [path]",
	Short: "Initialize the CLI workspace in the current or given directory",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		root := "."
		if len(args) > 0 {
			root = args[0]
		}
		cfg, err := config.Init(root)
		if err != nil {
			return err
		}
		fmt.Printf("Initialized workspace at %s\n", cfg.WorkspaceRoot)
		fmt.Printf("Config saved to %s/%s\n", config.DirName, config.FileName)
		fmt.Println("Next: run `scrapeflow-cli serve --mode workspace` or `scrapeflow-cli serve --mode codex`")
		return nil
	},
}

var authCmd = &cobra.Command{
	Use:   "auth <token>",
	Short: "Set the auth token shown in the ScrapeFlow extension",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := config.SetAuthToken(args[0]); err != nil {
			return err
		}
		fmt.Println("Auth token saved.")
		return nil
	},
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the WebSocket bridge for extension communication",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		if mode, _ := cmd.Flags().GetString("mode"); mode != "" {
			if mode != "workspace" && mode != "codex" {
				return errors.New("mode must be `workspace` or `codex`")
			}
			cfg.Mode = mode
		}
		if model, _ := cmd.Flags().GetString("model"); model != "" {
			cfg.CodexModel = model
		}
		bridge, err := server.New(cfg)
		if err != nil {
			return err
		}
		return bridge.ListenAndServe()
	},
}

func init() {
	serveCmd.Flags().String("mode", "", "Bridge mode: workspace or codex")
	serveCmd.Flags().String("model", "", "Optional Codex model override")
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show workspace and connection settings",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		fmt.Printf("Workspace:  %s\n", cfg.WorkspaceRoot)
		fmt.Printf("Bridge:     ws://%s:%d\n", cfg.Host, cfg.Port)
		fmt.Printf("Mode:       %s\n", cfg.Mode)
		if cfg.AuthToken != "" {
			fmt.Println("Auth:       token configured")
		} else {
			fmt.Println("Auth:       no token (localhost connections accepted)")
		}
		return nil
	},
}

var toolsCmd = &cobra.Command{
	Use:   "tools",
	Short: "List available bridge tools (for extension integration)",
	RunE: func(cmd *cobra.Command, args []string) error {
		for _, tool := range server.Tools() {
			fmt.Printf("- %s\n", tool["name"])
		}
		return nil
	},
}
