# LifeBoard · 生成局域网 HTTPS 证书
#
# 为什么需要这个：
#   浏览器只在"安全来源"（https，或 localhost）下才允许网页注册 Service Worker。
#   没有 Service Worker 就没有离线缓存，手机出门就打不开页面。
#   而 https 页面又不允许访问 http 局域网地址，所以电脑上的服务器必须是 https——
#   这样手机只需要一个地址：在家能同步，出门靠缓存照常打开，数据只有一份。
#
# 做法：建一个只属于你电脑的根证书（CA），用它签一张服务器证书，
#       证书里写进 localhost、127.0.0.1 和当前所有局域网 IP。
#       你需要在手机上安装并信任那个根证书（只需要一次）。
#
# 用法：双击 tools\make-cert.cmd

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$certDir = Join-Path $root 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

# ---- 1. 找出这台电脑现在的局域网地址 ----
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' } |
    Select-Object -ExpandProperty IPAddress -Unique
} catch { }
if (-not $ips) {
  $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq 'InterNetwork' } |
    ForEach-Object { $_.IPAddressToString }
}
$ips = @($ips | Where-Object { $_ -and $_ -notlike '169.254.*' })
if (-not $ips) { $ips = @() }

Write-Host ''
Write-Host '  LifeBoard 局域网证书' -ForegroundColor Cyan
Write-Host '  ─────────────────────────────────────────────'
if ($ips.Count) {
  Write-Host ('  写进证书的地址：localhost, 127.0.0.1, ' + ($ips -join ', '))
} else {
  Write-Host '  没有检测到局域网地址，只写 localhost 和 127.0.0.1。' -ForegroundColor Yellow
  Write-Host '  连上 WiFi 之后请重新运行本脚本。' -ForegroundColor Yellow
}
Write-Host ''

$san = @('DNS=localhost', 'IPAddress=127.0.0.1')
foreach ($ip in $ips) { $san += "IPAddress=$ip" }
$sanText = ($san -join '&')

# ---- 2. 建根证书 ----
Write-Host '  正在创建根证书…'
$ca = New-SelfSignedCertificate `
  -Subject 'CN=LifeBoard Local CA' `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -KeyUsageProperty Sign `
  -KeyExportPolicy Exportable `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(10) `
  -TextExtension @('2.5.29.19={text}CA=true&pathlength=1')

# ---- 3. 用根证书签一张服务器证书 ----
Write-Host '  正在签发服务器证书…'
$leaf = New-SelfSignedCertificate `
  -Subject 'CN=LifeBoard' `
  -Signer $ca `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyExportPolicy Exportable `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(3) `
  -TextExtension @("2.5.29.17={text}$sanText")

# ---- 4. 导出成文件 ----
$password = -join (1..32 | ForEach-Object { 'abcdefghijkmnpqrstuvwxyz23456789'[(Get-Random -Maximum 32)] })
$secure = ConvertTo-SecureString -String $password -Force -AsPlainText

$pfxPath = Join-Path $certDir 'server.pfx'
$crtPath = Join-Path $certDir 'server.crt'
$caPath = Join-Path $certDir 'ca.cer'
$passPath = Join-Path $certDir 'pfx.pass'

Export-PfxCertificate -Cert $leaf -FilePath $pfxPath -Password $secure -Force | Out-Null
Export-Certificate -Cert $leaf -FilePath $crtPath -Type CERT -Force | Out-Null
Export-Certificate -Cert $ca -FilePath $caPath -Type CERT -Force | Out-Null
Set-Content -Path $passPath -Value $password -NoNewline -Encoding ascii

# ---- 5. 清掉证书存储，只在项目里留下文件 ----
Remove-Item "Cert:\CurrentUser\My\$($leaf.Thumbprint)" -Force -ErrorAction SilentlyContinue
Remove-Item "Cert:\CurrentUser\My\$($ca.Thumbprint)" -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  生成完成，文件都在 certs\ 目录里：' -ForegroundColor Green
Write-Host '    server.pfx   服务器证书和私钥（Node 直接读，不用管）'
Write-Host '    ca.cer       根证书 —— 这个要装到手机上'
Write-Host ''
Write-Host '  ─────────────────────────────────────────────'
Write-Host '  手机上要做的事（只需一次）：' -ForegroundColor Cyan
Write-Host ''
Write-Host '  1. 手机连上同一个 WiFi，用 Safari 打开：'
Write-Host "       http://$($ips[0]):5173/ca.cer" -ForegroundColor White
Write-Host '     （地址以启动服务器时打印的为准）'
Write-Host '  2. 会提示"已下载描述文件" → 打开 设置 → 通用 → VPN与设备管理 → 安装'
Write-Host '  3. 装完再去 设置 → 通用 → 关于本机 → 证书信任设置 → 打开 LifeBoard 那一项'
Write-Host '  4. 以后手机就用这个地址：'
Write-Host "       https://$($ips[0]):5174/" -ForegroundColor White
Write-Host ''
Write-Host '  这几步是为了让手机信任你自己的电脑。证书只在这台电脑上有效，'
Write-Host '  不会发给任何第三方。不想装了随时可以在手机上删掉。'
Write-Host ''
