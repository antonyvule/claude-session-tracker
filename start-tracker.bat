@echo off
cd /d "%~dp0"

set LOGFILE=server.out.log
set MAXLOGBYTES=10485760

:loop
if exist "%LOGFILE%" (
  for %%A in ("%LOGFILE%") do if %%~zA GTR %MAXLOGBYTES% move /y "%LOGFILE%" "%LOGFILE%.old" >nul
)

for /f %%T in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do set START=%%T
node server.js >> "%LOGFILE%" 2>&1
for /f %%T in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do set END=%%T
set /a ELAPSED=%END%-%START%

if %ELAPSED% LSS 10 (
  echo [%date% %time%] server exited after ~%ELAPSED%s - backing off 30s>>"%LOGFILE%"
  timeout /t 30 /nobreak >nul
) else (
  timeout /t 5 /nobreak >nul
)
goto loop
