module sxb-vpn/singbox-engine-check

// Aligne sur le go.mod de sing-box 1.12 : une version plus basse ferait echouer
// la resolution des modules avant meme la verification du moteur.
go 1.23.1

require github.com/sagernet/sing-box v1.12.9
