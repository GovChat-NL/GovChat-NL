@echo off
setlocal
pushd "%~dp0.."
if /I "%~1"=="logs" goto logs

:status
cls
echo OpenBesluitvorming Limburg full ingestion - durable progress
echo This monitor never starts or changes ingestion.
echo Refreshes every 30 seconds. Press Ctrl+C to close the monitor.
echo.
docker inspect --format "Container: {{.State.Status}}  Exit: {{.State.ExitCode}}  Started: {{.State.StartedAt}}" govchat-obv-full-run
docker compose -f docker-compose.yml -f docker-compose.openbesluitvorming-local.yml --profile openbesluitvorming-ingest run --rm --no-deps openbesluitvorming-ingest status --run-id limburg-full-20261111
echo.
echo indexed = successful documents; retry/dead_letter = unresolved failures.
echo complete=true is required for corpus completion; container exit alone is not enough.
timeout /t 30 /nobreak >nul
goto status

:logs
docker logs --tail 50 --follow govchat-obv-full-run
popd
endlocal
