// Run with the build-libbox.sh tags and the Kotlin harness's runtime.json.
// CheckConfig constructs and closes the real engine; it does not start a VPN.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	"github.com/sagernet/sing-box/common/geosite"
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
	var domainReader *geosite.Reader
	var domainFile *os.File
	for _, rule := range config.Route.Rules {
		if len(rule.Geosite) != 0 {
			if domainReader == nil {
				databasePath := filepath.Join(os.Args[2], "geosite.db")
				data, err := os.ReadFile(databasePath)
				if err != nil {
					return fmt.Errorf("pinned offline geosite.db required: %w", err)
				}
				if fmt.Sprintf("%x", sha256.Sum256(data)) != "03cbdc0ceab1aa8f0620af77d32e990a3850acb653ffdced8efac137277930b2" {
					return fmt.Errorf("offline geosite checksum mismatch")
				}
				domainFile, err = os.Open(databasePath)
				if err != nil {
					return err
				}
				defer domainFile.Close()
				domainReader, _, err = geosite.NewReader(domainFile)
				if err != nil {
					return fmt.Errorf("native geosite reader rejected the database: %w", err)
				}
			}
			for _, category := range rule.Geosite {
				items, err := domainReader.Read(category)
				if err != nil || len(items) == 0 {
					return fmt.Errorf("offline geosite category %s is missing or invalid", category)
				}
				fmt.Printf("Native geosite reader loaded %s (%d rules)\n", category, len(items))
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
