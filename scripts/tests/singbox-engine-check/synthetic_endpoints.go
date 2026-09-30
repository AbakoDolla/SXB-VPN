package main

import (
	"net/netip"
	"strings"
)

// RFC 5737 literals are needed to validate IP-versus-SNI parity. The checker
// never starts networking; real provider and private destinations stay refused.
func syntheticEndpoint(server string) bool {
	if strings.HasSuffix(server, ".example.test") {
		return true
	}
	address, err := netip.ParseAddr(server)
	if err != nil {
		return false
	}
	for _, prefix := range []string{"192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"} {
		if netip.MustParsePrefix(prefix).Contains(address) {
			return true
		}
	}
	return false
}
