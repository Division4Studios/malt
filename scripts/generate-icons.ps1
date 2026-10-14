# Reproduce original MALT wheat icons with native Windows drawing APIs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../web'))
foreach ($size in @(192, 512)) {
    $bitmap = New-Object Drawing.Bitmap($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#101018'))
    $scale = $size / 512.0
    $graphics.ScaleTransform([single]$scale, [single]$scale)
    $pen = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#e8a634'), 12)
    $pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($pen, 256, 384, 256, 152)
    $brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#e8a634'))
    foreach ($level in @(144, 192, 240, 288)) {
        foreach ($side in @(-1, 1)) {
            $grain = New-Object Drawing.Drawing2D.GraphicsPath
            $grain.AddBezier(256, ($level+50), (256+36*$side), ($level+50), (256+64*$side), ($level+24), (256+60*$side), $level)
            $grain.AddBezier((256+60*$side), $level, (256+22*$side), $level, (256+6*$side), ($level+20), 256, ($level+50))
            $grain.CloseFigure()
            $brush.Color = [Drawing.ColorTranslator]::FromHtml($(if ($side -eq -1) { '#e8a634' } else { '#f4b73e' }))
            $graphics.FillPath($brush, $grain)
            $grain.Dispose()
            $pen.Width = 8
            $graphics.DrawLine($pen, (256+60*$side), $level, (256+78*$side), ($level-24))
        }
    }
    $tip = New-Object Drawing.Drawing2D.GraphicsPath
    $tip.AddBezier(256, 164, 228, 144, 232, 120, 256, 104)
    $tip.AddBezier(256, 104, 280, 120, 284, 144, 256, 164)
    $tip.CloseFigure()
    $brush.Color = [Drawing.ColorTranslator]::FromHtml('#ff7a4d')
    $graphics.FillPath($brush, $tip)
    $bitmap.Save((Join-Path $assetRoot ('icon-' + $size + '.png')), [Drawing.Imaging.ImageFormat]::Png)
    $tip.Dispose(); $brush.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
