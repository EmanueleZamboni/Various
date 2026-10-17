@echo off
rem Doppio clic: scarica tutti i reference con B-ROLL in "Desktop\D-Max Spot - Reference"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scarica_broll.ps1" %*
pause
