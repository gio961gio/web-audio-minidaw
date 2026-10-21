@echo off
cd /d "%~dp0"
echo Avvio del server locale per la Mini DAW...
start chrome -incognito http://localhost:5502/minidaw.html
python -m http.server 5502