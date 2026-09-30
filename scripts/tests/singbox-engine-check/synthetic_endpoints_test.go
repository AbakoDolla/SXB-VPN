package main

import "testing"

func TestSyntheticEndpoints(t *testing.T) {
	for _, server := range []string{"vpn.example.test", "front.example.test",
		"192.0.2.1", "198.51.100.7", "203.0.113.12", "203.0.113.13"} {
		if !syntheticEndpoint(server) {
			t.Errorf("reserved fixture refused: %s", server)
		}
	}
	for _, server := range []string{"vpnsxb.afrihall.com", "8.8.8.8", "141.95.112.93",
		"localhost", "127.0.0.1", "10.0.0.1", "169.254.169.254", "::1",
		"vpn.example.test.attacker.invalid", "not-an-ip", "203.0.114.1"} {
		if syntheticEndpoint(server) {
			t.Errorf("non-fixture endpoint allowed: %s", server)
		}
	}
}
