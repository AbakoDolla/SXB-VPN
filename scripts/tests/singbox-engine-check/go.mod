module sxb-vpn/singbox-engine-check

// sing-box 1.14 exige Go 1.25 : une version plus basse ici ferait échouer la
// résolution des modules avant même la vérification du moteur.
go 1.25.5

require github.com/sagernet/sing-box v1.14.1
