# Original share artwork rendered with Windows System.Drawing; no npm or remote assets.
# The editable companion SVG lives in docs/assets/malt-social.svg.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetRoot = Join-Path $PSScriptRoot '../docs/assets'
[IO.Directory]::CreateDirectory($assetRoot) | Out-Null
$bitmap = New-Object Drawing.Bitmap(1280, 640)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$brushes = @{}
function Paint([string]$color) {
    if (-not $brushes.ContainsKey($color)) { $brushes[$color] = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($color)) }
    return $brushes[$color]
}
function Label([string]$value, [single]$x, [single]$y, [single]$size, [string]$color, [bool]$mono = $true) {
    $family = if ($mono) { 'Consolas' } else { 'Segoe UI' }
    $font = New-Object Drawing.Font($family, $size, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString($value, $font, (Paint $color), $x, $y)
    $font.Dispose()
}
try {
    $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#08080c'))
    $grid = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#1c1a21'), 1)
    foreach ($x in 640..1240 | Where-Object { $_ % 40 -eq 0 }) { $graphics.DrawLine($grid, $x, 32, $x, 608) }
    foreach ($y in 40..600 | Where-Object { $_ % 40 -eq 0 }) { $graphics.DrawLine($grid, 640, $y, 1232, $y) }
    $line = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#453521'), 1)
    $accent = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#e8a634'), 2)
    $graphics.DrawRectangle($line, 48, 32, 1184, 576)
    $graphics.DrawLine($accent, 48, 32, 104, 32)
    $graphics.DrawLine($accent, 48, 32, 48, 88)
    $graphics.DrawLine($accent, 1176, 608, 1232, 608)
    Label 'M U L T I - A G E N T  L O C A L  T E A M' 84 70 13 '#b9b1a4'
    $graphics.DrawLine($accent, 138, 280, 138, 162)
    foreach ($y in @(172, 194, 216, 238)) {
        $graphics.FillEllipse((Paint '#e8a634'), 111, $y, 27, 18)
        $graphics.FillEllipse((Paint '#f4b73e'), 139, $y, 27, 18)
    }
    $graphics.FillEllipse((Paint '#ff7a4d'), 130, 146, 16, 25)
    $title = New-Object Drawing.Font('Segoe UI', 122, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawString('MALT', $title, (Paint '#f5f3f0'), 196, 130)
    $graphics.DrawLine($line, 84, 314, 594, 314)
    Label 'Local agents.' 84 341 30 '#f5f3f0' $false
    Label 'Shared intent.' 84 387 30 '#f5f3f0' $false
    Label 'Verified delivery.' 84 433 30 '#e8a634' $false
    $graphics.DrawEllipse($line, 786, 124, 368, 368)
    $graphics.DrawEllipse($line, 840, 178, 260, 260)
    $nodes = @(@(970,124,'PLAN'), @(1144,252,'BUILD'), @(1078,457,'REVIEW'), @(862,457,'VERIFY'), @(795,252,'LEARN'))
    foreach ($node in $nodes) {
        $x = [single]$node[0]; $y = [single]$node[1]
        $graphics.DrawLine($accent, 970, 308, $x, $y)
        $graphics.FillRectangle((Paint '#101018'), ($x-52), ($y-25), 104, 50)
        $graphics.DrawRectangle($line, ($x-52), ($y-25), 104, 50)
        Label ([string]$node[2]) ($x-34) ($y-11) 16 '#b9b1a4'
    }
    $graphics.FillEllipse((Paint '#101018'), 914, 252, 112, 112)
    $graphics.DrawEllipse($accent, 914, 252, 112, 112)
    Label 'MISSION' 944 285 13 '#e8a634'
    Label 'CONTROL' 944 308 13 '#e8a634'
    Label 'LOCAL-FIRST / SUBSCRIPTION SESSIONS / MCP' 84 550 13 '#b9b1a4'
    Label 'CODEX + CLAUDE' 1070 550 13 '#7ed99b'
    $bitmap.Save((Join-Path $assetRoot 'malt-social.png'), [Drawing.Imaging.ImageFormat]::Png)
    $title.Dispose(); $grid.Dispose(); $line.Dispose(); $accent.Dispose()
} finally {
    foreach ($brush in $brushes.Values) { $brush.Dispose() }
    $graphics.Dispose(); $bitmap.Dispose()
}
