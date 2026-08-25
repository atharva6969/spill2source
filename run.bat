@echo off
rem SLICKTRACE - one-command start (backend + built dashboard on :8000)
cd /d "%~dp0"

if not exist frontend\dist (
  echo Building dashboard...
  pushd frontend
  call npm install
  call npm run build
  popd
)

echo Starting SLICKTRACE on http://localhost:8000
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
