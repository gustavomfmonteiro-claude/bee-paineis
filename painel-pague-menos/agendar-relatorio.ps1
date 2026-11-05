# Cria (ou refaz) a tarefa do Windows que gera o relatório executivo todo dia às 23:00.
# StartWhenAvailable: se o PC estiver desligado às 23:00, a tarefa roda assim que ele ligar.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $dir -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$node' '$dir\relatorio.mjs' *>> '$dir\relatorio.log'`""
$gatilho = New-ScheduledTaskTrigger -Daily -At '23:00'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Relatorio Executivo Pague Menos' -Action $acao -Trigger $gatilho -Settings $ajustes -Description 'Relatorio Executivo Operacional Pague Menos, todo dia as 23:00.' -Force | Out-Null
Get-ScheduledTask -TaskName 'Relatorio Executivo Pague Menos' | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
