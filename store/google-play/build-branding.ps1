$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$output = Join-Path $PSScriptRoot "assets"
[System.IO.Directory]::CreateDirectory($output) | Out-Null
$logo = [System.Drawing.Image]::FromFile((Join-Path $root "public\logo-512.png"))
try {
    if ($logo.Width -ne 512 -or $logo.Height -ne 512) { throw "Branding source must be 512x512." }
    $logo.Save((Join-Path $output "icon-512.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap = New-Object System.Drawing.Bitmap(1024, 500, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle(0, 0, 1024, 500)),
        ([System.Drawing.Color]::FromArgb(13, 41, 79)),
        ([System.Drawing.Color]::FromArgb(9, 97, 140)), 0.0)
    $line = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(53, 194, 232)), 4)
    $node = New-Object System.Drawing.SolidBrush(([System.Drawing.Color]::FromArgb(174, 235, 255)))
    $white = New-Object System.Drawing.SolidBrush(([System.Drawing.Color]::White))
    $font = New-Object System.Drawing.Font("Segoe UI", 68, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.FillRectangle($background, 0, 0, 1024, 500)
        $graphics.DrawImage($logo, 100, 122, 256, 256)
        $graphics.DrawString("SXB VPN", $font, $white, 398, 176)
        $graphics.DrawLine($line, 412, 298, 580, 298)
        $graphics.DrawLine($line, 580, 298, 650, 336)
        $graphics.DrawLine($line, 650, 336, 866, 336)
        foreach ($point in @(@(412, 298), @(580, 298), @(650, 336), @(866, 336))) {
            $graphics.FillEllipse($node, ($point[0] - 7), ($point[1] - 7), 14, 14)
        }
        $bitmap.Save((Join-Path $output "feature-1024x500.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $font.Dispose(); $white.Dispose(); $node.Dispose(); $line.Dispose()
        $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
} finally {
    $logo.Dispose()
}
Write-Output "Generated store branding only; no screenshots or connection footage."
