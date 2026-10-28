param(
  [int]$Max = 512
)

# 立绘优化第一步：缩放到挂件实际需要的尺寸，并导出 raw RGBA。
#
# 为什么要缩：挂件立绘宽度是气泡的 56%，最大档 SIZE_PX.lg = 244px
#   -> 最大显示 244 * 0.56 = 137 CSS px，3 倍屏需要 411 设备像素。
#   取 512 有足够余量；512*512*4 = 1 MB，比原图 1026*1026*4 = 4 MB 省 3 MB 解码内存。
#
# 为什么要导出 raw：System.Drawing 的 PNG 编码器压缩率一般（512x512 编成 264 KB，
# 而同样像素用「最优行过滤 + zlib -9」只要 170 KB 上下）。内联成 base64 还会放大
# 4/3，所以每省 1 KB 文件，bundle 省 1.33 KB。raw 交给 scripts/optimize-png.mjs 重编码。
#
# 两个坑：
# 1. System.Drawing.Image.FromFile 会锁住源文件，直接 Save 到同一路径会静默失败
#    （文件时间戳都不变）。先把源读进内存流、释放句柄，缩放后写临时文件，最后替换。
# 2. 工程根目录由脚本自身位置（PSScriptRoot 的上一级）推导，不依赖调用方工作目录。
#
# 幂等：始终从 assets/originals 的备份读，重复执行结果一致。

Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Targets = @("DSniang02.png", "whale.png")
$work = Join-Path $ProjectRoot "assets\.work"
New-Item -ItemType Directory -Force -Path $work | Out-Null

foreach ($name in $Targets) {
  $path = Join-Path $ProjectRoot "assets\$name"
  $orig = Join-Path $ProjectRoot "assets\originals\$name"
  if (-not (Test-Path $orig)) {
    "跳过 $name：没有 assets/originals 备份"
    continue
  }

  $bytes = [System.IO.File]::ReadAllBytes($orig)
  $ms = New-Object System.IO.MemoryStream(, $bytes)
  $src = [System.Drawing.Image]::FromStream($ms)
  try {
    $longest = [Math]::Max($src.Width, $src.Height)
    $scale = [Math]::Min(1.0, $Max / $longest)
    $w = [int][Math]::Round($src.Width * $scale)
    $h = [int][Math]::Round($src.Height * $scale)
    $srcW = $src.Width
    $srcH = $src.Height
    $srcSize = (Get-Item $orig).Length

    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.DrawImage($src, 0, 0, $w, $h)
    } finally { $g.Dispose() }

    $tmp = "$path.tmp.png"
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)

    # 顺手把缩放后的像素直接导出 raw（省一次解码）
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = $data.Stride
      $rowBytes = $w * 4
      $len = $stride * $h
      $buf = New-Object byte[] $len
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $len)
      if ($stride -eq $rowBytes) {
        [System.IO.File]::WriteAllBytes((Join-Path $work "$name.raw"), $buf)
      } else {
        $out = New-Object byte[] ($rowBytes * $h)
        for ($y = 0; $y -lt $h; $y++) {
          [Array]::Copy($buf, $y * $stride, $out, $y * $rowBytes, $rowBytes)
        }
        [System.IO.File]::WriteAllBytes((Join-Path $work "$name.raw"), $out)
      }
    } finally {
      $bmp.UnlockBits($data)
    }
    $bmp.Dispose()
  } finally {
    $src.Dispose()
    $ms.Dispose()
  }

  Move-Item -Path $tmp -Destination $path -Force
  $newSize = (Get-Item $path).Length
  '{"width":' + $w + ',"height":' + $h + '}' | Set-Content -Path (Join-Path $work "$name.json") -Encoding ASCII

  "{0}: {1}x{2} -> {3}x{4}, 文件 {5:N0} KB -> {6:N0} KB, 解码 {7:N0} KB -> {8:N0} KB" -f `
    $name, $srcW, $srcH, $w, $h, ($srcSize / 1KB), ($newSize / 1KB), ($srcW * $srcH * 4 / 1KB), ($w * $h * 4 / 1KB)
}
