// Run with the build-libbox.sh tags and the Kotlin harness's runtime.json.
// CheckConfig constructs and closes the real engine; it does not start a VPN.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	"github.com/sagernet/sing-box/experimental/libbox"
)

func main() {
	if err := check(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("sing-box 1.11.15 libbox.CheckConfig accepted the synthetic native runtime graph (not a connection test)")
}

func check() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: engine-check SYNTHETIC_RUNTIME_JSON OFFLINE_ENGINE_DATA_DIRECTORY")
	}
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return fmt.Errorf("cannot verify the sing-box dependency version")
	}
	pinned := false
	for _, dependency := range build.Deps {
		if dependency.Path == "github.com/sagernet/sing-box" {
			pinned = dependency.Version == "v1.11.15" && dependency.Replace == nil
		}
	}
	if !pinned {
		return fmt.Errorf("the engine checker requires unmodified sing-box v1.11.15")
	}
	content, err := os.ReadFile(os.Args[1])
	if err != nil {
		return fmt.Errorf("cannot read synthetic runtime input: %w", err)
	}
	var config struct {
		Protocol  string `json:"protocol"`
		Outbounds []struct {
			Server string `json:"server"`
		} `json:"outbounds"`
		Route struct {
			Rules []struct {
				Geosite []string `json:"geosite"`
			} `json:"rules"`
		} `json:"route"`
	}
	if err := json.Unmarshal(content, &config); err != nil {
		return fmt.Errorf("invalid synthetic runtime JSON: %w", err)
	}
	if config.Protocol != "" {
		return fmt.Errorf("use Kotlin-generated runtime.json, not canonical.json")
	}
	if len(config.Outbounds) == 0 {
		return fmt.Errorf("synthetic native outbounds are required")
	}
	for _, outbound := range config.Outbounds {
		if outbound.Server != "" && !strings.HasSuffix(outbound.Server, ".example.test") {
			return fmt.Errorf("only synthetic example.test endpoints are allowed; never supply a private provider export")
		}
	}
	for _, rule := range config.Route.Rules {
		if len(rule.Geosite) != 0 {
			if _, err := os.Stat(filepath.Join(os.Args[2], "geosite.db")); err != nil {
				return fmt.Errorf("equivalent provider geosite.db is required offline; refusing to download or drop the rule")
			}
		}
	}
	if err := os.Chdir(os.Args[2]); err != nil {
		return fmt.Errorf("cannot use offline engine data directory: %w", err)
	}
	if err := libbox.CheckConfig(string(content)); err != nil {
		return fmt.Errorf("libbox rejected the synthetic native graph: %w", err)
	}
	return nil
}
