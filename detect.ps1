$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cores = $cpu.NumberOfCores
$threads = $cpu.NumberOfLogicalProcessors
$cpuName = $cpu.Name.Trim()

$cs = Get-CimInstance Win32_ComputerSystem
$ramBytes = $cs.TotalPhysicalMemory
$ramGB = [int][math]::Floor($ramBytes / 1GB)

$gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Microsoft|Basic|Remote|Meta|Virtual|Generic|Parsec' }
$gpuName = ''
if ($gpus) { $gpuName = ($gpus | Select-Object -First 1).Name }

Write-Host "Detected CPU: $cpuName"
Write-Host "Cores: $cores  Threads(vCPU): $threads"
Write-Host "RAM: $ramGB GB"
if ($gpuName) { Write-Host "GPU: $gpuName" } else { Write-Host "GPU: none detected" }

$useGpu = $false
if ($gpuName) {
    $ans = Read-Host "Use GPU ($gpuName) for passthrough? (y/n)"
    if ($ans -match '^[yY]') { $useGpu = $true }
}

$spec = [ordered]@{
    cpuName = $cpuName
    maxVcpu = $threads
    maxRamGB = $ramGB
    gpuName = $gpuName
    gpuAvailable = $useGpu
}
$json = $spec | ConvertTo-Json -Compress
"window.HOST_SPECS = $json;" | Set-Content -Path (Join-Path $here 'specs.js') -Encoding UTF8

Write-Host ""
Write-Host "Wrote specs.js"
Write-Host "Open index.html in your browser."
