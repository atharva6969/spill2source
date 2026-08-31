@echo off
rem SLICKTRACE - one-command start (backend + built dashboard on :8000)
cd /d "%~dp0"

rem Activate virtualenv if present
if exist .venv\Scripts\activate.bat call .venv\Scripts\activate.bat

rem Build frontend if needed
if not exist frontend\dist (
  echo Building dashboard...
  pushd frontend
  call npm install
  if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    exit /b %errorlevel%
  )
  call npm run build
  if %errorlevel% neq 0 (
    echo ERROR: npm run build failed
    exit /b %errorlevel%
  )
  popd
)

echo Starting SLICKTRACE on http://localhost:8000
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
