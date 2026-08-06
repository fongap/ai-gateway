@echo off
cd /d "%~dp0.."
set "GIT_EXE=C:\Program Files\Git\git-bash.exe"

if not exist ".git" (
    echo [Error] Cannot find .git folder!
    pause
    exit /b 1
)

"%GIT_EXE%" config core.hooksPath .githooks

echo Success! GitHub Desktop is now ready.
pause