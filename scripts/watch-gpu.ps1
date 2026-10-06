# Memory investigation (JP, 2026-10-06): sample every 2 s what ComfyUI is running, GPU use and memory, how fast the
# ComfyUI process reads from disk and its RAM — to see where a slow LTX render spends its minutes.
#   powershell -File scripts\watch-gpu.ps1 <out.csv> <minutes>
param([string]$Out = 'tests\results\gpu-watch.csv', [int]$Minutes = 60)
# the launcher starts a child that does the work: the one that has read the most
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'main\.py' } | Sort-Object ReadTransferCount -Descending | Select-Object -First 1
if (-not $py) { throw 'ComfyUI (python main.py) not found' }
"time,running,gpu_util,vram_used_mb,disk_read_mb_s,ram_gb,sys_free_ram_gb" | Out-File -Encoding utf8 $Out
$end = (Get-Date).AddMinutes($Minutes)
$prev = [double]$py.ReadTransferCount
$prevT = Get-Date
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds 2
  try {
    $q = Invoke-RestMethod -Uri 'http://127.0.0.1:8188/queue' -TimeoutSec 3
    $running = if ($q.queue_running.Count) { ([string]$q.queue_running[0][1]).Substring(0, 8) } else { '' }
  } catch { $running = '?' }
  $g = (& nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits) -split ',\s*'
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($py.ProcessId)"
  $now = Get-Date
  $read = [double]$p.ReadTransferCount
  $mbs = [math]::Round(($read - $prev) / 1MB / ($now - $prevT).TotalSeconds, 1)
  $prev = $read; $prevT = $now
  $ram = [math]::Round($p.WorkingSetSize / 1GB, 1)
  $free = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
  $inv = [Globalization.CultureInfo]::InvariantCulture
  [string]::Format($inv, '{0},{1},{2},{3},{4},{5},{6}', $now.ToString('HH:mm:ss'), $running, $g[0], $g[1], $mbs, $ram, $free) | Out-File -Append -Encoding utf8 $Out
}
