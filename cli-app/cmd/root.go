package cmd

import (
	"fmt"
	"os"

	"cli-app/internal/config"
	"cli-app/internal/server"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "margin-cli",
	Short: "Experimental local bridge for bounded terminal and file access",
	Long: `margin-cli runs an experimental local WebSocket bridge so a compatible
client can read, write, and execute commands within a bounded workspace directory.

The current Margin Chrome extension does not connect to this protocol. Initialize
in a project root, configure a compatible client with the generated token, then
run serve to start the bridge.`,
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
		fmt.Printf("Configure a compatible client with auth_token from %s/%s.\n", config.DirName, config.FileName)
		fmt.Println("Next: run `margin-cli serve`")
		return nil
	},
}

var authCmd = &cobra.Command{
	Use:   "auth <token>",
	Short: "Set an auth token of at least 32 bytes",
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
	Short: "Start the experimental WebSocket bridge",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		bridge, err := server.New(cfg)
		if err != nil {
			return err
		}
		return bridge.ListenAndServe()
	},
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
		fmt.Println("Auth:       token configured")
		return nil
	},
}

var toolsCmd = &cobra.Command{
	Use:   "tools",
	Short: "List tools available to compatible bridge clients",
	RunE: func(cmd *cobra.Command, args []string) error {
		for _, tool := range server.Tools() {
			fmt.Printf("- %s\n", tool["name"])
		}
		return nil
	},
}
